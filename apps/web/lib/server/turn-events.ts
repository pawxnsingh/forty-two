import { mergeEventDelta, type TrueForgeApi } from "@truefoundry/trueforge-sdk";

import {
  createPlanEventState,
  normalizePlanEvent,
  type PlanEvent,
  type PlanSnapshot,
  type PlanToolArguments,
} from "./plan-events";

const MAX_ASSISTANT_CHARS = 64_000;
const MAX_EVENT_TEXT_CHARS = 16_000;
const MAX_METADATA_CHARS = 120;
const MAX_PLAN_TEXT_CHARS = 1_000;
const MAX_PLAN_ITEMS = 15;
const MAX_APPROVAL_CALLS = 32;
const MAX_TOOL_ENVELOPE_CHARS = 64_000;
const MAX_TOOL_SUMMARY_CHARS = 160;
const SAFE_UNKNOWN_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const SHARED_DATA_SOURCE_MCP_NAME = "forty-two-data-source";
const ARTIFACT_ID_PATTERN = /^art_[0-9A-HJKMNP-TV-Z]{26}$/;
const ARTIFACT_TOOL_NAMES = new Set([
  "create_query_table_artifact",
  "finalize_chart_artifact",
  "finalize_table_artifact",
]);

export interface SafeToolMetadata {
  kind: "mcp" | "system";
  name: string;
  serverName?: string;
}

export type NormalizedTurnEvent =
  | {
      type: "assistant.message.started";
      messageId: string;
      threadId: string;
      createdAt: string | null;
    }
  | {
      type: "assistant.message.delta";
      messageId: string;
      threadId: string;
      text: string;
    }
  | {
      type: "assistant.message.completed";
      messageId: string;
      threadId: string;
      finishReason: string | null;
      truncated: boolean;
    }
  | {
      type: "tool.started";
      toolCallId: string;
      sourceMessageId: string;
      threadId: string;
      tool: SafeToolMetadata;
    }
  | {
      type: "tool.completed";
      toolCallId: string;
      threadId: string;
      tool: SafeToolMetadata | null;
      outcome: "success" | "error";
      summary: string;
    }
  | {
      type: "approval.required";
      sourceEventId: string;
      threadId: string;
      toolCalls: Array<{
        toolCallId: string;
        sourceMessageId: string;
        tool: SafeToolMetadata | null;
      }>;
      truncated: boolean;
    }
  | {
      type: "artifact.created";
      toolCallId: string;
      artifact: {
        id: string;
        kind: "chart" | "table";
        schemaVersion: "chart.v1" | "table.v1";
        rowCount?: number;
        sourceArtifactId?: string;
      };
    }
  | {
      type: "turn.completed";
      sourceEventId: string;
      completedAt: string;
    }
  | {
      type: "turn.failed";
      sourceEventId: string;
      completedAt: string;
      reason: "cancelled" | "error";
      message: string;
    }
  | PlanEvent;

interface MessageState {
  event: TrueForgeApi.ModelMessageEvent;
  emittedChars: number;
  completed: boolean;
  truncated: boolean;
}

interface ToolState {
  sourceMessageId: string;
  threadId: string;
  metadata: SafeToolMetadata;
  artifactSource: boolean;
}

export interface NormalizedTurnHistoryPayload {
  data: NormalizedTurnEvent[];
  normalizedEvents: NormalizedTurnEvent[];
  planEvents: PlanEvent[];
}

export interface TurnEventState {
  messages: Map<string, MessageState>;
  startedTools: Set<string>;
  tools: Map<string, ToolState>;
  plan: ReturnType<typeof createPlanEventState>;
}

export function createTurnEventState(): TurnEventState {
  return {
    messages: new Map(),
    startedTools: new Set(),
    tools: new Map(),
    plan: createPlanEventState(),
  };
}

export function normalizeTurnEvent(
  event: TrueForgeApi.SessionEvent | TrueForgeApi.TurnStreamingEvent,
  state: TurnEventState,
): NormalizedTurnEvent[] {
  if (event.type === "model.message") {
    return normalizeMessageStart(event, state);
  }
  if (event.type === "model.message.delta") {
    return normalizeMessageDelta(event, state);
  }
  if (event.type === "tool.response") {
    return normalizeToolResponse(event, state);
  }
  if (event.type === "tool.approval_required") {
    return [normalizeApproval(event, state), ...safePlanEvents(event, state)];
  }
  if (event.type === "turn.done") {
    return normalizeTurnDone(event, state);
  }
  return safePlanEvents(event, state);
}

