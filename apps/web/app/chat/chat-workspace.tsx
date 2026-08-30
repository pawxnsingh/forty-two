"use client";

import ChartCard from "@repo/charting/card";
import { Button } from "@repo/ui-web";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Copy,
  Database,
  LoaderCircle,
  ShieldCheck,
  Table2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import styles from "./chat.module.css";
import { ChatComposer } from "./chat-composer";
import { ChatTranscript } from "./chat-transcript";
import {
  collectCursorPages,
  resolvedApproval,
  retryableApproval,
  sourceScopeLabel,
  submittingApproval,
  type ApprovalState,
} from "./chat-ui-state";
import { ExecutionChain } from "./execution-chain";
import { MarkdownView } from "./markdown-view";
import { PinnedPlan } from "./pinned-plan";
import { reconcileStreamError } from "./turn-stream-lifecycle";

type SourceStatus = "awaiting_upload" | "testing" | "ready" | "failed";

interface DataSource {
  id: string;
  name: string;
  connectorType: string;
  status: SourceStatus;
}

interface TurnInput {
  type: string;
  content?: unknown;
}

interface ApiTurn {
  id: string;
  createdAt: string;
  input?: TurnInput[];
  state: { status: string };
}

interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  summary?: string;
}

interface Plan {
  title: string;
  items: PlanItem[];
}

type NormalizedEvent =
  | { type: "assistant.message.started"; messageId: string }
  | { type: "assistant.message.delta"; messageId: string; text: string }
  | {
      type: "assistant.message.completed";
      messageId: string;
      finishReason: string | null;
      truncated: boolean;
    }
  | {
      type: "tool.started";
      toolCallId: string;
      tool: {
        kind: "mcp" | "system";
        name: string;
        serverName?: string;
      };
    }
  | {
      type: "tool.completed";
      toolCallId: string;
      outcome: "success" | "error";
      summary: string;
    }
  | {
      type: "approval.required";
      toolCalls: Array<{ toolCallId: string; tool: { name: string } | null }>;
    }
  | {
      type: "artifact.created";
      artifact: {
        id: string;
        kind: "chart" | "table";
        rowCount?: number;
        sourceArtifactId?: string;
      };
    }
  | { type: "turn.completed" }
  | { type: "turn.failed"; reason: string; message: string }
  | { type: "plan.optimistic" }
  | { type: "plan.reconciled"; snapshot: { plan: Plan | null } }
  | { type: "plan.failed"; message: string };

interface ConversationTurn {
  id: string;
  userMessage: string | null;
  events: NormalizedEvent[];
  running: boolean;
}

interface ArtifactEnvelope {
  id: string;
  kind?: "chart" | "table";
  schemaVersion: "chart.v1" | "table.v1";
  title: string | null;
  description: string | null;
  config?: Record<string, unknown>;
  data?: Record<string, unknown>[];
  columns?: Array<{
    name: string;
    type:
      | "string"
      | "number"
      | "integer"
      | "decimal"
      | "boolean"
      | "datetime"
      | "json";
  }>;
  preview?: Record<string, unknown>[];
  rowCount: number;
}

const terminalStates = new Set(["done", "error", "cancelled", "canceled"]);
const streamCategories = [
  "assistant",
  "tool",
  "approval",
  "plan",
  "artifact",
  "turn",
];

const starterPrompts = [
  "Show me the most important trends",
  "Compare performance over time",
  "Find unusual changes in the data",
] as const;

async function apiMessage(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return payload?.error?.message ?? fallback;
}

