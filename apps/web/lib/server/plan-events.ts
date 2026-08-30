import { mergeEventDelta, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { SessionPlanSchema, type SessionPlan } from "@forty-two/db";

const MAX_PLAN_EVENT_JSON_CHARS = 64_000;

export interface PlanSnapshot {
  plan: SessionPlan | null;
  revision: number;
  updatedAt: string | null;
}

export type PlanToolArguments =
  | {
      sessionId?: unknown;
      action: "set";
      title?: unknown;
      items?: unknown;
    }
  | {
      sessionId?: unknown;
      action: "update_item";
      itemIndex?: unknown;
      status?: unknown;
      summary?: unknown;
    };

export type PlanEvent =
  | {
      type: "plan.optimistic";
      toolCallId: string;
      arguments: PlanToolArguments;
    }
  | { type: "plan.reconciled"; toolCallId: string; snapshot: PlanSnapshot }
  | { type: "plan.failed"; toolCallId: string; message: string };

export type PlanEventSource =
  TrueForgeApi.SessionEvent | TrueForgeApi.TurnStreamingEvent;

export interface PlanEventState {
  pending: Map<string, PlanToolArguments>;
  streamingMessages: Map<string, TrueForgeApi.ModelMessageEvent>;
}

export function createPlanEventState(): PlanEventState {
  return { pending: new Map(), streamingMessages: new Map() };
}

export function normalizePlanEvent(
  event: PlanEventSource,
  state: PlanEventState,
): PlanEvent[] {
  if (event.type === "model.message") {
    const message = structuredClone(event);
    state.streamingMessages.set(message.id, message);
    return normalizePlanCalls(message, state.pending);
  }

  if (event.type === "model.message.delta") {
    const message = state.streamingMessages.get(event.id);
    if (!message) return [];
    mergeEventDelta(message, event);
    return normalizePlanCalls(message, state.pending);
  }

  if (event.type === "tool.response") {
    if (!state.pending.has(event.toolCallId)) return [];
    state.pending.delete(event.toolCallId);
    const snapshot = parseToolSnapshot(event.content);
    return snapshot
      ? [
          {
            type: "plan.reconciled",
            toolCallId: event.toolCallId,
            snapshot,
          },
        ]
      : [
          {
            type: "plan.failed",
            toolCallId: event.toolCallId,
            message: "The plan tool did not return canonical state.",
          },
        ];
  }

  if (event.type === "tool.approval_required") {
    return event.toolCalls.flatMap(({ id: toolCallId }) =>
      state.pending.has(toolCallId)
        ? [
            {
              type: "plan.failed" as const,
              toolCallId,
              message: "The plan tool unexpectedly required approval.",
            },
          ]
        : [],
    );
  }
  return [];
}

function normalizePlanCalls(
  event: TrueForgeApi.ModelMessageEvent,
  pending: Map<string, PlanToolArguments>,
): PlanEvent[] {
  const normalized: PlanEvent[] = [];
  for (const call of event.toolCalls ?? []) {
    if (pending.has(call.id)) continue;
    const args = planArguments(call);
    if (!args) continue;
    pending.set(call.id, args);
    normalized.push({
      type: "plan.optimistic",
      toolCallId: call.id,
      arguments: args,
    });
  }
  return normalized;
}

function planArguments(
  call: TrueForgeApi.ToolCall,
): PlanToolArguments | undefined {
  const parsed = parseJson(call.function.arguments);
  if (
    call.toolInfo.type === "mcp" &&
    call.toolInfo.serverName === "forty-two-todo" &&
    call.toolInfo.name === "plan"
  ) {
    return parsePlanArguments(parsed);
  }
  if (
    call.toolInfo.type !== "truefoundry-system" ||
    call.toolInfo.name !== "call_tool" ||
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 3 ||
    Object.keys(parsed).some(
      (key) => !["mcp_server", "tool_name", "input"].includes(key),
    ) ||
    parsed.mcp_server !== "forty-two-todo" ||
    parsed.tool_name !== "plan"
  ) {
    return undefined;
  }
  return parsePlanArguments(parsed.input);
}

export function normalizePlanHistory(
  items: readonly TrueForgeApi.SessionEventItem[],
): PlanEvent[] {
  const state = createPlanEventState();
  return [...items]
    .sort((left, right) =>
      left.event.createdAt === right.event.createdAt
        ? left.event.id.localeCompare(right.event.id)
        : left.event.createdAt.localeCompare(right.event.createdAt),
    )
    .flatMap(({ event }) => normalizePlanEvent(event, state));
}

function parsePlanArguments(parsed: unknown): PlanToolArguments | undefined {
  if (!isRecord(parsed)) return undefined;
  if (parsed.action !== "set" && parsed.action !== "update_item") {
    return undefined;
  }
  return parsed as PlanToolArguments;
}

function parseToolSnapshot(content: string): PlanSnapshot | undefined {
  let value = parseJson(content);
  if (
    isRecord(value) &&
    Array.isArray(value.content) &&
    isRecord(value.content[0]) &&
    typeof value.content[0].text === "string"
  ) {
    value = parseJson(value.content[0].text);
  }
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    (value.updatedAt !== null &&
      (typeof value.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(value.updatedAt))))
  ) {
    return undefined;
  }
  const plan =
    value.plan === null
      ? { success: true as const, data: null }
      : SessionPlanSchema.safeParse(value.plan);
  if (!plan.success) return undefined;
  return {
    plan: plan.data,
    revision: Number(value.revision),
    updatedAt: value.updatedAt,
  };
}

function parseJson(value: string): unknown {
  if (value.length > MAX_PLAN_EVENT_JSON_CHARS) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