export function normalizeTurnHistory(
  items: readonly TrueForgeApi.SessionEventItem[],
): NormalizedTurnEvent[] {
  const state = createTurnEventState();
  return [...items]
    .map((item, inputIndex) => ({ item, inputIndex }))
    .sort(
      (left, right) =>
        left.item.event.createdAt.localeCompare(right.item.event.createdAt) ||
        left.inputIndex - right.inputIndex,
    )
    .flatMap(({ item }) => normalizeTurnEvent(item.event, state));
}

export function normalizedTurnHistoryPayload(
  items: readonly TrueForgeApi.SessionEventItem[],
): NormalizedTurnHistoryPayload {
  const normalizedEvents = normalizeTurnHistory(items);
  return {
    data: normalizedEvents,
    normalizedEvents,
    planEvents: normalizedEvents.filter(isPlanEvent),
  };
}

function normalizeMessageStart(
  event: TrueForgeApi.ModelMessageEvent,
  state: TurnEventState,
): NormalizedTurnEvent[] {
  const message: MessageState = {
    event: structuredClone(event),
    emittedChars: 0,
    completed: false,
    truncated: false,
  };
  state.messages.set(event.id, message);
  const normalized: NormalizedTurnEvent[] = [
    {
      type: "assistant.message.started",
      messageId: safeId(event.id),
      threadId: safeMetadata(event.threadId),
      createdAt: safeTimestamp(event.createdAt),
    },
  ];
  appendAssistantText(normalized, message, messageText(event.content));
  normalized.push(...normalizeToolStarts(message.event, state));
  normalized.push(...safePlanEvents(event, state));
  if (event.finishReason != null) {
    normalized.push(completeMessage(message));
  }
  return normalized;
}

function normalizeMessageDelta(
  event: TrueForgeApi.ModelMessageDeltaEvent,
  state: TurnEventState,
): NormalizedTurnEvent[] {
  const message = state.messages.get(event.id);
  const normalized: NormalizedTurnEvent[] = [];
  if (message) {
    appendAssistantText(normalized, message, event.content ?? "");
    mergeEventDelta(message.event, event);
    normalized.push(...normalizeToolStarts(message.event, state));
  } else if (event.content) {
    // A reconnect can begin after the model.message base event when the live
    // buffer no longer contains it. Deltas remain useful and contain no hidden
    // reasoning; the persisted history endpoint is the authoritative fallback.
    const text = safeText(event.content, MAX_EVENT_TEXT_CHARS);
    if (text) {
      normalized.push({
        type: "assistant.message.delta",
        messageId: safeId(event.id),
        threadId: safeMetadata(event.threadId),
        text,
      });
    }
  }
  normalized.push(...safePlanEvents(event, state));
  if (message && event.finishReason != null && !message.completed) {
    normalized.push(completeMessage(message));
  }
  return normalized;
}

function appendAssistantText(
  normalized: NormalizedTurnEvent[],
  message: MessageState,
  value: string,
): void {
  if (!value) return;
  const remaining = MAX_ASSISTANT_CHARS - message.emittedChars;
  if (remaining <= 0) {
    message.truncated = true;
    return;
  }
  const text = safeText(value, Math.min(remaining, MAX_EVENT_TEXT_CHARS));
  if (!text) return;
  message.emittedChars += text.length;
  if (text.length < value.length || value.length > MAX_EVENT_TEXT_CHARS) {
    message.truncated = true;
  }
  normalized.push({
    type: "assistant.message.delta",
    messageId: safeId(message.event.id),
    threadId: safeMetadata(message.event.threadId),
    text,
  });
}

function completeMessage(
  message: MessageState,
): Extract<NormalizedTurnEvent, { type: "assistant.message.completed" }> {
  message.completed = true;
  return {
    type: "assistant.message.completed",
    messageId: safeId(message.event.id),
    threadId: safeMetadata(message.event.threadId),
    finishReason:
      message.event.finishReason == null
        ? null
        : safeMetadata(String(message.event.finishReason)),
    truncated: message.truncated,
  };
}

