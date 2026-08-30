import assert from "node:assert/strict";
import test from "node:test";

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

import {
  createNormalizedTurnEventStream,
  turnStreamCursor,
  type UpstreamServerSentEvent,
} from "./turn-event-stream";
import {
  createTurnEventState,
  normalizeTurnEvent,
  normalizeTurnHistory,
  normalizedTurnHistoryPayload,
  safeText,
  type NormalizedTurnEvent,
} from "./turn-events";

const createdAt = "2026-08-29T00:00:00.000Z";
const artifactId = "art_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const sourceArtifactId = "art_01ARZ3NDEKTSV4RRFFQ69G5FAB";

function modelMessage(
  overrides: Partial<TrueForgeApi.ModelMessageEvent> = {},
): TrueForgeApi.ModelMessageEvent {
  return {
    type: "model.message",
    id: "message-1",
    threadId: "main",
    createdAt,
    ...overrides,
  };
}

function directToolCall(
  overrides: Partial<TrueForgeApi.ToolCall> = {},
): TrueForgeApi.ToolCall {
  return {
    id: "call-1",
    type: "function",
    function: {
      name: "run_read_query",
      arguments: JSON.stringify({ password: "do-not-stream", rows: [1, 2] }),
    },
    toolInfo: {
      type: "mcp",
      name: "run_read_query",
      serverId: "internal-server-id",
      serverName: "forty-two-data-source",
    },
    ...overrides,
  };
}

function turnDone(
  state: TrueForgeApi.TurnDoneEventState = {
    status: "done",
    completedAt: "2026-08-29T00:00:03.000Z",
    output: null,
    requiredActions: [],
  },
): TrueForgeApi.TurnDoneEvent {
  return {
    type: "turn.done",
    id: "turn-done",
    threadId: null,
    createdAt: "2026-08-29T00:00:03.000Z",
    state,
  };
}

test("normalizes live and persisted assistant messages without reasoning", () => {
  const state = createTurnEventState();
  const output = [
    ...normalizeTurnEvent(
      modelMessage({ reasoningContent: "hidden chain of thought" }),
      state,
    ),
    ...normalizeTurnEvent(
      {
        type: "model.message.delta",
        id: "message-1",
        threadId: "main",
        createdAt: "2026-08-29T00:00:00.100Z",
        content: "Hello ",
        reasoningContent: "still hidden",
      },
      state,
    ),
    ...normalizeTurnEvent(
      {
        type: "model.message.delta",
        id: "message-1",
        threadId: "main",
        createdAt: "2026-08-29T00:00:00.200Z",
        content: "world",
        finishReason: "stop",
      },
      state,
    ),
  ];
  assert.deepEqual(
    output.map(({ type }) => type),
    [
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.delta",
      "assistant.message.completed",
    ],
  );
  assert.equal(
    output
      .filter(
        (
          event,
        ): event is Extract<
          NormalizedTurnEvent,
          { type: "assistant.message.delta" }
        > => event.type === "assistant.message.delta",
      )
      .map(({ text }) => text)
      .join(""),
    "Hello world",
  );
  assert.doesNotMatch(JSON.stringify(output), /hidden|reasoning/i);

  const persisted = normalizeTurnHistory([
    {
      turnId: "turn-1",
      event: modelMessage({
        content: [
          { type: "text", text: "Persisted answer" },
          { type: "refusal", refusal: "private refusal detail" },
        ],
        finishReason: "stop",
        reasoningContent: "private reasoning",
      }),
    },
  ]);
  assert.deepEqual(
    persisted.map(({ type }) => type),
    [
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed",
    ],
  );
  assert.match(JSON.stringify(persisted), /Persisted answer/);
  assert.doesNotMatch(JSON.stringify(persisted), /private|refusal|reasoning/i);
});