function userMessage(turn: ApiTurn): string | null {
  const input = turn.input?.find((item) => item.type === "user.message");
  if (typeof input?.content === "string") return input.content;
  if (Array.isArray(input?.content)) {
    return input.content
      .map((item) =>
        typeof item === "object" && item && "text" in item
          ? String((item as { text: unknown }).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return null;
}

function assistantText(events: NormalizedEvent[]) {
  const answerMessageId = completedAnswerMessageId(events);
  if (!answerMessageId) return "";
  const deltas = events.filter(
    (
      event,
    ): event is Extract<NormalizedEvent, { type: "assistant.message.delta" }> =>
      event.type === "assistant.message.delta",
  );
  return deltas
    .filter((event) => event.messageId === answerMessageId)
    .map((event) => event.text)
    .join("");
}

function completedAnswerMessageId(events: NormalizedEvent[]) {
  return events
    .filter(
      (
        event,
      ): event is Extract<
        NormalizedEvent,
        { type: "assistant.message.completed" }
      > =>
        event.type === "assistant.message.completed" &&
        event.finishReason !== "tool_calls",
    )
    .at(-1)?.messageId;
}

function executionActivities(events: NormalizedEvent[]) {
  const answerMessageId = completedAnswerMessageId(events);
  const activities: Array<{
    completed: boolean;
    failed?: boolean;
    id: string;
    kind: "mcp" | "reasoning" | "system";
    name: string;
    serverName?: string;
    summary?: string;
  }> = [];
  const byId = new Map<string, number>();

  for (const event of events) {
    if (
      event.type === "assistant.message.delta" &&
      event.messageId !== answerMessageId
    ) {
      const existingIndex = byId.get(`reasoning:${event.messageId}`);
      if (existingIndex === undefined) {
        byId.set(`reasoning:${event.messageId}`, activities.length);
        activities.push({
          completed: false,
          id: `reasoning:${event.messageId}`,
          kind: "reasoning",
          name: "reasoning",
          summary: event.text,
        });
      } else {
        const current = activities[existingIndex]!;
        current.summary = `${current.summary ?? ""}${event.text}`;
      }
      continue;
    }
    if (event.type === "assistant.message.completed") {
      const index = byId.get(`reasoning:${event.messageId}`);
      if (index !== undefined) activities[index]!.completed = true;
      continue;
    }
    if (event.type === "tool.started") {
      byId.set(event.toolCallId, activities.length);
      activities.push({
        completed: false,
        id: event.toolCallId,
        kind: event.tool.kind,
        name: event.tool.name,
        serverName: event.tool.serverName,
      });
      continue;
    }
    if (event.type === "tool.completed") {
      const index = byId.get(event.toolCallId);
      if (index === undefined) continue;
      activities[index] = {
        ...activities[index]!,
        completed: true,
        failed: event.outcome === "error",
        summary: event.summary,
      };
    }
  }

  return activities.filter((activity) => {
    if (activity.kind !== "reasoning") return true;
    const text = activity.summary?.trim() ?? "";
    return (
      text.length > 0 &&
      !/output\s*schema|does not define an output/i.test(text)
    );
  });
}

function chartColumnMetadata(artifact: ArtifactEnvelope) {
  return (artifact.columns ?? []).map((column) => {
    const values = (artifact.data ?? [])
      .map((row) => row[column.name])
      .filter((value) => value !== null && value !== undefined);
    const simpleType =
      column.type === "number" ||
      column.type === "integer" ||
      column.type === "decimal"
        ? "number"
        : column.type === "datetime"
          ? "date"
          : "text";
    const comparable = values.filter(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    );
    const ordered = [...comparable].sort((left, right) =>
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right)),
    );
    const rendererType = {
      boolean: "boolean",
      datetime: "timestamp",
      decimal: "decimal",
      integer: "integer",
      json: "json",
      number: "float",
      string: "text",
    }[column.type] as
      | "boolean"
      | "timestamp"
      | "decimal"
      | "integer"
      | "json"
      | "float"
      | "text";
    return {
      name: column.name,
      min_value: ordered[0] ?? "",
      max_value: ordered.at(-1) ?? "",
      unique_values: new Set(values.map((value) => JSON.stringify(value))).size,
      simple_type: simpleType,
      type: rendererType,
    };
  });
}

function assistantPresentationText(
  text: string,
  hiddenTableArtifactIds: ReadonlySet<string>,
) {
  let presented = text;
  for (const artifactId of hiddenTableArtifactIds) {
    presented = presented.replace(
      new RegExp(
        `(?:^|\\n)[^\\n]*(?:chart source|source table)[^\\n]*\\n\\s*<artifact_ref\\s+id=["']${artifactId}["']\\s+type=["']table["']\\s*/>`,
        "gi",
      ),
      "\n",
    );
  }
  return presented
    .replace(
      /<artifact_ref\s+id=["']art_[^"']+["']\s+type=["'](?:chart|table)["']\s*\/>/gi,
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ArtifactCard({
  artifactId,
  capability,
  kind,
  onCapabilityExpired,
  sessionId,
}: {
  artifactId: string;
  capability: string | null;
  kind: "chart" | "table";
  onCapabilityExpired: (capability: string) => Promise<string | null>;
  sessionId: string;
}) {
  const [artifact, setArtifact] = useState<ArtifactEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!capability) return;
    const controller = new AbortController();
    setError(null);
    setArtifact(null);
    void (async () => {
      let activeCapability = capability;
      let response = await fetch(
        `/api/chat/sessions/${sessionId}/artifacts/${artifactId}`,
        {
          headers: { authorization: `Bearer ${activeCapability}` },
          signal: controller.signal,
        },
      );
      if (response.status === 404) {
        const renewed = await onCapabilityExpired(activeCapability);
        if (renewed) {
          activeCapability = renewed;
          response = await fetch(
            `/api/chat/sessions/${sessionId}/artifacts/${artifactId}`,
            {
              headers: { authorization: `Bearer ${activeCapability}` },
              signal: controller.signal,
            },
          );
        }
      }
      return response;
    })()
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await apiMessage(response, "Artifact unavailable."));
        const payload = (await response.json()) as { data: ArtifactEnvelope };
        setArtifact(payload.data);
      })
      .catch((fetchError: unknown) => {
        if (!controller.signal.aborted)
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Artifact unavailable.",
          );
      });
    return () => controller.abort();
  }, [artifactId, capability, onCapabilityExpired, sessionId]);

  async function download() {
    if (!capability) return;
    let activeCapability = capability;
    let response = await fetch(
      `/api/chat/sessions/${sessionId}/artifacts/${artifactId}/download`,
      { headers: { authorization: `Bearer ${activeCapability}` } },
    );
    if (response.status === 404) {
      const renewed = await onCapabilityExpired(activeCapability);
      if (renewed) {
        activeCapability = renewed;
        response = await fetch(
          `/api/chat/sessions/${sessionId}/artifacts/${artifactId}/download`,
          { headers: { authorization: `Bearer ${activeCapability}` } },
        );
      }
    }
    if (!response.ok) {
      setError(await apiMessage(response, "Download failed."));
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${artifactId}.table.v1.jsonl`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!capability)
    return (
      <div className={styles.artifactUnavailable}>
        Open this session in the browser where it was created to view its
        artifact.
      </div>
    );
  if (error) return <div className={styles.artifactUnavailable}>{error}</div>;
  if (!artifact)
    return (
      <div className={styles.artifactLoading}>
        <LoaderCircle aria-hidden="true" /> Loading {kind}…
      </div>
    );

  if (
    artifact.schemaVersion === "chart.v1" &&
    artifact.config &&
    artifact.data
  ) {
    return (
      <div className={styles.chartArtifact}>
        <ChartCard
          columnMetadata={chartColumnMetadata(artifact)}
          config={artifact.config}
          data={artifact.data}
          description={artifact.description}
          height={320}
          title={artifact.title}
        />
      </div>
    );
  }

  const columns = artifact.columns?.map((column) => column.name) ?? [];
  const rows = artifact.preview ?? [];
  return (
    <section className={styles.tableArtifact}>
      <header>
        <div>
          <Table2 aria-hidden="true" />
          <span>
            <strong>{artifact.title || "Result table"}</strong>
            <small>{artifact.rowCount.toLocaleString()} rows</small>
          </span>
        </div>
        <button
          aria-label="Download table"
          onClick={() => void download()}
          type="button"
        >
          <ArrowDownToLine aria-hidden="true" />
        </button>
      </header>
      <div>
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 6).map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column}>{String(row[column] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TurnView({
  capability,
  onApproval,
  onCapabilityExpired,
  approvalStates,
  sessionId,
  turn,
}: {
  capability: string | null;
  onApproval: (
    turnId: string,
    toolCallId: string,
    decision: "allow" | "deny",
  ) => void;
  onCapabilityExpired: (capability: string) => Promise<string | null>;
  approvalStates: ReadonlyMap<string, ApprovalState>;
  sessionId: string;
  turn: ConversationTurn;
}) {
  const [copied, setCopied] = useState(false);
  const rawAnswer = assistantText(turn.events);
  const executionSteps = executionActivities(turn.events);
  const approvals = Array.from(
    new Map(
      turn.events
        .flatMap((event) =>
          event.type === "approval.required" ? event.toolCalls : [],
        )
        .map((approval) => [approval.toolCallId, approval]),
    ).values(),
  );
  const artifacts = Array.from(
    new Map(
      turn.events
        .flatMap((event) =>
          event.type === "artifact.created" ? [event.artifact] : [],
        )
        .map((artifact) => [artifact.id, artifact]),
    ).values(),
  );
  const chartSourceArtifactIds = new Set(
    artifacts.flatMap((artifact) =>
      artifact.kind === "chart" && artifact.sourceArtifactId
        ? [artifact.sourceArtifactId]
        : [],
    ),
  );
  const presentedArtifacts = artifacts.filter(
    (artifact) =>
      artifact.kind !== "table" || !chartSourceArtifactIds.has(artifact.id),
  );
  const answer = assistantPresentationText(rawAnswer, chartSourceArtifactIds);
  const failure = turn.events.find(
    (event): event is Extract<NormalizedEvent, { type: "turn.failed" }> =>
      event.type === "turn.failed",
  );

  return (
    <article className={styles.turn}>
      {turn.userMessage ? (
        <div className={styles.userMessageGroup}>
          <div className={styles.userMessage}>{turn.userMessage}</div>
        </div>
      ) : null}
      <div className={styles.assistantTurn}>
        <div className={styles.assistantContent}>
          <ExecutionChain
            failed={Boolean(failure)}
            running={turn.running}
            steps={executionSteps}
          />
          {answer ? (
            <div className={styles.answerGroup}>
              <MarkdownView text={answer} />
            </div>
          ) : null}
          {approvals.map((approval) => {
            const approvalState = approvalStates.get(approval.toolCallId);
            return (
              <section
                className={styles.approvalCard}
                data-decision={approvalState?.decision}
                data-state={approvalState?.status}
                key={approval.toolCallId}
              >
                <header>
                  {approvalState?.status === "resolved" ? (
                    approvalState.decision === "allow" ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <X aria-hidden="true" />
                    )
                  ) : (
                    <ShieldCheck aria-hidden="true" />
                  )}
                  <span>
                    <strong>
                      {approvalState?.status === "resolved"
                        ? approvalState.decision === "allow"
                          ? "Change approved"
                          : "Change denied"
                        : "Approve database change?"}
                    </strong>
                    <p>
                      {approvalState?.status === "resolved"
                        ? approvalState.decision === "allow"
                          ? "Execution resumed. Its activity and result appear below."
                          : "The database change was not applied."
                        : "Forty Two paused before applying this SQL change."}
                    </p>
                  </span>
                </header>
                {approvalState?.status !== "resolved" ? (
                  <div>
                    <Button
                      isDisabled={approvalState?.status === "submitting"}
                      onPress={() =>
                        onApproval(turn.id, approval.toolCallId, "deny")
                      }
                      size="sm"
                      variant="secondary"
                    >
                      Deny
                    </Button>
                    <Button
                      isDisabled={approvalState?.status === "submitting"}
                      onPress={() =>
                        onApproval(turn.id, approval.toolCallId, "allow")
                      }
                      size="sm"
                    >
                      {approvalState?.status === "submitting"
                        ? "Submitting…"
                        : "Allow change"}
                    </Button>
                  </div>
                ) : null}
              </section>
            );
          })}
          {presentedArtifacts.map((artifact) => (
            <ArtifactCard
              artifactId={artifact.id}
              capability={capability}
              key={artifact.id}
              kind={artifact.kind}
              onCapabilityExpired={onCapabilityExpired}
              sessionId={sessionId}
            />
          ))}
          {answer ? (
            <div className={styles.answerActions}>
              <button
                aria-label={copied ? "Copied response" : "Copy response"}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(answer)
                    .then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1_500);
                    })
                    .catch(() => undefined);
                }}
                type="button"
              >
                {copied ? (
                  <Check aria-hidden="true" data-success="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
          ) : null}
          {failure ? (
            <div className={styles.turnError}>
              {failure.message || "The run did not finish."}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function ChatWorkspace({
  initialSessionId,
  initialSourceId,
}: {
  initialSessionId?: string;
  initialSourceId?: string;
}) {
  const router = useRouter();
  const [sources, setSources] = useState<DataSource[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalStates, setApprovalStates] = useState(
    new Map<string, ApprovalState>(),
  );
  const [plan, setPlan] = useState<Plan | null>(null);
  const streams = useRef(new Map<string, EventSource>());
  const activeSessionId = useRef(initialSessionId);
  activeSessionId.current = initialSessionId;
  const capabilityRenewal = useRef<{
    controller: AbortController;
    promise: Promise<string | null>;
    sessionId: string;
  } | null>(null);
  const sessionCreation = useRef<{
    fingerprint: string;
    idempotencyKey: string;
  } | null>(null);
  const [capability, setCapability] = useState<string | null>(null);
  const running = turns.some((turn) => turn.running);

  useEffect(() => {
    if (
      capabilityRenewal.current &&
      capabilityRenewal.current.sessionId !== initialSessionId
    ) {
      capabilityRenewal.current.controller.abort();
      capabilityRenewal.current = null;
    }
    setCapability(
      initialSessionId
        ? sessionStorage.getItem(
            `forty-two-artifact-capability:${initialSessionId}`,
          )
        : null,
    );
  }, [initialSessionId]);

  const renewCapability = useCallback(
    async (expiredCapability: string): Promise<string | null> => {
      if (!initialSessionId) return null;
      if (capabilityRenewal.current?.sessionId === initialSessionId) {
        return capabilityRenewal.current.promise;
      }
      capabilityRenewal.current?.controller.abort();
      const controller = new AbortController();
      const sessionId = initialSessionId;
      const renewal = fetch(
        `/api/chat/sessions/${sessionId}/artifacts/capability`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${expiredCapability}` },
          signal: controller.signal,
        },
      )
        .then(async (response) => {
          if (!response.ok) return null;
          const payload = (await response.json()) as {
            data: { artifactCapability: string };
          };
          if (activeSessionId.current !== sessionId) return null;
          sessionStorage.setItem(
            `forty-two-artifact-capability:${sessionId}`,
            payload.data.artifactCapability,
          );
          setCapability(payload.data.artifactCapability);
          return payload.data.artifactCapability;
        })
        .catch(() => null)
        .finally(() => {
          if (capabilityRenewal.current?.promise === renewal) {
            capabilityRenewal.current = null;
          }
        });
      capabilityRenewal.current = { controller, promise: renewal, sessionId };
      return renewal;
    },
    [initialSessionId],
  );

  const loadSources = useCallback(async (signal: AbortSignal) => {
    if (initialSessionId) {
      const sessionResponse = await fetch(
        `/api/chat/sessions/${initialSessionId}`,
        { cache: "no-store", signal },
      );
      if (signal.aborted) return;
      if (!sessionResponse.ok) {
        setError(
          await apiMessage(sessionResponse, "Session sources are unavailable."),
        );
        return;
      }
      const payload = (await sessionResponse.json()) as {
        data: { dataSources: DataSource[] };
      };
      if (signal.aborted) return;
      setSources(payload.data.dataSources);
      setSelectedSourceIds(payload.data.dataSources.map((source) => source.id));
      return;
    }
    const sourceResponse = await fetch(
      "/api/data-sources?status=ready&limit=100",
      { cache: "no-store", signal },
    );
    if (signal.aborted) return;
    if (sourceResponse.ok) {
      const payload = (await sourceResponse.json()) as { data: DataSource[] };
      if (signal.aborted) return;
      setSources(payload.data);
      const requestedSource = initialSourceId
        ? payload.data.find((source) => source.id === initialSourceId)
        : null;
      setSelectedSourceIds((current) => {
        if (initialSourceId) {
          return requestedSource ? [requestedSource.id] : [];
        }
        return current.length
          ? current
          : payload.data.slice(0, 8).map((source) => source.id);
      });
      if (initialSourceId && !requestedSource) {
        setError("This connector is unavailable or not ready yet.");
      }
    } else {
      setError(
        await apiMessage(sourceResponse, "Data sources are unavailable."),
      );
    }
  }, [initialSessionId, initialSourceId]);

  const refreshPlan = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/chat/sessions/${sessionId}/plan`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { data: { plan: Plan | null } };
    if (activeSessionId.current === sessionId) setPlan(payload.data.plan);
  }, []);

  const openStream = useCallback(
    (sessionId: string, turnId: string) => {
      if (streams.current.has(turnId)) return;
      const stream = new EventSource(
        `/api/chat/sessions/${sessionId}/turns/${turnId}/events/stream`,
      );
      streams.current.set(turnId, stream);
      const receive = (raw: Event) => {
        if (activeSessionId.current !== sessionId) return;
        let event: NormalizedEvent;
        try {
          event = JSON.parse(
            (raw as MessageEvent<string>).data,
          ) as NormalizedEvent;
        } catch {
          return;
        }
        setTurns((current) =>
          current.map((turn) =>
            turn.id === turnId
              ? {
                  ...turn,
                  events: [...turn.events, event],
                  running:
                    event.type !== "turn.completed" &&
                    event.type !== "turn.failed",
                }
              : turn,
          ),
        );
        if (event.type === "plan.reconciled") {
          setPlan(event.snapshot.plan);
        }
        if (event.type === "plan.optimistic") setPlan(null);
        if (event.type === "plan.failed") void refreshPlan(sessionId);
        if (event.type === "turn.completed" || event.type === "turn.failed") {
          stream.close();
          streams.current.delete(turnId);
          void refreshPlan(sessionId);
        }
      };
      streamCategories.forEach((category) =>
        stream.addEventListener(category, receive),
      );
      stream.onerror = () => {
        if (activeSessionId.current !== sessionId) {
          stream.close();
          streams.current.delete(turnId);
          return;
        }
        void reconcileStreamError({
          loadHistory: async () => {
            const response = await fetch(
              `/api/chat/sessions/${sessionId}/turns/${turnId}/events`,
              { cache: "no-store" },
            );
            if (!response.ok) throw new Error("Turn history unavailable.");
            const payload = (await response.json()) as {
              normalizedEvents: NormalizedEvent[];
            };
            return payload.normalizedEvents;
          },
          applyTerminalHistory: (events) => {
            setTurns((current) =>
              current.map((turn) =>
                turn.id === turnId ? { ...turn, events, running: false } : turn,
              ),
            );
          },
          closeTerminalStream: () => {
            stream.close();
            streams.current.delete(turnId);
            void refreshPlan(sessionId);
          },
        });
      };
    },
    [refreshPlan],
  );

  useEffect(() => {
    const controller = new AbortController();
    setSources([]);
    setSelectedSourceIds([]);
    void loadSources(controller.signal).catch((loadError: unknown) => {
      if (controller.signal.aborted) return;
      setSources([]);
      setSelectedSourceIds([]);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Data sources are unavailable.",
      );
    });
    return () => controller.abort();
  }, [loadSources]);

  useEffect(() => {
    const sessionStreams = streams.current;
    sessionStreams.forEach((stream) => stream.close());
    sessionStreams.clear();
    if (!initialSessionId) {
      setTurns([]);
      setPlan(null);
      setApprovalStates(new Map());
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPlan(null);
    setApprovalStates(new Map());
    void (async () => {
      const turns = await collectCursorPages<ApiTurn>(async (pageToken) => {
        const search = new URLSearchParams({ limit: "25" });
        if (pageToken) search.set("pageToken", pageToken);
        const response = await fetch(
          `/api/chat/sessions/${initialSessionId}/turns?${search}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(
            await apiMessage(response, "Conversation could not be loaded."),
          );
        return (await response.json()) as {
          data: ApiTurn[];
          pagination: { nextPageToken: string | null };
        };
      });

      const loaded = await Promise.all(
        turns.map(async (turn): Promise<ConversationTurn> => {
          const eventResponse = await fetch(
            `/api/chat/sessions/${initialSessionId}/turns/${turn.id}/events`,
            { cache: "no-store", signal: controller.signal },
          );
          const eventPayload = eventResponse.ok
            ? ((await eventResponse.json()) as {
                normalizedEvents: NormalizedEvent[];
              })
            : { normalizedEvents: [] };
          return {
            id: turn.id,
            userMessage: userMessage(turn),
            events: eventPayload.normalizedEvents,
            running: !terminalStates.has(turn.state.status),
          };
        }),
      );
      setTurns(loaded);
      loaded
        .filter((turn) => turn.running)
        .forEach((turn) => openStream(initialSessionId, turn.id));
      void refreshPlan(initialSessionId);
    })()
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted)
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Conversation could not be loaded.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      sessionStreams.forEach((stream) => stream.close());
      sessionStreams.clear();
    };
  }, [initialSessionId, openStream, refreshPlan]);

  useEffect(
    () => () => {
      streams.current.forEach((stream) => stream.close());
      streams.current.clear();
    },
    [],
  );

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || submitting || running) return;
    if (!initialSessionId && !selectedSourceIds.length) {
      setSourcePickerOpen(true);
      setError("Choose at least one ready data source.");
      return;
    }
    setSubmitting(true);
    setError(null);
    let createdSessionId: string | null = null;
    try {
      let sessionId = initialSessionId;
      if (!sessionId) {
        const fingerprint = JSON.stringify([...selectedSourceIds].sort());
        if (sessionCreation.current?.fingerprint !== fingerprint) {
          sessionCreation.current = {
            fingerprint,
            idempotencyKey: crypto.randomUUID(),
          };
        }
        const response = await fetch("/api/chat/sessions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": sessionCreation.current.idempotencyKey,
          },
          body: JSON.stringify({ dataSourceIds: selectedSourceIds }),
        });
        if (!response.ok)
          throw new Error(
            await apiMessage(response, "Analysis could not be started."),
          );
        const payload = (await response.json()) as {
          data: { id: string; artifactCapability: string };
        };
        sessionId = payload.data.id;
        createdSessionId = sessionId;
        sessionCreation.current = null;
        sessionStorage.setItem(
          `forty-two-artifact-capability:${sessionId}`,
          payload.data.artifactCapability,
        );
        localStorage.setItem(
          `forty-two-session-title:${sessionId}`,
          text.length > 48 ? `${text.slice(0, 47)}…` : text,
        );
      }
      const response = await fetch(`/api/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok)
        throw new Error(
          await apiMessage(response, "Message could not be sent."),
        );
      const payload = (await response.json()) as { data: ApiTurn };
      setPlan(null);
      setMessage("");
      if (!initialSessionId) {
        router.push(`/chat/${sessionId}`);
      } else {
        const turn: ConversationTurn = {
          id: payload.data.id,
          userMessage: text,
          events: [],
          running: true,
        };
        setTurns((current) => [...current, turn]);
        openStream(sessionId, turn.id);
      }
    } catch (sendError) {
      if (createdSessionId && !initialSessionId) {
        router.replace(`/chat/${createdSessionId}`);
      }
      setError(
        sendError instanceof Error
          ? sendError.message
          : "Message could not be sent.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (!initialSessionId) return;
    await fetch(`/api/chat/sessions/${initialSessionId}/cancel`, {
      method: "POST",
    });
  }

  async function approve(
    turnId: string,
    toolCallId: string,
    decision: "allow" | "deny",
  ) {
    if (!initialSessionId) return;
    if (approvalStates.get(toolCallId)?.status === "submitting") return;
    setApprovalStates((current) =>
      submittingApproval(current, toolCallId, decision),
    );
    try {
      const response = await fetch(
        `/api/chat/sessions/${initialSessionId}/turns/${turnId}/approval`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toolCallId, decision }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await apiMessage(response, "Approval could not be submitted."),
        );
      }
      const payload = (await response.json()) as { data: ApiTurn };
      setApprovalStates((current) =>
        resolvedApproval(current, toolCallId, decision),
      );
      setTurns((current) => [
        ...current,
        { id: payload.data.id, userMessage: null, events: [], running: true },
      ]);
      openStream(initialSessionId, payload.data.id);
    } catch (approvalError) {
      setApprovalStates((current) => retryableApproval(current, toolCallId));
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "Approval could not be submitted.",
      );
    }
  }

  const selectedSources = useMemo(
    () => sources.filter((source) => selectedSourceIds.includes(source.id)),
    [selectedSourceIds, sources],
  );

  return (
    <div className={styles.workspace}>
      <main className={styles.conversation}>
        <ChatTranscript
          contentVersion={turns
            .map(
              (turn) =>
                `${turn.id}:${turn.events.length}:${turn.running ? "1" : "0"}`,
            )
            .join("|")}
        >
          {loading ? (
            <div className={styles.loadingState}>
              <LoaderCircle aria-hidden="true" />
            </div>
          ) : !turns.length ? (
            <section className={styles.welcome}>
              <div className={styles.welcomeBrand} aria-hidden="true">
                <i />
                <span>
                  Forty <em>Two</em>
                </span>
              </div>
              <h1>What would you like to know?</h1>
              <p>
                {sources.length
                  ? `${sources.length} connected ${sources.length === 1 ? "source is" : "sources are"} ready for this session.`
                  : "Connect a data source to begin a session."}
              </p>
              {sources.length ? (
                <div className={styles.starterPrompts}>
                  {starterPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        setMessage(prompt);
                        requestAnimationFrame(() =>
                          document
                            .getElementById("forty-two-composer")
                            ?.focus(),
                        );
                      }}
                      type="button"
                    >
                      <span>{prompt}</span>
                      <ArrowUpRight aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : (
                <Link href="/connectors/new">Connect a data source</Link>
              )}
            </section>
          ) : (
            <div className={styles.turns}>
              {turns.map((turn) => (
                <TurnView
                  capability={capability}
                  key={turn.id}
                  onApproval={approve}
                  onCapabilityExpired={renewCapability}
                  approvalStates={approvalStates}
                  sessionId={initialSessionId!}
                  turn={turn}
                />
              ))}
            </div>
          )}
        </ChatTranscript>

        <div className={styles.composerDock}>
          {error ? (
            <div className={styles.composerError}>
              {error}
              <button
                aria-label="Dismiss error"
                onClick={() => setError(null)}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {sourcePickerOpen && !initialSessionId ? (
            <section className={styles.sourcePicker}>
              <header>
                <div>
                  <strong>Data sources</strong>
                  <span>Select up to 8 sources for this analysis.</span>
                </div>
                <button
                  aria-label="Close source picker"
                  onClick={() => setSourcePickerOpen(false)}
                  type="button"
                >
                  <X aria-hidden="true" />
                </button>
              </header>
              <div>
                {sources.map((source) => {
                  const selected = selectedSourceIds.includes(source.id);
                  return (
                    <button
                      aria-pressed={selected}
                      data-selected={selected || undefined}
                      key={source.id}
                      onClick={() =>
                        setSelectedSourceIds((current) =>
                          selected
                            ? current.filter((id) => id !== source.id)
                            : current.length < 8
                              ? [...current, source.id]
                              : current,
                        )
                      }
                      type="button"
                    >
                      <Database aria-hidden="true" />
                      <span>
                        <strong>{source.name}</strong>
                        <small>{source.connectorType}</small>
                      </span>
                      {selected ? <Check aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
          <ChatComposer
            message={message}
            onMessageChange={setMessage}
            onStop={() => void cancel()}
            onSubmit={send}
            plan={plan ? <PinnedPlan plan={plan} running={running} /> : null}
            running={running}
            submitting={submitting}
            toolbarStart={
              !initialSessionId ? (
                <button
                  className={styles.sourceButton}
                  onClick={() => setSourcePickerOpen((value) => !value)}
                  type="button"
                >
                  <Database aria-hidden="true" />
                  {selectedSources.length === 1
                    ? selectedSources[0]?.name
                    : selectedSources.length
                      ? `${selectedSources.length} sources`
                      : "Choose sources"}
                </button>
              ) : (
                <span className={styles.sessionScope}>
                  <Database aria-hidden="true" />
                  {sourceScopeLabel(selectedSources, "Session sources")}
                </span>
              )
            }
          />
          <p className={styles.disclaimer}>
            Forty Two can make mistakes. Verify important results.
          </p>
        </div>
      </main>
    </div>
  );
}