function normalizeToolStarts(
  message: TrueForgeApi.ModelMessageEvent,
  state: TurnEventState,
): NormalizedTurnEvent[] {
  const normalized: NormalizedTurnEvent[] = [];
  for (const call of message.toolCalls ?? []) {
    if (!call.id) continue;
    const descriptor = toolDescriptor(call);
    if (!descriptor) continue;
    state.tools.set(call.id, {
      sourceMessageId: message.id,
      threadId: safeMetadata(message.threadId),
      metadata: descriptor.metadata,
      artifactSource: descriptor.artifactSource,
    });
    if (state.startedTools.has(call.id)) continue;
    state.startedTools.add(call.id);
    normalized.push({
      type: "tool.started",
      toolCallId: safeId(call.id),
      sourceMessageId: safeId(message.id),
      threadId: safeMetadata(message.threadId),
      tool: descriptor.metadata,
    });
  }
  return normalized;
}

function normalizeToolResponse(
  event: TrueForgeApi.ToolResponseEvent,
  state: TurnEventState,
): NormalizedTurnEvent[] {
  const tool = state.tools.get(event.toolCallId);
  const result = safeToolResult(event.content, tool);
  const normalized: NormalizedTurnEvent[] = [
    {
      type: "tool.completed",
      toolCallId: safeId(event.toolCallId),
      threadId: safeMetadata(event.threadId),
      tool: tool?.metadata ?? null,
      outcome: result.outcome,
      summary: result.summary,
    },
  ];
  const artifact = artifactReceipt(event.content, tool);
  if (artifact) {
    normalized.push({
      type: "artifact.created",
      toolCallId: safeId(event.toolCallId),
      artifact,
    });
  }
  normalized.push(...safePlanEvents(event, state));
  return normalized;
}

function safeToolResult(
  content: string,
  tool: ToolState | undefined,
): { outcome: "success" | "error"; summary: string } {
  if (content.length > MAX_TOOL_ENVELOPE_CHARS) {
    return topLevelBooleanField(content, "isError")
      ? { outcome: "error", summary: "Did not complete" }
      : { outcome: "success", summary: "Completed" };
  }

  const envelope = parseJson(content);
  const failed = isRecord(envelope) && envelope.isError === true;
  if (failed) return { outcome: "error", summary: "Did not complete" };
  if (
    tool?.metadata.kind === "system" &&
    /exec|code|python|sandbox|shell/i.test(tool.metadata.name)
  ) {
    return { outcome: "success", summary: "Sandbox task completed" };
  }
  if (
    tool?.metadata.kind !== "mcp" ||
    tool.metadata.serverName !== SHARED_DATA_SOURCE_MCP_NAME
  ) {
    return { outcome: "success", summary: "Completed" };
  }

  const value = structuredToolResult(envelope);
  const name = tool.metadata.name;
  let summary = "Completed";

  if (name === "list_data_sources") {
    summary = countSummary(value, "dataSources", "data source");
  } else if (name === "test_data_source") {
    summary =
      value.connected === true
        ? "Connection verified"
        : "Connection unavailable";
  } else if (name === "list_databases") {
    summary = countSummary(value, "databases", "database");
  } else if (name === "list_schemas") {
    summary = countSummary(value, "schemas", "schema");
  } else if (name === "list_tables") {
    summary = countSummary(value, "tables", "table");
  } else if (name === "describe_table") {
    summary = countSummary(value, "columns", "column");
  } else if (name === "run_read_query") {
    const count = Array.isArray(value.rows) ? value.rows.length : null;
    summary =
      count === null
        ? "Query completed"
        : pluralCount("Returned", count, "row");
    if (isRecord(value.metadata) && value.metadata.limited === true) {
      summary += " · row limit reached";
    }
  } else if (name === "create_query_table_artifact") {
    summary = Number.isSafeInteger(value.storedRowCount)
      ? pluralCount("Stored", Number(value.storedRowCount), "row")
      : "Table created";
  } else if (name === "finalize_table_artifact") {
    summary = "Table created";
  } else if (name === "finalize_chart_artifact") {
    summary = "Chart created";
  } else if (name === "get_file_download_url") {
    summary = "File access prepared";
  } else if (name === "prepare_sql_change") {
    summary = "Change preview prepared";
  } else if (name === "apply_sql_change") {
    summary = "Approved change applied";
  }

  return {
    outcome: "success",
    summary: safeText(summary, MAX_TOOL_SUMMARY_CHARS),
  };
}