test("emits ordered tool lifecycle with a safe result summary and no raw response", () => {
  const state = createTurnEventState();
  const started = normalizeTurnEvent(
    modelMessage({ toolCalls: [directToolCall()] }),
    state,
  );
  const completed = normalizeTurnEvent(
    {
      type: "tool.response",
      id: "response-1",
      threadId: "main",
      createdAt: "2026-08-29T00:00:01.000Z",
      toolCallId: "call-1",
      content: JSON.stringify({
        rows: [{ customer_email: "private@example.com" }],
        bytes: "AAECAwQ=",
        password: "response-secret",
      }),
    },
    state,
  );
  assert.deepEqual(
    started.map(({ type }) => type),
    ["assistant.message.started", "tool.started"],
  );
  assert.deepEqual(completed, [
    {
      type: "tool.completed",
      toolCallId: "call-1",
      threadId: "main",
      tool: {
        kind: "mcp",
        name: "run_read_query",
        serverName: "forty-two-data-source",
      },
      outcome: "success",
      summary: "Returned 1 row",
    },
  ]);
  const serialized = JSON.stringify([...started, ...completed]);
  assert.doesNotMatch(
    serialized,
    /do-not-stream|private@example|AAECAwQ|response-secret|internal-server-id|rows/i,
  );
});

test("reports a safe Daytona sandbox outcome for system execution", () => {
  const state = createTurnEventState();
  normalizeTurnEvent(
    modelMessage({
      toolCalls: [
        directToolCall({
          id: "call-exec",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "private command" }),
          },
          toolInfo: { type: "truefoundry-system", name: "exec" },
        }),
      ],
    }),
    state,
  );

  const completed = normalizeTurnEvent(
    {
      type: "tool.response",
      id: "response-exec",
      threadId: "main",
      createdAt: "2026-08-29T00:00:01.000Z",
      toolCallId: "call-exec",
      content: JSON.stringify({ stdout: "private output" }),
    },
    state,
  );

  assert.deepEqual(completed, [
    {
      type: "tool.completed",
      toolCallId: "call-exec",
      threadId: "main",
      tool: { kind: "system", name: "exec" },
      outcome: "success",
      summary: "Sandbox task completed",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(completed), /private|stdout|command/i);
});

test("emits only a strict artifact receipt from a wrapped artifact tool", () => {
  const state = createTurnEventState();
  const wrapped = directToolCall({
    id: "call-artifact",
    function: {
      name: "call_tool",
      arguments: JSON.stringify({
        mcp_server: "forty-two-data-source",
        tool_name: "finalize_chart_artifact",
        input: {
          uploadUrl:
            "https://account.blob.core.windows.net/a?sv=1&se=2&sp=w&sr=b&sig=SECRET",
          password: "argument-secret",
          rows: [{ confidential: true }],
        },
      }),
    },
    toolInfo: { type: "truefoundry-system", name: "call_tool" },
  });
  const started = normalizeTurnEvent(
    modelMessage({ toolCalls: [wrapped] }),
    state,
  );
  const completed = normalizeTurnEvent(
    {
      type: "tool.response",
      id: "response-artifact",
      threadId: "main",
      createdAt: "2026-08-29T00:00:01.000Z",
      toolCallId: "call-artifact",
      content: JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              artifactId,
              schemaVersion: "chart.v1",
              sourceArtifactId,
              config: { secret: "raw-config" },
              preview: [{ private: "row" }],
            }),
          },
        ],
      }),
    },
    state,
  );
  assert.deepEqual(
    started.find(({ type }) => type === "tool.started"),
    {
      type: "tool.started",
      toolCallId: "call-artifact",
      sourceMessageId: "message-1",
      threadId: "main",
      tool: {
        kind: "mcp",
        name: "finalize_chart_artifact",
        serverName: "forty-two-data-source",
      },
    },
  );
  assert.deepEqual(completed.at(-1), {
    type: "artifact.created",
    toolCallId: "call-artifact",
    artifact: {
      id: artifactId,
      kind: "chart",
      schemaVersion: "chart.v1",
      sourceArtifactId,
    },
  });
  assert.doesNotMatch(
    JSON.stringify([...started, ...completed]),
    /SECRET|argument-secret|raw-config|private|preview|uploadUrl|rows/i,
  );
});

