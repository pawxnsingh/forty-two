import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const PRODUCT_ID = /^(\d+):(\d+)$/;
const TERMINAL_EVENT_TYPES = new Set(["turn.completed", "turn.failed"]);

export function createFrontendClient({ baseUrl, fetchImpl = fetch }) {
  const origin = normalizedHttpUrl(baseUrl);

  async function request(path, options = {}) {
    const response = await fetchImpl(`${origin}${path}`, {
      method: options.method ?? "GET",
      headers:
        options.body === undefined
          ? options.headers
          : { ...options.headers, "content-type": "application/json" },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal:
        options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    const text = response.status === 204 ? "" : await response.text();
    const body = text
      ? parseJson(text, `HTTP ${response.status} response`)
      : undefined;
    if (!response.ok && !(options.accept404 && response.status === 404)) {
      throw new FrontendContractError(
        `${options.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    return { response, body };
  }

  return {
    async createSession(dataSourceIds, idempotencyKey) {
      const { response, body } = await request("/api/chat/sessions", {
        method: "POST",
        headers: idempotencyKey
          ? { "idempotency-key": idempotencyKey }
          : undefined,
        body: { dataSourceIds },
      });
      assert.equal(response.status, 201);
      assertPublicSession(body?.data);
      return body.data;
    },

    async listSessions({ limit = 25, pageToken } = {}) {
      const search = new URLSearchParams({ limit: String(limit) });
      if (pageToken) search.set("pageToken", pageToken);
      return (await request(`/api/chat/sessions?${search}`)).body;
    },

    async getSession(sessionId) {
      return (
        await request(`/api/chat/sessions/${encodeURIComponent(sessionId)}`)
      ).body;
    },

    async deleteSession(sessionId, { acceptMissing = true } = {}) {
      const { response } = await request(
        `/api/chat/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", accept404: acceptMissing },
      );
      assert.ok(
        response.status === 204 || (acceptMissing && response.status === 404),
      );
      return response.status;
    },

    async submitTurn(sessionId, message, idempotencyKey) {
      const { response, body } = await request(
        `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          headers: idempotencyKey
            ? { "idempotency-key": idempotencyKey }
            : undefined,
          body: { message },
        },
      );
      assert.equal(response.status, 202);
      assert.equal(body?.data?.sessionId, sessionId);
      assertNonEmptyString(body?.data?.id, "turn id");
      return body.data;
    },

    async listTurns(sessionId, { limit = 25, pageToken } = {}) {
      const search = new URLSearchParams({ limit: String(limit) });
      if (pageToken) search.set("pageToken", pageToken);
      return (
        await request(
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns?${search}`,
        )
      ).body;
    },

    async getTurn(sessionId, turnId) {
      return (
        await request(
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
        )
      ).body;
    },

    async waitTurn(sessionId, turnId, timeoutSeconds = 300) {
      return (
        await request(
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/wait`,
          {
            method: "POST",
            body: { timeoutSeconds },
            timeoutMs: timeoutSeconds * 1_000 + 30_000,
          },
        )
      ).body;
    },

    async consumeTurnStream(sessionId, turnId, options = {}) {
      return consumeNormalizedTurnStream({
        fetchImpl,
        url: `${origin}/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events/stream`,
        ...options,
      });
    },

    async getTurnHistory(sessionId, turnId) {
      const body = (
        await request(
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`,
        )
      ).body;
      assertSafeHistoryEnvelope(body);
      return body;
    },

    async getPlan(sessionId) {
      return (
        await request(
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/plan`,
        )
      ).body;
    },

    async resolveApproval(sessionId, turnId, input) {
      const { response, body } = await request(
        `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/approval`,
        { method: "POST", body: input },
      );
      assert.equal(response.status, 202);
      assert.equal(body?.data?.sessionId, sessionId);
      return body.data;
    },

    async listArtifacts(sessionId, capability, { limit = 100, kind } = {}) {
      const search = new URLSearchParams({ limit: String(limit) });
      if (kind) search.set("kind", kind);
      return (
        await request(
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/artifacts?${search}`,
          { headers: bearer(capability) },
        )
      ).body;
    },

    async getArtifact(sessionId, artifactId, capability) {
      return (
        await request(
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
          { headers: bearer(capability) },
        )
      ).body;
    },

    async downloadArtifact(sessionId, artifactId, capability) {
      const response = await fetchImpl(
        `${origin}/api/chat/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
        {
          headers: bearer(capability),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!response.ok) {
        throw new FrontendContractError(
          `Artifact download failed (${response.status}).`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = response.headers.get("digest");
      if (digest) {
        const expected = `sha-256=${Buffer.from(createHash("sha256").update(bytes).digest("hex"), "hex").toString("base64")}`;
        assert.equal(
          digest,
          expected,
          "Artifact Digest did not bind the downloaded bytes.",
        );
      }
      assert.equal(
        Number(response.headers.get("content-length")),
        bytes.byteLength,
        "Artifact Content-Length did not match the browser payload.",
      );
      return { response, bytes };
    },
  };
}

export class FrontendContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "FrontendContractError";
  }
}

export class SseParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = "";
    this.reset();
  }

  feed(value) {
    this.buffer += value;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.line(line);
    }
  }

  finish() {
    if (this.buffer)
      this.line(
        this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer,
      );
    this.buffer = "";
    this.dispatch();
  }

  line(line) {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    else if (field === "retry" && /^\d+$/.test(value))
      this.retry = Number(value);
  }

  dispatch() {
    if (this.data.length === 0) {
      this.reset();
      return;
    }
    this.onFrame({
      data: this.data.join("\n"),
      event: this.event || "message",
      id: this.id,
      retry: this.retry,
    });
    this.reset();
  }

  reset() {
    this.data = [];
    this.event = "";
    this.id = undefined;
    this.retry = undefined;
  }
}

export async function consumeNormalizedTurnStream({
  fetchImpl = fetch,
  url,
  disconnectAfterEvents = 0,
  maxReconnects = 3,
  onEvent,
  timeoutMs = 330_000,
}) {
  const events = [];
  const frames = [];
  let lastEventId;
  let reconnects = 0;
  let disconnected = false;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const headers = lastEventId ? { "last-event-id": lastEventId } : undefined;
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    assert.equal(response.status, 200, `SSE returned ${response.status}.`);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/event-stream\b/i,
    );
    assert.ok(response.body, "SSE response had no browser-readable body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let forceReconnect = false;
    const parser = new SseParser((frame) => {
      // A fetch body may contain several already-buffered frames. Once the
      // acceptance probe chooses its disconnect point, discard the remainder
      // of that body so only Last-Event-ID replay can deliver it.
      if (forceReconnect) return;
      const event = parseJson(frame.data, "SSE data");
      assert.equal(frame.event, eventCategory(event.type));
      assertSafeNormalizedEvents([event]);
      if (frame.id) {
        assertProductCursor(frame.id);
        if (lastEventId) {
          assert.ok(
            compareProductCursors(frame.id, lastEventId) > 0,
            `SSE cursor ${frame.id} did not advance beyond ${lastEventId}.`,
          );
        }
        lastEventId = frame.id;
      }
      frames.push(frame);
      events.push(event);
      onEvent?.(event, frame);
      if (
        disconnectAfterEvents > 0 &&
        !disconnected &&
        events.length >= disconnectAfterEvents &&
        !TERMINAL_EVENT_TYPES.has(event.type)
      ) {
        disconnected = true;
        forceReconnect = true;
      }
    });

    while (!forceReconnect) {
      const next = await reader.read();
      if (next.done) {
        parser.finish();
        break;
      }
      parser.feed(decoder.decode(next.value, { stream: true }));
    }
    if (forceReconnect) await reader.cancel("acceptance reconnect probe");
    if (events.some((event) => TERMINAL_EVENT_TYPES.has(event.type))) {
      return { events, frames, lastEventId, reconnects };
    }
    if (!lastEventId) {
      throw new FrontendContractError(
        "SSE ended before exposing a resumable event id.",
      );
    }
    if (reconnects >= maxReconnects) {
      throw new FrontendContractError("SSE reconnect budget was exhausted.");
    }
    reconnects += 1;
  }
  throw new FrontendContractError("SSE consumption timed out.");
}

export function initialFrontendState() {
  return {
    assistant: { order: [], messages: {} },
    tools: {},
    plan: null,
    planRevision: 0,
    approval: null,
    artifacts: {},
    terminal: { status: "idle", output: "" },
    turn: { status: "running", completedAt: null, error: null },
  };
}

export function reduceFrontendEvent(state, event) {
  const next = structuredClone(state);
  switch (event.type) {
    case "assistant.message.started":
      if (!next.assistant.messages[event.messageId]) {
        next.assistant.order.push(event.messageId);
        next.assistant.messages[event.messageId] = {
          text: "",
          status: "streaming",
          threadId: event.threadId,
          truncated: false,
        };
      }
      break;
    case "assistant.message.delta": {
      const message = (next.assistant.messages[event.messageId] ??= {
        text: "",
        status: "streaming",
        threadId: event.threadId,
        truncated: false,
      });
      if (!next.assistant.order.includes(event.messageId))
        next.assistant.order.push(event.messageId);
      message.text += event.text;
      break;
    }
    case "assistant.message.completed": {
      const message = (next.assistant.messages[event.messageId] ??= {
        text: "",
        threadId: event.threadId,
      });
      if (!next.assistant.order.includes(event.messageId))
        next.assistant.order.push(event.messageId);
      message.status = "completed";
      message.finishReason = event.finishReason;
      message.truncated = event.truncated;
      break;
    }
    case "tool.started":
      next.tools[event.toolCallId] = {
        status: "running",
        tool: event.tool,
        sourceMessageId: event.sourceMessageId,
      };
      break;
    case "tool.completed":
      next.tools[event.toolCallId] = {
        ...(next.tools[event.toolCallId] ?? {}),
        status: "completed",
        tool: event.tool ?? next.tools[event.toolCallId]?.tool ?? null,
      };
      break;
    case "plan.optimistic":
      applyOptimisticPlan(next, event.arguments);
      break;
    case "plan.reconciled":
      next.plan = event.snapshot.plan;
      next.planRevision = event.snapshot.revision;
      break;
    case "plan.failed":
      next.planError = event.message;
      break;
    case "approval.required":
      next.approval = {
        status: "pending",
        sourceEventId: event.sourceEventId,
        toolCalls: event.toolCalls,
      };
      break;
    case "artifact.created":
      next.artifacts[event.artifact.id] = event.artifact;
      break;
    case "terminal.started":
      next.terminal = { status: "running", output: "" };
      break;
    case "terminal.output.delta":
      next.terminal.output += event.text;
      break;
    case "terminal.completed":
      next.terminal.status = event.exitCode === 0 ? "completed" : "failed";
      next.terminal.exitCode = event.exitCode;
      break;
    case "turn.completed":
      next.turn = {
        status: "completed",
        completedAt: event.completedAt,
        error: null,
      };
      break;
    case "turn.failed":
      next.turn = {
        status: event.reason === "cancelled" ? "cancelled" : "failed",
        completedAt: event.completedAt,
        error: event.message,
      };
      break;
    default:
      throw new FrontendContractError(
        `Unsupported normalized event type: ${event.type}`,
      );
  }
  return next;
}

export function reduceFrontendEvents(events) {
  return events.reduce(reduceFrontendEvent, initialFrontendState());
}

export function reconcileFrontendHistory(liveState, normalizedEvents) {
  assertSafeNormalizedEvents(normalizedEvents);
  const historyState = reduceFrontendEvents(normalizedEvents);
  assert.deepEqual(
    stableState(liveState),
    stableState(historyState),
    "Reloaded normalized history did not reconcile to the live browser state.",
  );
  return historyState;
}

export function assertSafeHistoryEnvelope(value) {
  assertRecord(value, "history envelope");
  assert.ok(
    Array.isArray(value.data),
    "History omitted its normalized data alias.",
  );
  assert.ok(
    Array.isArray(value.normalizedEvents),
    "History omitted normalizedEvents.",
  );
  assert.ok(Array.isArray(value.planEvents), "History omitted planEvents.");
  assert.deepEqual(
    value.data,
    value.normalizedEvents,
    "Persisted history data diverged from the normalized event contract.",
  );
  assertSafeNormalizedEvents(value.data);
  assertSafeNormalizedEvents(value.normalizedEvents);
  assertSafeNormalizedEvents(value.planEvents);
}

export function assertSafeNormalizedEvents(events) {
  assert.ok(Array.isArray(events));
  for (const event of events) {
    assertRecord(event, "normalized event");
    assertNonEmptyString(event.type, "normalized event type");
    const allowed = allowedEventKeys(event.type);
    for (const key of Object.keys(event)) {
      assert.ok(
        allowed.has(key),
        `${event.type} exposed forbidden field ${key}.`,
      );
    }
    scanForLeaks(
      event,
      event.type === "plan.optimistic" ? new Set(["arguments"]) : new Set(),
    );
  }
}

export function validateTableDetail(value) {
  assertRecord(value, "table detail");
  assert.equal(value.kind, "table");
  assert.equal(value.schemaVersion, "table.v1");
  assert.ok(
    Array.isArray(value.columns) &&
      value.columns.length > 0 &&
      value.columns.length <= 100,
  );
  assert.ok(Array.isArray(value.preview) && value.preview.length <= 30);
  assert.equal(value.columnCount, value.columns.length);
  assert.ok(value.preview.length <= value.rowCount);
  const names = value.columns.map((column) => column.name);
  for (const row of value.preview) assert.deepEqual(Object.keys(row), names);
  return value;
}

export function validateCanonicalTableDownload(bytes, detail) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(text.endsWith("\n"), "table.v1 download must end with a newline.");
  const lines = text.slice(0, -1).split("\n");
  const header = parseJson(lines[0], "table.v1 header");
  assert.equal(header.$schema, "table.v1");
  assert.deepEqual(header.columns, detail.columns);
  assert.equal(header.rowCount, detail.rowCount);
  assert.equal(lines.length - 1, detail.rowCount);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    detail.contentSha256,
  );
  return lines.slice(1).map((line) => parseJson(line, "table.v1 row"));
}

export function validateChartEnvelope(value) {
  assertRecord(value, "chart envelope");
  assert.equal(value.kind, undefined);
  assert.equal(value.schemaVersion, "chart.v1");
  assert.match(value.id, /^art_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(value.sourceArtifactId, /^art_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(value.sourceContentSha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(value.columns) && value.columns.length > 0);
  assert.ok(Array.isArray(value.data));
  assert.equal(value.data.length, value.rowCount);
  assertRecord(value.config, "chart config");
  assert.ok(
    ["bar", "line", "scatter", "pie", "combo", "metric", "table"].includes(
      value.config.selectedChartType,
    ),
    "Chart config is not renderer-compatible.",
  );
  return value;
}

function allowedEventKeys(type) {
  const definitions = {
    "assistant.message.started": ["type", "messageId", "threadId", "createdAt"],
    "assistant.message.delta": ["type", "messageId", "threadId", "text"],
    "assistant.message.completed": [
      "type",
      "messageId",
      "threadId",
      "finishReason",
      "truncated",
    ],
    "tool.started": [
      "type",
      "toolCallId",
      "sourceMessageId",
      "threadId",
      "tool",
    ],
    "tool.completed": ["type", "toolCallId", "threadId", "tool"],
    "approval.required": [
      "type",
      "sourceEventId",
      "threadId",
      "toolCalls",
      "truncated",
    ],
    "artifact.created": ["type", "toolCallId", "artifact"],
    "turn.completed": ["type", "sourceEventId", "completedAt"],
    "turn.failed": [
      "type",
      "sourceEventId",
      "completedAt",
      "reason",
      "message",
    ],
    "plan.optimistic": ["type", "toolCallId", "arguments"],
    "plan.reconciled": ["type", "toolCallId", "snapshot"],
    "plan.failed": ["type", "toolCallId", "message"],
    "terminal.started": ["type", "terminalId"],
    "terminal.output.delta": ["type", "terminalId", "text"],
    "terminal.completed": ["type", "terminalId", "exitCode"],
  };
  const keys = definitions[type];
  if (!keys)
    throw new FrontendContractError(`Unknown normalized event type ${type}.`);
  return new Set(keys);
}

function scanForLeaks(value, allowedKeys, path = "event") {
  if (typeof value === "string") {
    assert.doesNotMatch(
      value,
      /\b(?:postgres(?:ql)?|mysql|sqlserver):\/\/[^\s:/@]+:[^\s@]+@/i,
      `${path} exposed a database credential.`,
    );
    assert.doesNotMatch(
      value,
      /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
      `${path} exposed a bearer credential.`,
    );
    assert.doesNotMatch(
      value,
      /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/i,
      `${path} exposed an API key.`,
    );
    assert.doesNotMatch(
      value,
      /\b(?:ftart1|ftmcp1)\.[A-Za-z0-9._~-]+/i,
      `${path} exposed a product capability.`,
    );
    assert.doesNotMatch(
      value,
      /["']?(?:password|passwd|secret|token|api[_ -]?key|authorization)["']?\s*[:=]\s*["']?(?!\[redacted\])[^\s,"'}]+/i,
      `${path} exposed an assigned secret.`,
    );
    assert.doesNotMatch(
      value,
      /https?:\/\/[^\s"'<>]+[?&](?:sig|sv|se|sp|sr)=/i,
      `${path} exposed a signed URL.`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanForLeaks(item, allowedKeys, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      allowedKeys.has(key) ||
        !/^(?:arguments|content|data|rows?|rawRows|bytes|result|output|reasoning|reasoningContent|chainOfThought|sas|signature|url)$/i.test(
          key,
        ),
      `${path}.${key} exposed raw or secret-bearing payload data.`,
    );
    scanForLeaks(child, allowedKeys, `${path}.${key}`);
  }
}

function applyOptimisticPlan(state, args) {
  if (args.action === "set") {
    state.plan = {
      title: args.title ?? "",
      items: (args.items ?? []).map((item) => ({
        text: item.text,
        status: item.status ?? "pending",
        ...(item.summary ? { summary: item.summary } : {}),
      })),
    };
    return;
  }
  if (args.action === "update_item" && state.plan?.items?.[args.itemIndex]) {
    const item = state.plan.items[args.itemIndex];
    if (args.status) item.status = args.status;
    if (args.summary) item.summary = args.summary;
  }
}

function stableState(state) {
  const copy = structuredClone(state);
  Reflect.deleteProperty(copy, "planError");
  return copy;
}

function eventCategory(type) {
  if (type.startsWith("assistant.")) return "assistant";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("plan.")) return "plan";
  if (type.startsWith("artifact.")) return "artifact";
  if (type.startsWith("terminal.")) return "terminal";
  return "turn";
}

function compareProductCursors(left, right) {
  const leftMatch = PRODUCT_ID.exec(left);
  const rightMatch = PRODUCT_ID.exec(right);
  if (!leftMatch || !rightMatch) return 0;
  return (
    Number(leftMatch[1]) - Number(rightMatch[1]) ||
    Number(leftMatch[2]) - Number(rightMatch[2])
  );
}

function assertProductCursor(value) {
  assert.match(value, PRODUCT_ID, "SSE event id was not a product cursor.");
  for (const part of value.split(":"))
    assert.ok(Number.isSafeInteger(Number(part)));
}

function assertPublicSession(value) {
  assertRecord(value, "session response");
  assert.match(value.id, /^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(value.status, "active");
  assert.match(value.artifactCapability, /^ftart1\./);
  assert.equal(JSON.stringify(value).includes("trueforge"), false);
}

function bearer(value) {
  assertNonEmptyString(value, "artifact browser capability");
  return { authorization: `Bearer ${value}` };
}

function normalizedHttpUrl(value) {
  const url = new URL(value);
  assert.ok(url.protocol === "http:" || url.protocol === "https:");
  return url.toString().replace(/\/$/, "");
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new FrontendContractError(`${label} was not valid JSON.`);
  }
}

function assertRecord(value, label) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
}

function assertNonEmptyString(value, label) {
  assert.ok(
    typeof value === "string" && value.length > 0,
    `${label} must be a non-empty string.`,
  );
}
