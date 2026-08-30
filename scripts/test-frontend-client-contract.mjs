import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { ChartArtifactEnvelopeV1Schema } from "../packages/charting/dist/server/artifact-contracts.js";
import {
  SseParser,
  assertSafeHistoryEnvelope,
  assertSafeNormalizedEvents,
  createFrontendClient,
  reconcileFrontendHistory,
  reduceFrontendEvents,
  validateCanonicalTableDownload,
  validateChartEnvelope,
  validateTableDetail,
} from "./lib/frontend-client-contract.mjs";

const sessionId = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const turnId = "turn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const tableId = "art_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const chartId = "art_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const capability = "ftart1.deterministic-browser-capability";
const createdAt = "2026-08-29T10:00:00.000Z";
const columns = [{ name: "value", type: "integer", nullable: false }];
const rows = [{ value: 7 }, { value: 42 }];
const tableText = `${JSON.stringify({ $schema: "table.v1", columns, rowCount: rows.length })}\n${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const tableBytes = Buffer.from(tableText);
const tableSha = createHash("sha256").update(tableBytes).digest("hex");
const events = deterministicEvents();

describe("browser frontend client contract", () => {
  let server;
  let baseUrl;
  const seenLastEventIds = [];
  const approvals = [];
  let deleted = false;

  before(async () => {
    server = createServer(async (request, response) => {
      try {
        await fakeProductApi(request, response, {
          approvals,
          seenLastEventIds,
          deleted: () => deleted,
          markDeleted: () => {
            deleted = true;
          },
        });
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("parses fragmented CRLF, comments, multi-line data, id, event, and retry fields", () => {
    const parsed = [];
    const parser = new SseParser((frame) => parsed.push(frame));
    for (const fragment of [
      ":keep-alive\r\n",
      "id: 12",
      ":3\r\nevent: assistant\r\n",
      'retry: 1500\r\ndata: {"type":"assistant.message.delta",\r\n',
      'data: "text":"hello"}\r\n\r\n',
    ]) {
      parser.feed(fragment);
    }
    parser.finish();
    assert.deepEqual(parsed, [
      {
        id: "12:3",
        event: "assistant",
        retry: 1500,
        data: '{"type":"assistant.message.delta",\n"text":"hello"}',
      },
    ]);
  });

  it("drives create, reconnect, history reconciliation, plan, approval, artifacts, reload, and idempotent cleanup", async () => {
    const client = createFrontendClient({ baseUrl });
    const created = await client.createSession(
      ["ds_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      "deterministic-create",
    );
    assert.equal(created.id, sessionId);

    const turn = await client.submitTurn(
      sessionId,
      "Exercise the browser contract.",
      "deterministic-turn",
    );
    assert.equal(turn.id, turnId);
    const streamed = await client.consumeTurnStream(sessionId, turnId, {
      disconnectAfterEvents: 2,
    });
    assert.equal(streamed.reconnects, 1);
    assert.equal(streamed.lastEventId, "7:1");
    assert.deepEqual(seenLastEventIds, [undefined, "1:1"]);

    const liveState = reduceFrontendEvents(streamed.events);
    assert.equal(
      liveState.assistant.messages.message_1.text,
      "Frontend ready.",
    );
    assert.equal(liveState.tools.tool_1.status, "completed");
    assert.equal(liveState.planRevision, 2);
    assert.equal(liveState.approval.status, "pending");
    assert.equal(liveState.terminal.output, "query complete\n");
    assert.equal(liveState.terminal.status, "completed");
    assert.equal(liveState.turn.status, "completed");

    const history = await client.getTurnHistory(sessionId, turnId);
    const reloadedState = reconcileFrontendHistory(
      liveState,
      history.normalizedEvents,
    );
    assert.deepEqual(reloadedState, liveState);

    const plan = await client.getPlan(sessionId);
    assert.equal(plan.data.revision, 2);
    assert.equal(plan.data.plan.items[0].status, "completed");

    const denied = await client.resolveApproval(sessionId, turnId, {
      toolCallId: "tool_approval",
      decision: "deny",
      reason: "Deterministic denial",
    });
    const allowed = await client.resolveApproval(sessionId, turnId, {
      toolCallId: "tool_approval",
      decision: "allow",
    });
    assert.deepEqual(approvals, ["deny", "allow"]);
    assert.notEqual(denied.id, allowed.id);

    const artifacts = await client.listArtifacts(sessionId, capability);
    assert.deepEqual(
      artifacts.data.artifacts.map(({ id }) => id),
      [tableId, chartId],
    );
    const table = validateTableDetail(
      (await client.getArtifact(sessionId, tableId, capability)).data,
    );
    const download = await client.downloadArtifact(
      sessionId,
      tableId,
      capability,
    );
    assert.deepEqual(
      validateCanonicalTableDownload(download.bytes, table),
      rows,
    );

    const chart = validateChartEnvelope(
      (await client.getArtifact(sessionId, chartId, capability)).data,
    );
    assert.equal(ChartArtifactEnvelopeV1Schema.safeParse(chart).success, true);

    const sessions = await client.listSessions();
    assert.equal(sessions.data[0].id, sessionId);
    const turns = await client.listTurns(sessionId);
    assert.equal(turns.data[0].id, turnId);
    assert.equal(
      (await client.getTurn(sessionId, turnId)).data.sessionId,
      sessionId,
    );
    assert.equal(
      (await client.waitTurn(sessionId, turnId, 1)).data.state.status,
      "done",
    );

    assert.equal(await client.deleteSession(sessionId), 204);
    assert.equal(await client.deleteSession(sessionId), 404);
  });

  it("rejects raw history, tool payloads, signed URLs, secrets, and reasoning", () => {
    assert.throws(
      () =>
        assertSafeHistoryEnvelope({
          data: [{ event: { type: "tool.response", content: "raw" } }],
          normalizedEvents: [],
          planEvents: [],
        }),
      /diverged from the normalized event contract/,
    );
    assert.throws(
      () =>
        assertSafeNormalizedEvents([
          {
            type: "tool.completed",
            toolCallId: "tool_1",
            threadId: "thread_1",
            tool: null,
            result: { rows: [{ secret: 42 }] },
          },
        ]),
      /forbidden field result/,
    );
    assert.throws(
      () =>
        assertSafeNormalizedEvents([
          {
            type: "assistant.message.delta",
            messageId: "message_1",
            threadId: "thread_1",
            text: "download https://blob.example/x?sv=1&se=2&sp=r&sig=secret",
          },
        ]),
      /signed URL/,
    );
    assert.throws(
      () =>
        assertSafeNormalizedEvents([
          {
            type: "assistant.message.delta",
            messageId: "message_1",
            threadId: "thread_1",
            text: "Bearer secret-token-value",
          },
        ]),
      /bearer credential/,
    );
    assert.throws(
      () =>
        assertSafeNormalizedEvents([
          {
            type: "assistant.message.delta",
            messageId: "message_1",
            threadId: "thread_1",
            text: "safe",
            reasoning: "hidden chain",
          },
        ]),
      /forbidden field reasoning/,
    );
  });
});

function deterministicEvents() {
  const plan = {
    title: "Frontend contract",
    items: [
      {
        text: "Verify browser state",
        status: "completed",
        summary: "Verified",
      },
    ],
  };
  return [
    frame("1:0", "assistant", {
      type: "assistant.message.started",
      messageId: "message_1",
      threadId: "thread_1",
      createdAt,
    }),
    frame("1:1", "assistant", {
      type: "assistant.message.delta",
      messageId: "message_1",
      threadId: "thread_1",
      text: "Frontend ready.",
    }),
    frame("2:0", "tool", {
      type: "tool.started",
      toolCallId: "tool_1",
      sourceMessageId: "message_1",
      threadId: "thread_1",
      tool: { kind: "mcp", name: "plan", serverName: "forty-two-todo" },
    }),
    frame("2:1", "plan", {
      type: "plan.optimistic",
      toolCallId: "tool_1",
      arguments: {
        action: "set",
        title: "Frontend contract",
        items: [{ text: "Verify browser state", status: "pending" }],
      },
    }),
    frame("3:0", "tool", {
      type: "tool.completed",
      toolCallId: "tool_1",
      threadId: "thread_1",
      tool: { kind: "mcp", name: "plan", serverName: "forty-two-todo" },
    }),
    frame("3:1", "plan", {
      type: "plan.reconciled",
      toolCallId: "tool_1",
      snapshot: { plan, revision: 2, updatedAt: createdAt },
    }),
    frame("4:0", "approval", {
      type: "approval.required",
      sourceEventId: "approval_1",
      threadId: "thread_1",
      toolCalls: [
        {
          toolCallId: "tool_approval",
          sourceMessageId: "message_1",
          tool: {
            kind: "mcp",
            name: "apply_sql_change",
            serverName: "forty-two-data-source",
          },
        },
      ],
      truncated: false,
    }),
    frame("4:1", "artifact", {
      type: "artifact.created",
      toolCallId: "tool_table",
      artifact: {
        id: tableId,
        kind: "table",
        schemaVersion: "table.v1",
        rowCount: 2,
      },
    }),
    frame("5:0", "artifact", {
      type: "artifact.created",
      toolCallId: "tool_chart",
      artifact: {
        id: chartId,
        kind: "chart",
        schemaVersion: "chart.v1",
        sourceArtifactId: tableId,
      },
    }),
    frame("5:1", "terminal", {
      type: "terminal.started",
      terminalId: "terminal_1",
    }),
    frame("6:0", "terminal", {
      type: "terminal.output.delta",
      terminalId: "terminal_1",
      text: "query complete\n",
    }),
    frame("6:1", "terminal", {
      type: "terminal.completed",
      terminalId: "terminal_1",
      exitCode: 0,
    }),
    frame("7:0", "assistant", {
      type: "assistant.message.completed",
      messageId: "message_1",
      threadId: "thread_1",
      finishReason: "stop",
      truncated: false,
    }),
    frame("7:1", "turn", {
      type: "turn.completed",
      sourceEventId: "turn_done_1",
      completedAt: createdAt,
    }),
  ];
}

function frame(id, category, event) {
  return { id, category, event };
}

async function fakeProductApi(request, response, state) {
  const url = new URL(request.url, "http://fake.local");
  const json = (status, body, headers = {}) => {
    response.writeHead(status, {
      "content-type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify(body));
  };
  const body = async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };

  if (request.method === "POST" && url.pathname === "/api/chat/sessions") {
    return json(201, {
      data: { id: sessionId, status: "active", artifactCapability: capability },
    });
  }
  if (request.method === "GET" && url.pathname === "/api/chat/sessions") {
    return json(200, {
      data: [
        { id: sessionId, status: "active", createdAt, updatedAt: createdAt },
      ],
      pagination: { nextPageToken: null },
    });
  }
  if (url.pathname === `/api/chat/sessions/${sessionId}`) {
    if (request.method === "DELETE") {
      if (state.deleted())
        return json(404, { error: { message: "Chat session was not found." } });
      state.markDeleted();
      response.writeHead(204);
      return response.end();
    }
    return json(200, { data: { id: sessionId, status: "active" } });
  }
  if (
    request.method === "POST" &&
    url.pathname === `/api/chat/sessions/${sessionId}/turns`
  ) {
    return json(202, {
      data: { id: turnId, sessionId, state: { status: "running" } },
    });
  }
  if (
    request.method === "GET" &&
    url.pathname === `/api/chat/sessions/${sessionId}/turns`
  ) {
    return json(200, {
      data: [{ id: turnId, sessionId, state: { status: "done" } }],
      pagination: {},
    });
  }
  if (
    request.method === "GET" &&
    url.pathname === `/api/chat/sessions/${sessionId}/turns/${turnId}`
  ) {
    return json(200, {
      data: { id: turnId, sessionId, state: { status: "done" } },
    });
  }
  if (
    request.method === "POST" &&
    url.pathname === `/api/chat/sessions/${sessionId}/turns/${turnId}/wait`
  ) {
    return json(200, {
      data: { id: turnId, sessionId, state: { status: "done" } },
    });
  }
  if (
    request.method === "GET" &&
    url.pathname ===
      `/api/chat/sessions/${sessionId}/turns/${turnId}/events/stream`
  ) {
    const last = request.headers["last-event-id"];
    state.seenLastEventIds.push(last);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    const selected = last ? events.slice(2) : events.slice(0, 2);
    const payload = selected.map(encodeFrame).join("");
    for (const boundary of [7, 19, 47, payload.length]) {
      const start = [0, 7, 19, 47][
        [7, 19, 47, payload.length].indexOf(boundary)
      ];
      if (start < payload.length)
        response.write(payload.slice(start, boundary));
    }
    return response.end();
  }
  if (
    request.method === "GET" &&
    url.pathname === `/api/chat/sessions/${sessionId}/turns/${turnId}/events`
  ) {
    const normalizedEvents = events.map(({ event }) => event);
    return json(200, {
      data: normalizedEvents,
      normalizedEvents,
      planEvents: normalizedEvents.filter(({ type }) =>
        type.startsWith("plan."),
      ),
    });
  }
  if (
    request.method === "GET" &&
    url.pathname === `/api/chat/sessions/${sessionId}/plan`
  ) {
    const snapshot = events.find(
      ({ event }) => event.type === "plan.reconciled",
    ).event.snapshot;
    return json(200, { data: snapshot });
  }
  if (
    request.method === "POST" &&
    url.pathname === `/api/chat/sessions/${sessionId}/turns/${turnId}/approval`
  ) {
    const input = await body();
    state.approvals.push(input.decision);
    return json(202, {
      data: {
        id: `resumed_${state.approvals.length}`,
        sessionId,
        state: { status: "running" },
      },
    });
  }
  if (
    request.method === "GET" &&
    url.pathname === `/api/chat/sessions/${sessionId}/artifacts`
  ) {
    assert.equal(request.headers.authorization, `Bearer ${capability}`);
    return json(200, {
      data: {
        artifacts: [
          artifactSummary(tableId, "table", "table.v1"),
          artifactSummary(chartId, "chart", "chart.v1"),
        ],
        nextPageToken: null,
      },
    });
  }
  if (
    request.method === "GET" &&
    url.pathname === `/api/chat/sessions/${sessionId}/artifacts/${tableId}`
  ) {
    return json(200, { data: tableDetail() });
  }
  if (
    request.method === "GET" &&
    url.pathname === `/api/chat/sessions/${sessionId}/artifacts/${chartId}`
  ) {
    return json(200, { data: chartEnvelope() });
  }
  if (
    request.method === "GET" &&
    url.pathname ===
      `/api/chat/sessions/${sessionId}/artifacts/${tableId}/download`
  ) {
    const digest = Buffer.from(tableSha, "hex").toString("base64");
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-length": String(tableBytes.byteLength),
      digest: `sha-256=${digest}`,
    });
    return response.end(tableBytes);
  }
  return json(404, { error: { message: "not found" } });
}

function encodeFrame({ id, category, event }) {
  return `id: ${id}\nevent: ${category}\ndata: ${JSON.stringify(event)}\n\n`;
}

function artifactSummary(id, kind, schemaVersion) {
  return {
    id,
    kind,
    schemaVersion,
    title: `${kind} artifact`,
    description: null,
    contentSha256: kind === "table" ? tableSha : "b".repeat(64),
    byteSize: kind === "table" ? tableBytes.byteLength : 100,
    rowCount: kind === "table" ? rows.length : null,
    columnCount: kind === "table" ? columns.length : null,
    sourceLimited: false,
    sourceMaxRows: null,
    createdAt,
  };
}

function tableDetail() {
  return {
    ...artifactSummary(tableId, "table", "table.v1"),
    columns,
    preview: rows,
    parentArtifactIds: [],
    provenance: {
      tool: "deterministic",
      operationKey: "test",
      dataSourceIds: [],
      sourceReferences: [],
      completedAt: createdAt,
    },
  };
}

function chartEnvelope() {
  return {
    schemaVersion: "chart.v1",
    id: chartId,
    sourceArtifactId: tableId,
    sourceContentSha256: tableSha,
    title: "chart artifact",
    description: null,
    config: {
      selectedChartType: "scatter",
      scatterAxis: { x: ["value"], y: ["value"] },
    },
    columns,
    rowCount: rows.length,
    sourceLimited: false,
    data: rows,
    createdAt,
  };
}