test("requires exact shared-MCP artifact provenance", () => {
  const receipt = JSON.stringify({
    artifactId,
    schemaVersion: "table.v1",
    rowCount: 3,
  });
  const cases: Array<{ name: string; call: TrueForgeApi.ToolCall }> = [
    {
      name: "wrong direct server",
      call: directToolCall({
        id: "call-wrong-server",
        function: {
          name: "finalize_table_artifact",
          arguments: "{}",
        },
        toolInfo: {
          type: "mcp",
          name: "finalize_table_artifact",
          serverId: "evil",
          serverName: "attacker-controlled",
        },
      }),
    },
    {
      name: "mismatched direct function",
      call: directToolCall({
        id: "call-mismatched-function",
        function: { name: "other_tool", arguments: "{}" },
        toolInfo: {
          type: "mcp",
          name: "finalize_table_artifact",
          serverId: "shared",
          serverName: "forty-two-data-source",
        },
      }),
    },
    {
      name: "wrong system tool",
      call: directToolCall({
        id: "call-wrong-system",
        function: {
          name: "exec",
          arguments: JSON.stringify({
            mcp_server: "forty-two-data-source",
            tool_name: "finalize_table_artifact",
            input: {},
          }),
        },
        toolInfo: { type: "truefoundry-system", name: "exec" },
      }),
    },
    {
      name: "wrong wrapped server",
      call: directToolCall({
        id: "call-wrong-wrapper-server",
        function: {
          name: "call_tool",
          arguments: JSON.stringify({
            mcp_server: "attacker-controlled",
            tool_name: "finalize_table_artifact",
            input: {},
          }),
        },
        toolInfo: { type: "truefoundry-system", name: "call_tool" },
      }),
    },
  ];

  for (const { name, call } of cases) {
    const state = createTurnEventState();
    normalizeTurnEvent(modelMessage({ toolCalls: [call] }), state);
    const response = normalizeTurnEvent(
      {
        type: "tool.response",
        id: `response-${call.id}`,
        threadId: "main",
        createdAt: "2026-08-29T00:00:01.000Z",
        toolCallId: call.id,
        content: receipt,
      },
      state,
    );
    assert.equal(
      response.some(({ type }) => type === "artifact.created"),
      false,
      name,
    );
  }

  const exactState = createTurnEventState();
  const exact = directToolCall({
    id: "call-exact-direct",
    function: { name: "finalize_table_artifact", arguments: "{}" },
    toolInfo: {
      type: "mcp",
      name: "finalize_table_artifact",
      serverId: "shared",
      serverName: "forty-two-data-source",
    },
  });
  normalizeTurnEvent(modelMessage({ toolCalls: [exact] }), exactState);
  assert.equal(
    normalizeTurnEvent(
      {
        type: "tool.response",
        id: "response-exact-direct",
        threadId: "main",
        createdAt: "2026-08-29T00:00:01.000Z",
        toolCallId: exact.id,
        content: receipt,
      },
      exactState,
    ).some(({ type }) => type === "artifact.created"),
    true,
  );
});