function topLevelBooleanField(source: string, field: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character !== '"') continue;
      inString = false;
      if (depth !== 1 || source.slice(stringStart, index) !== field) continue;
      let cursor = index + 1;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      if (source[cursor] !== ":") continue;
      cursor += 1;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      return source.startsWith("true", cursor);
    }
    if (character === '"') {
      inString = true;
      stringStart = index + 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
  return false;
}

function structuredToolResult(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (isRecord(parsed) && isRecord(parsed.structuredContent)) {
    parsed = parsed.structuredContent;
  }
  if (
    isRecord(parsed) &&
    Array.isArray(parsed.content) &&
    isRecord(parsed.content[0]) &&
    typeof parsed.content[0].text === "string"
  ) {
    const nested = parseJson(parsed.content[0].text);
    if (isRecord(nested)) parsed = nested;
  }
  return isRecord(parsed) ? parsed : {};
}

function countSummary(
  value: Record<string, unknown>,
  key: string,
  noun: string,
): string {
  const count = Array.isArray(value[key]) ? value[key].length : null;
  if (count === null) return "Completed";
  const summary = pluralCount("Found", count, noun);
  return value.truncated === true ? `${summary} · more available` : summary;
}

function pluralCount(prefix: string, count: number, noun: string): string {
  return `${prefix} ${count} ${noun}${count === 1 ? "" : "s"}`;
}

function normalizeApproval(
  event: TrueForgeApi.ToolApprovalRequiredEvent,
  state: TurnEventState,
): Extract<NormalizedTurnEvent, { type: "approval.required" }> {
  const calls = event.toolCalls.slice(0, MAX_APPROVAL_CALLS).map((call) => {
    const tool = state.tools.get(call.id);
    return {
      toolCallId: safeId(call.id),
      sourceMessageId: safeId(call.sourceEventId),
      tool: tool?.metadata ?? null,
    };
  });
  return {
    type: "approval.required",
    sourceEventId: safeId(event.id),
    threadId: safeMetadata(event.threadId),
    toolCalls: calls,
    truncated: event.toolCalls.length > calls.length,
  };
}

function normalizeTurnDone(
  event: TrueForgeApi.TurnDoneEvent,
  state: TurnEventState,
): NormalizedTurnEvent[] {
  const normalized: NormalizedTurnEvent[] = [];
  for (const message of state.messages.values()) {
    if (!message.completed) normalized.push(completeMessage(message));
  }
  if (event.state.status === "done") {
    normalized.push({
      type: "turn.completed",
      sourceEventId: safeId(event.id),
      completedAt: terminalTimestamp(event),
    });
  } else if (event.state.status === "error") {
    normalized.push({
      type: "turn.failed",
      sourceEventId: safeId(event.id),
      completedAt: terminalTimestamp(event),
      reason: "error",
      message: safeText(event.state.message, MAX_PLAN_TEXT_CHARS),
    });
  } else {
    normalized.push({
      type: "turn.failed",
      sourceEventId: safeId(event.id),
      completedAt: terminalTimestamp(event),
      reason: "cancelled",
      message: "The turn was cancelled.",
    });
  }
  return normalized;
}

function safePlanEvents(
  event: TrueForgeApi.SessionEvent | TrueForgeApi.TurnStreamingEvent,
  state: TurnEventState,
): PlanEvent[] {
  return normalizePlanEvent(event, state.plan).map(safePlanEvent);
}

function safePlanEvent(event: PlanEvent): PlanEvent {
  if (event.type === "plan.optimistic") {
    return {
      type: event.type,
      toolCallId: safeMetadata(event.toolCallId),
      arguments: safePlanArguments(event.arguments),
    };
  }
  if (event.type === "plan.reconciled") {
    return {
      type: event.type,
      toolCallId: safeMetadata(event.toolCallId),
      snapshot: safePlanSnapshot(event.snapshot),
    };
  }
  return {
    type: event.type,
    toolCallId: safeMetadata(event.toolCallId),
    message: safeText(event.message, MAX_PLAN_TEXT_CHARS),
  };
}