test("normalizes approval references without tool arguments", () => {
  const state = createTurnEventState();
  normalizeTurnEvent(
    modelMessage({
      id: "approval-source",
      toolCalls: [
        directToolCall({
          id: "call-approval",
          function: {
            name: "apply_sql_change",
            arguments: JSON.stringify({ canonicalSql: "UPDATE private" }),
          },
          toolInfo: {
            type: "mcp",
            name: "apply_sql_change",
            serverId: "hidden",
            serverName: "forty-two-data-source",
          },
        }),
      ],
    }),
    state,
  );
  const output = normalizeTurnEvent(
    {
      type: "tool.approval_required",
      id: "approval-event",
      threadId: "main",
      createdAt: "2026-08-29T00:00:01.000Z",
      toolCalls: [{ id: "call-approval", sourceEventId: "approval-source" }],
    },
    state,
  );
  assert.deepEqual(output, [
    {
      type: "approval.required",
      sourceEventId: "approval-event",
      threadId: "main",
      toolCalls: [
        {
          toolCallId: "call-approval",
          sourceMessageId: "approval-source",
          tool: {
            kind: "mcp",
            name: "apply_sql_change",
            serverName: "forty-two-data-source",
          },
        },
      ],
      truncated: false,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(output), /UPDATE|canonicalSql|hidden/);
});

test("keeps plan optimistic and reconciled events safe and ordered", () => {
  const state = createTurnEventState();
  const planCall = directToolCall({
    id: "call-plan",
    function: {
      name: "plan",
      arguments: JSON.stringify({
        sessionId: "session-1",
        action: "set",
        title: `Inspect password=super-secret ${"x".repeat(2_000)}`,
        items: [{ text: "Check Bearer abcdefghijklmnop", status: "pending" }],
      }),
    },
    toolInfo: {
      type: "mcp",
      name: "plan",
      serverId: "todo-server",
      serverName: "forty-two-todo",
    },
  });
  const optimistic = normalizeTurnEvent(
    modelMessage({ toolCalls: [planCall] }),
    state,
  );
  const reconciled = normalizeTurnEvent(
    {
      type: "tool.response",
      id: "plan-response",
      threadId: "main",
      createdAt: "2026-08-29T00:00:01.000Z",
      toolCallId: "call-plan",
      content: JSON.stringify({
        plan: {
          title: "Inspect token=canonical-secret",
          items: [
            {
              text: "Check",
              status: "completed",
              summary: "api_key=summary-secret",
            },
          ],
        },
        revision: 4,
        updatedAt: "2026-08-29T00:00:01.000Z",
      }),
    },
    state,
  );
  assert.deepEqual(
    optimistic.map(({ type }) => type),
    ["assistant.message.started", "tool.started", "plan.optimistic"],
  );
  assert.deepEqual(
    reconciled.map(({ type }) => type),
    ["tool.completed", "plan.reconciled"],
  );
  const serialized = JSON.stringify([...optimistic, ...reconciled]);
  assert.doesNotMatch(
    serialized,
    /super-secret|canonical-secret|summary-secret|abcdefghijklmnop/,
  );
  assert.ok(serialized.length < 5_000, "Plan events were not bounded.");
});

test("emits deterministic completed, error, and cancelled terminal events", () => {
  const doneState = createTurnEventState();
  normalizeTurnEvent(modelMessage(), doneState);
  assert.deepEqual(
    normalizeTurnEvent(turnDone(), doneState).map(({ type }) => type),
    ["assistant.message.completed", "turn.completed"],
  );

  const failed = normalizeTurnEvent(
    turnDone({
      status: "error",
      completedAt: "2026-08-29T00:00:03.000Z",
      message: "Failed password=error-secret",
    }),
    createTurnEventState(),
  );
  assert.deepEqual(failed, [
    {
      type: "turn.failed",
      sourceEventId: "turn-done",
      completedAt: "2026-08-29T00:00:03.000Z",
      reason: "error",
      message: "Failed password=[redacted]",
    },
  ]);

  assert.deepEqual(
    normalizeTurnEvent(
      turnDone({
        status: "cancelled",
        completedAt: "2026-08-29T00:00:03.000Z",
        reason: "client-cancelled",
      }),
      createTurnEventState(),
    ),
    [
      {
        type: "turn.failed",
        sourceEventId: "turn-done",
        completedAt: "2026-08-29T00:00:03.000Z",
        reason: "cancelled",
        message: "The turn was cancelled.",
      },
    ],
  );
});

test("redacts credentials and signed URLs and bounds assistant text", () => {
  const text = safeText(
    [
      "Bearer abcdefghijklmnop",
      "sk-proj-abcdefghijklmnopqrstuvwxyz",
      "password=hunter2",
      "postgresql://analyst:db-secret@db.example/test",
      "https://acct.blob.core.windows.net/file?sv=1&se=2&sp=r&sr=b&sig=signed-secret",
      "z".repeat(20_000),
    ].join(" "),
    1_000,
  );
  assert.doesNotMatch(
    text,
    /abcdefghijklmnop|abcdefghijklmnopqrstuvwxyz|hunter2|db-secret|signed-secret/,
  );
  assert.match(text, /\[redacted-signed-url\]/);
  assert.equal(text.length, 1_000);
  assert.match(text, /…$/);
});

test("redacts complete Basic, bearer, authorization, and password forms", () => {
  const secrets = [
    "dXNlcjpwYXNzd29yZA==",
    "bearer.secret/value==",
    "quoted bearer secret with spaces",
    "quoted password remainder with spaces",
    "unquoted password remainder with spaces",
  ];
  const text = safeText(
    [
      `Basic ${secrets[0]}`,
      `Bearer ${secrets[1]}`,
      `Authorization: Bearer "${secrets[2]}"`,
      `password = "${secrets[3]}"`,
      `passwd: ${secrets[4]}`,
    ].join("\n"),
    2_000,
  );
  for (const secret of secrets) assert.equal(text.includes(secret), false);
  assert.doesNotMatch(text, /d29yZA|secret\/value|remainder with spaces/);
  assert.match(text, /Basic \[redacted\]/);
  assert.match(text, /Bearer \[redacted\]/);
});

test("redacts project secret assignments and Azure AccountKey values", () => {
  const secrets = [
    "azure-connection-secret==",
    "azure-account-secret==",
    "aws-access-secret",
    "mcp-signing-secret",
    "custom-token-secret",
    "custom-service-secret",
    "custom-password-secret",
    "standalone-account-key==",
  ];
  const text = safeText(
    [
      `AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${secrets[0]};EndpointSuffix=core.windows.net`,
      `AZURE_STORAGE_ACCOUNT_KEY='${secrets[1]}'`,
      `AWS_SECRET_ACCESS_KEY=${secrets[2]}`,
      `MCP_CAPABILITY_SIGNING_KEY: "${secrets[3]}"`,
      `CUSTOM_SERVICE_TOKEN=${secrets[4]}`,
      `custom_service_secret='${secrets[5]}'`,
      `REPORT_PASSWORD=${secrets[6]}`,
      `AccountKey=${secrets[7]};EndpointSuffix=core.windows.net`,
    ].join("\n"),
    4_000,
  );

  for (const secret of secrets) assert.equal(text.includes(secret), false);
  assert.doesNotMatch(
    text,
    /DefaultEndpointsProtocol|access-secret|signing-secret/,
  );
  assert.match(text, /AZURE_STORAGE_CONNECTION_STRING=\[redacted\]/);
  assert.match(text, /MCP_CAPABILITY_SIGNING_KEY=\[redacted\]/);
  assert.match(text, /AccountKey=\[redacted\]/);
});

test("rejects oversized tool envelopes before parsing them", () => {
  const state = createTurnEventState();
  const oversizedPlan = directToolCall({
    id: "call-oversized-plan",
    function: {
      name: "plan",
      arguments: JSON.stringify({
        action: "set",
        title: "x".repeat(70_000),
        items: [],
      }),
    },
    toolInfo: {
      type: "mcp",
      name: "plan",
      serverId: "todo-server",
      serverName: "forty-two-todo",
    },
  });
  const started = normalizeTurnEvent(
    modelMessage({ toolCalls: [oversizedPlan] }),
    state,
  );
  assert.deepEqual(
    started.map(({ type }) => type),
    ["assistant.message.started", "tool.started"],
  );

  const response = normalizeTurnEvent(
    {
      type: "tool.response",
      id: "oversized-response",
      threadId: "main",
      createdAt: "2026-08-29T00:00:01.000Z",
      toolCallId: "call-oversized-plan",
      content: `{"artifactId":"${artifactId}","padding":"${"y".repeat(70_000)}"}`,
    },
    state,
  );
  assert.deepEqual(
    response.map(({ type }) => type),
    ["tool.completed"],
  );
  assert.ok(JSON.stringify([...started, ...response]).length < 2_000);
});

test("history normalization sorts persisted events and never emits tool payloads", () => {
  const call = modelMessage({
    id: "message-history",
    createdAt: "2026-08-29T00:00:00.000Z",
    content: "Answer",
    finishReason: "stop",
    toolCalls: [directToolCall({ id: "call-history" })],
  });
  const response: TrueForgeApi.ToolResponseEvent = {
    type: "tool.response",
    id: "response-history",
    threadId: "main",
    createdAt: "2026-08-29T00:00:01.000Z",
    toolCallId: "call-history",
    content: JSON.stringify({ rows: [{ secret: true }] }),
  };
  const history = normalizeTurnHistory([
    { turnId: "turn-1", event: response },
    { turnId: "turn-1", event: call },
    { turnId: "turn-1", event: turnDone() },
  ]);
  assert.deepEqual(
    history.map(({ type }) => type),
    [
      "assistant.message.started",
      "assistant.message.delta",
      "tool.started",
      "assistant.message.completed",
      "tool.completed",
      "turn.completed",
    ],
  );
  assert.doesNotMatch(JSON.stringify(history), /rows|secret/);
});

test("public history payload contains normalized events only", () => {
  const rawResponse: TrueForgeApi.ToolResponseEvent = {
    type: "tool.response",
    id: "raw-response",
    threadId: "main",
    createdAt: "2026-08-29T00:00:01.000Z",
    toolCallId: "call-history",
    content: JSON.stringify({
      rows: [{ password: "must-never-be-public" }],
      bytes: "AAECAwQ=",
    }),
  };
  const payload = normalizedTurnHistoryPayload([
    {
      turnId: "turn-1",
      event: modelMessage({
        id: "message-history",
        toolCalls: [directToolCall({ id: "call-history" })],
      }),
    },
    { turnId: "turn-1", event: rawResponse },
  ]);
  assert.strictEqual(payload.data, payload.normalizedEvents);
  assert.deepEqual(
    payload.data.map(({ type }) => type),
    ["assistant.message.started", "tool.started", "tool.completed"],
  );
  assert.deepEqual(payload.planEvents, []);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /must-never-be-public|AAECAwQ|rows|bytes/);
  assert.doesNotMatch(serialized, /"event"\s*:/);
});

test("parses native and product resume cursors and rejects ambiguity", () => {
  assert.deepEqual(
    turnStreamCursor(
      new Request("https://example.test/events", {
        headers: { "Last-Event-ID": "42:3" },
      }),
    ),
    { resume: { sequenceNumber: 42, eventIndex: 3 } },
  );
  assert.deepEqual(
    turnStreamCursor(
      new Request("https://example.test/events?afterSequenceNumber=41"),
    ),
    {
      resume: {
        sequenceNumber: 41,
        eventIndex: Number.MAX_SAFE_INTEGER,
      },
    },
  );
  assert.deepEqual(
    turnStreamCursor(
      new Request("https://example.test/events", {
        headers: { "Last-Event-ID": "40" },
      }),
    ),
    {
      resume: {
        sequenceNumber: 40,
        eventIndex: Number.MAX_SAFE_INTEGER,
      },
    },
  );
  assert.throws(
    () =>
      turnStreamCursor(
        new Request(
          "https://example.test/events?afterSequenceNumber=1&after_sequence_number=2",
        ),
      ),
    /Conflicting/,
  );
  assert.throws(
    () =>
      turnStreamCursor(
        new Request("https://example.test/events", {
          headers: { "Last-Event-ID": "12:not-a-number" },
        }),
      ),
    /Invalid/,
  );
});

test("SSE preserves source ordering and uses resumable per-event ids", async () => {
  const events: Array<
    UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
  > = [
    {
      id: "10",
      data: modelMessage({ content: "Hello", finishReason: "stop" }),
    },
    { id: "11", data: turnDone() },
  ];
  const text = await new Response(
    createNormalizedTurnEventStream(asAsync(events)),
  ).text();
  const blocks = parseSse(text);
  assert.deepEqual(
    blocks.map(({ id }) => id),
    ["10:0", "10:1", "10:2", "11:0"],
  );
  assert.deepEqual(
    blocks.map(({ event }) => event),
    ["assistant", "assistant", "assistant", "turn"],
  );
  assert.deepEqual(
    blocks.map(({ data }) => data.type),
    [
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed",
      "turn.completed",
    ],
  );
});

test("external replay rebuilds state, suppresses seen events, and reconciles later events", async () => {
  const call = directToolCall({
    id: "call-replay",
    function: {
      name: "finalize_table_artifact",
      arguments: JSON.stringify({ password: "never-stream" }),
    },
    toolInfo: {
      type: "mcp",
      name: "finalize_table_artifact",
      serverId: "hidden",
      serverName: "forty-two-data-source",
    },
  });
  const events: Array<
    UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
  > = [
    { id: "20", data: modelMessage({ toolCalls: [call] }) },
    {
      id: "21",
      data: {
        type: "tool.response",
        id: "artifact-response",
        threadId: "main",
        createdAt: "2026-08-29T00:00:01.000Z",
        toolCallId: "call-replay",
        content: JSON.stringify({
          artifactId,
          schemaVersion: "table.v1",
          rowCount: 12,
          preview: [{ password: "raw-row" }],
        }),
      },
    },
    { id: "22", data: turnDone() },
  ];
  const text = await new Response(
    createNormalizedTurnEventStream(asAsync(events), {
      resume: { sequenceNumber: 20, eventIndex: 1 },
    }),
  ).text();
  const blocks = parseSse(text);
  assert.deepEqual(
    blocks.map(({ id }) => id),
    ["21:0", "21:1", "22:0", "22:1"],
  );
  assert.deepEqual(
    blocks.map(({ data }) => data.type),
    [
      "tool.completed",
      "artifact.created",
      "assistant.message.completed",
      "turn.completed",
    ],
  );
  const artifactEvent = blocks[1]?.data;
  assert.equal(artifactEvent?.type, "artifact.created");
  if (artifactEvent?.type !== "artifact.created") {
    throw new Error("Expected a normalized artifact event.");
  }
  assert.equal(artifactEvent.artifact.rowCount, 12);
  assert.doesNotMatch(text, /never-stream|raw-row|preview|hidden/);
});

test("numeric native cursor rebuilds tool state before resuming", async () => {
  const call = directToolCall({
    id: "call-native-replay",
    function: { name: "finalize_table_artifact", arguments: "{}" },
    toolInfo: {
      type: "mcp",
      name: "finalize_table_artifact",
      serverId: "shared",
      serverName: "forty-two-data-source",
    },
  });
  const cursor = turnStreamCursor(
    new Request("https://example.test/events", {
      headers: { "Last-Event-ID": "30" },
    }),
  );
  const text = await new Response(
    createNormalizedTurnEventStream(
      asAsync([
        { id: "30", data: modelMessage({ toolCalls: [call] }) },
        {
          id: "31",
          data: {
            type: "tool.response" as const,
            id: "native-response",
            threadId: "main",
            createdAt: "2026-08-29T00:00:01.000Z",
            toolCallId: call.id,
            content: JSON.stringify({
              artifactId,
              schemaVersion: "table.v1",
              rowCount: 5,
            }),
          },
        },
        { id: "32", data: turnDone() },
      ]),
      { resume: cursor.resume },
    ),
  ).text();
  assert.deepEqual(
    parseSse(text).map(({ data }) => data.type),
    [
      "tool.completed",
      "artifact.created",
      "assistant.message.completed",
      "turn.completed",
    ],
  );
});

test("cancelling the browser stream closes the upstream iterator", async () => {
  let returned = false;
  let index = 0;
  const source: AsyncIterable<
    UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
  > = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          index += 1;
          return {
            done: false as const,
            value: {
              id: String(index),
              data: modelMessage({ id: `message-${index}` }),
            },
          };
        },
        async return() {
          returned = true;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  const reader = createNormalizedTurnEventStream(source).getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel();
  assert.equal(returned, true);
});

test("a replay cursor at the terminal frame closes without waiting upstream", async () => {
  let returned = false;
  const source: AsyncIterable<
    UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
  > = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({
          done: false,
          value: { id: "42", data: turnDone() },
        }),
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const text = await new Response(
    createNormalizedTurnEventStream(source, {
      resume: { sequenceNumber: 42, eventIndex: Number.MAX_SAFE_INTEGER },
    }),
  ).text();
  assert.equal(text, "");
  assert.equal(returned, true);
});

test("next and abort errors always close the upstream iterator", async () => {
  for (const aborted of [false, true]) {
    let returned = false;
    const abort = new AbortController();
    const source: AsyncIterable<
      UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
    > = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<
            IteratorResult<
              UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
            >
          > {
            if (aborted) abort.abort();
            throw new Error(aborted ? "aborted upstream" : "broken upstream");
          },
          async return() {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const reader = createNormalizedTurnEventStream(source, {
      signal: abort.signal,
    }).getReader();
    if (aborted) {
      assert.deepEqual(await reader.read(), { done: true, value: undefined });
    } else {
      await assert.rejects(reader.read(), /broken upstream/);
    }
    assert.equal(returned, true);
  }
});

test("cleanup errors cannot replace successful stream completion", async () => {
  let naturalReturned = 0;
  const naturalSource: AsyncIterable<
    UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
  > = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true as const, value: undefined };
        },
        async return() {
          naturalReturned += 1;
          throw new Error("natural cleanup failure");
        },
      };
    },
  };
  assert.equal(
    await new Response(createNormalizedTurnEventStream(naturalSource)).text(),
    "",
  );
  assert.equal(naturalReturned, 1);

  let terminalReturned = 0;
  const terminalSource: AsyncIterable<
    UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
  > = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: false as const, value: { id: "1", data: turnDone() } };
        },
        async return() {
          terminalReturned += 1;
          throw new Error("terminal cleanup failure");
        },
      };
    },
  };
  const terminalText = await new Response(
    createNormalizedTurnEventStream(terminalSource),
  ).text();
  assert.deepEqual(
    parseSse(terminalText).map(({ data }) => data.type),
    ["turn.completed"],
  );
  assert.equal(terminalReturned, 1);
});