function safePlanArguments(value: PlanToolArguments): PlanToolArguments {
  if (value.action === "set") {
    return {
      action: "set",
      ...(typeof value.sessionId === "string"
        ? { sessionId: safeMetadata(value.sessionId) }
        : {}),
      ...(typeof value.title === "string"
        ? { title: safeText(value.title, MAX_PLAN_TEXT_CHARS) }
        : {}),
      ...(Array.isArray(value.items)
        ? { items: safePlanArgumentItems(value.items) }
        : {}),
    };
  }
  return {
    action: "update_item",
    ...(typeof value.sessionId === "string"
      ? { sessionId: safeMetadata(value.sessionId) }
      : {}),
    ...(Number.isInteger(value.itemIndex)
      ? {
          itemIndex: Math.max(
            0,
            Math.min(MAX_PLAN_ITEMS - 1, Number(value.itemIndex)),
          ),
        }
      : {}),
    ...(typeof value.status === "string"
      ? { status: safeMetadata(value.status) }
      : {}),
    ...(typeof value.summary === "string"
      ? { summary: safeText(value.summary, MAX_PLAN_TEXT_CHARS) }
      : {}),
  };
}

function safePlanSnapshot(snapshot: PlanSnapshot): PlanSnapshot {
  return {
    plan:
      snapshot.plan === null
        ? null
        : {
            title: safeText(snapshot.plan.title, MAX_PLAN_TEXT_CHARS),
            items: snapshot.plan.items.slice(0, MAX_PLAN_ITEMS).map((item) => ({
              text: safeText(item.text, MAX_PLAN_TEXT_CHARS),
              status: item.status,
              ...(item.summary
                ? { summary: safeText(item.summary, MAX_PLAN_TEXT_CHARS) }
                : {}),
            })),
          },
    revision: Math.max(0, snapshot.revision),
    updatedAt: safeTimestamp(snapshot.updatedAt),
  };
}

function safePlanArgumentItems(
  value: unknown[],
): Array<Record<string, unknown>> {
  return value.slice(0, MAX_PLAN_ITEMS).flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== "string") return [];
    return [
      {
        text: safeText(item.text, MAX_PLAN_TEXT_CHARS),
        ...(typeof item.status === "string"
          ? { status: safeMetadata(item.status) }
          : {}),
        ...(typeof item.summary === "string"
          ? { summary: safeText(item.summary, MAX_PLAN_TEXT_CHARS) }
          : {}),
      },
    ];
  });
}

function toolDescriptor(
  call: TrueForgeApi.ToolCall,
): { metadata: SafeToolMetadata; artifactSource: boolean } | undefined {
  if (!call.toolInfo || !call.function?.name) return undefined;
  if (call.toolInfo.type === "mcp") {
    return {
      metadata: {
        kind: "mcp",
        name: safeMetadata(call.toolInfo.name || call.function.name),
        serverName: safeMetadata(call.toolInfo.serverName),
      },
      artifactSource:
        call.toolInfo.serverName === SHARED_DATA_SOURCE_MCP_NAME &&
        call.toolInfo.name === call.function.name &&
        ARTIFACT_TOOL_NAMES.has(call.toolInfo.name),
    };
  }
  const wrapped =
    call.toolInfo.name === "call_tool" && call.function.name === "call_tool"
      ? wrappedToolIdentity(call.function.arguments)
      : undefined;
  return wrapped
    ? {
        metadata: {
          kind: "mcp",
          name: safeMetadata(wrapped.name),
          serverName: safeMetadata(wrapped.serverName),
        },
        artifactSource:
          wrapped.serverName === SHARED_DATA_SOURCE_MCP_NAME &&
          ARTIFACT_TOOL_NAMES.has(wrapped.name),
      }
    : {
        metadata: { kind: "system", name: safeMetadata(call.toolInfo.name) },
        artifactSource: false,
      };
}

function wrappedToolIdentity(
  value: string,
): { name: string; serverName: string } | undefined {
  if (value.length > MAX_TOOL_ENVELOPE_CHARS) return undefined;
  const parsed = parseJson(value);
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 3 ||
    Object.keys(parsed).some(
      (key) => !["input", "mcp_server", "tool_name"].includes(key),
    ) ||
    typeof parsed.mcp_server !== "string" ||
    typeof parsed.tool_name !== "string"
  ) {
    return undefined;
  }
  return {
    name: parsed.tool_name,
    serverName: parsed.mcp_server,
  };
}