test("original next and body errors remain primary when cleanup also fails", async () => {
  for (const failure of ["next", "body"] as const) {
    let returned = 0;
    const source: AsyncIterable<
      UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
    > = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<
            IteratorResult<
              UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>
            >
          > {
            if (failure === "next") throw new Error("original next failure");
            const value =
              {} as UpstreamServerSentEvent<TrueForgeApi.TurnStreamingEvent>;
            Object.defineProperty(value, "data", {
              get() {
                throw new Error("original body failure");
              },
            });
            return { done: false, value };
          },
          async return() {
            returned += 1;
            throw new Error("cleanup failure");
          },
        };
      },
    };
    await assert.rejects(
      new Response(createNormalizedTurnEventStream(source)).text(),
      new RegExp(`original ${failure} failure`),
    );
    assert.equal(returned, 1);
  }
});

test("bounds every public id and uses a bounded terminal timestamp fallback", () => {
  const longSecretId = `password=${"s".repeat(500)}`;
  const state = createTurnEventState();
  const started = normalizeTurnEvent(
    modelMessage({
      id: longSecretId,
      threadId: longSecretId,
      createdAt: "invalid",
      toolCalls: [directToolCall({ id: longSecretId })],
    }),
    state,
  );
  const terminal = normalizeTurnEvent(
    {
      ...turnDone(),
      id: longSecretId,
      createdAt: "x".repeat(10_000),
      state: {
        status: "error",
        completedAt: "also-invalid",
        message: "failed",
      },
    },
    state,
  );
  const publicIds = [...started, ...terminal].flatMap((event) => {
    if (
      event.type === "assistant.message.started" ||
      event.type === "assistant.message.delta" ||
      event.type === "assistant.message.completed"
    ) {
      return [event.messageId];
    }
    if (event.type === "tool.started") {
      return [event.toolCallId, event.sourceMessageId];
    }
    if (event.type === "turn.failed") return [event.sourceEventId];
    return [];
  });
  assert.equal(
    publicIds.every((id) => id.length <= 120),
    true,
  );
  assert.doesNotMatch(JSON.stringify(publicIds), /s{20}/);
  const failed = terminal.find(({ type }) => type === "turn.failed");
  assert.equal(failed?.type, "turn.failed");
  if (failed?.type !== "turn.failed") throw new Error("Expected turn failure.");
  assert.equal(failed.completedAt, "1970-01-01T00:00:00.000Z");
});

function asAsync<T>(values: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

function parseSse(text: string): Array<{
  id: string | null;
  event: string;
  data: NormalizedTurnEvent;
}> {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const id =
        lines.find((line) => line.startsWith("id: "))?.slice(4) ?? null;
      const event = lines.find((line) => line.startsWith("event: "))!.slice(7);
      const data = JSON.parse(
        lines.find((line) => line.startsWith("data: "))!.slice(6),
      ) as NormalizedTurnEvent;
      return { id, event, data };
    });
}