function artifactReceipt(
  content: string,
  tool: ToolState | undefined,
):
  | Extract<NormalizedTurnEvent, { type: "artifact.created" }>["artifact"]
  | null {
  if (!tool?.artifactSource) return null;
  if (content.length > MAX_TOOL_ENVELOPE_CHARS) return null;
  let parsed = parseJson(content);
  if (isRecord(parsed) && isRecord(parsed.structuredContent)) {
    parsed = parsed.structuredContent;
  }
  if (
    isRecord(parsed) &&
    Array.isArray(parsed.content) &&
    isRecord(parsed.content[0]) &&
    typeof parsed.content[0].text === "string"
  ) {
    parsed = parseJson(parsed.content[0].text);
  }
  if (isRecord(parsed) && isRecord(parsed.artifact)) parsed = parsed.artifact;
  if (
    !isRecord(parsed) ||
    !ARTIFACT_ID_PATTERN.test(String(parsed.artifactId))
  ) {
    return null;
  }
  if (parsed.schemaVersion === "table.v1") {
    return {
      id: String(parsed.artifactId),
      kind: "table",
      schemaVersion: "table.v1",
      ...(Number.isSafeInteger(parsed.rowCount) && Number(parsed.rowCount) >= 0
        ? { rowCount: Number(parsed.rowCount) }
        : {}),
    };
  }
  if (parsed.schemaVersion === "chart.v1") {
    return {
      id: String(parsed.artifactId),
      kind: "chart",
      schemaVersion: "chart.v1",
      ...(ARTIFACT_ID_PATTERN.test(String(parsed.sourceArtifactId))
        ? { sourceArtifactId: String(parsed.sourceArtifactId) }
        : {}),
    };
  }
  return null;
}

function messageText(
  content: TrueForgeApi.ModelMessageEventContent | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

export function safeText(value: string, maximum: number): string {
  const boundedInput = value.slice(0, Math.max(maximum * 4, maximum));
  const redacted = boundedInput
    .replace(
      /\b(?:postgres(?:ql)?|mysql|sqlserver):\/\/([^\s:/@]+):([^\s@]+)@/gi,
      (_match, user: string) => `database://${user}:[redacted]@`,
    )
    .replace(
      /(["']?)([A-Z][A-Z0-9_]*(?:_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)|_CONNECTION_STRING))\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,}\]]*)/gi,
      "$1$2$1=[redacted]",
    )
    .replace(
      /\b(Basic|Bearer)\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi,
      "$1 [redacted]",
    )
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/gi, "[redacted-api-key]")
    .replace(
      /(["']?(?:password|passwd|secret|token|api[_ -]?key|account[_ -]?key|authorization)["']?\s*[:=]\s*)(?!\[redacted\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}\]]*)/gi,
      "$1[redacted]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
      isSignedUrl(url) ? "[redacted-signed-url]" : url,
    );
  if (redacted.length <= maximum && boundedInput.length === value.length) {
    return redacted;
  }
  return redacted.slice(0, Math.max(0, maximum - 1)) + "…";
}

function isSignedUrl(value: string): boolean {
  try {
    const url = new URL(value.replace(/[),.;]+$/, ""));
    const keys = new Set(
      [...url.searchParams.keys()].map((key) => key.toLowerCase()),
    );
    return (
      keys.has("sig") ||
      (keys.has("sv") && (keys.has("se") || keys.has("sp") || keys.has("sr")))
    );
  } catch {
    return false;
  }
}

function safeMetadata(value: string): string {
  return safeText(value, MAX_METADATA_CHARS);
}

function safeId(value: string): string {
  return safeText(value, MAX_METADATA_CHARS);
}

function safeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function terminalTimestamp(event: TrueForgeApi.TurnDoneEvent): string {
  return (
    safeTimestamp(event.state.completedAt) ??
    safeTimestamp(event.createdAt) ??
    SAFE_UNKNOWN_TIMESTAMP
  );
}

function isPlanEvent(event: NormalizedTurnEvent): event is PlanEvent {
  return event.type.startsWith("plan.");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
