import assert from "node:assert/strict";
import test from "node:test";

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

import {
  createPlanEventState,
  normalizePlanEvent,
  normalizePlanHistory,
} from "./plan-events";

const planCall = {
  type: "model.message",
  id: "event-1",
  threadId: "main",
  createdAt: "2026-08-28T00:00:00.000Z",
  toolCalls: [
    {
      id: "call-plan",
      type: "function",
      function: {
        name: "plan",
        arguments: JSON.stringify({
          sessionId: "sess_01HZX000000000000000000000",
          action: "set",
          title: "Review",
          items: [{ text: "Inspect" }],
        }),
      },
      toolInfo: {
        type: "mcp",
        name: "plan",
        serverId: "server-1",
        serverName: "forty-two-todo",
      },
    },
  ],
} as TrueForgeApi.ModelMessageEvent;

const wrappedPlanCall = {
  ...planCall,
  id: "event-wrapped",
  toolCalls: [
    {
      ...planCall.toolCalls![0]!,
      id: "call-plan-wrapped",
      function: {
        name: "call_tool",
        arguments: JSON.stringify({
          mcp_server: "forty-two-todo",
          tool_name: "plan",
          input: {
            sessionId: "sess_01HZX000000000000000000000",
            action: "update_item",
            itemIndex: 0,
            status: "completed",
            summary: "Inspected",
          },
        }),
      },
      toolInfo: { type: "truefoundry-system", name: "call_tool" },
    },
  ],
} as TrueForgeApi.ModelMessageEvent;

test("normalizes optimistic plan calls then authoritative MCP responses", () => {
  const state = createPlanEventState();
  const optimistic = normalizePlanEvent(planCall, state);
  assert.equal(optimistic[0]?.type, "plan.optimistic");
  assert.equal(state.pending.has("call-plan"), true);

  const reconciled = normalizePlanEvent(
    {
      type: "tool.response",
      id: "event-2",
      threadId: "main",
      toolCallId: "call-plan",
      createdAt: "2026-08-28T00:00:01.000Z",
      content: JSON.stringify({
        plan: {
          title: "Review",
          items: [{ text: "Inspect", status: "pending" }],
        },
        revision: 7,
        updatedAt: "2026-08-28T00:00:01.000Z",
      }),
    },
    state,
  );
  assert.deepEqual(reconciled, [
    {
      type: "plan.reconciled",
      toolCallId: "call-plan",
      snapshot: {
        plan: {
          title: "Review",
          items: [{ text: "Inspect", status: "pending" }],
        },
        revision: 7,
        updatedAt: "2026-08-28T00:00:01.000Z",
      },
    },
  ]);
});

test("normalizes only the exact wrapped Todo plan envelope", () => {
  const state = createPlanEventState();
  const optimistic = normalizePlanEvent(wrappedPlanCall, state);
  assert.deepEqual(optimistic, [
    {
      type: "plan.optimistic",
      toolCallId: "call-plan-wrapped",
      arguments: {
        sessionId: "sess_01HZX000000000000000000000",
        action: "update_item",
        itemIndex: 0,
        status: "completed",
        summary: "Inspected",
      },
    },
  ]);

  const extraKey = structuredClone(wrappedPlanCall);
  const outer = JSON.parse(extraKey.toolCalls![0]!.function.arguments);
  extraKey.toolCalls![0]!.function.arguments = JSON.stringify({
    ...outer,
    approved: true,
  });
  assert.deepEqual(normalizePlanEvent(extraKey, createPlanEventState()), []);

  const wrongServer = structuredClone(wrappedPlanCall);
  const wrongOuter = JSON.parse(wrongServer.toolCalls![0]!.function.arguments);
  wrongServer.toolCalls![0]!.function.arguments = JSON.stringify({
    ...wrongOuter,
    mcp_server: "forty-two-data-source",
  });
  assert.deepEqual(normalizePlanEvent(wrongServer, createPlanEventState()), []);
});

test("ignores datasource calls and supports canonical history normalization", () => {
  const datasourceCall = structuredClone(planCall);
  const call = datasourceCall.toolCalls![0]!;
  assert.equal(call.toolInfo.type, "mcp");
  if (call.toolInfo.type !== "mcp") throw new Error("Expected an MCP call.");
  call.toolInfo.serverName = "forty-two-data-source";
  assert.deepEqual(
    normalizePlanEvent(datasourceCall, createPlanEventState()),
    [],
  );
  assert.equal(
    normalizePlanHistory([
      {
        turnId: "turn-1",
        event: {
          type: "tool.response",
          id: "event-2",
          threadId: "main",
          toolCallId: "call-plan",
          createdAt: "2026-08-28T00:00:01.000Z",
          content: JSON.stringify({ plan: null, revision: 8, updatedAt: null }),
        },
      },
      { turnId: "turn-1", event: planCall },
    ]).length,
    2,
  );
});

test("assembles streaming tool-call deltas before normalizing", () => {
  const state = createPlanEventState();
  const base = { ...planCall, toolCalls: undefined };
  assert.deepEqual(normalizePlanEvent(base, state), []);
  assert.deepEqual(
    normalizePlanEvent(
      {
        type: "model.message.delta",
        id: base.id,
        threadId: "main",
        createdAt: "2026-08-28T00:00:00.100Z",
        toolCalls: [
          {
            index: 0,
            id: "call-plan",
            type: "function",
            function: { name: "plan", arguments: "" },
            toolInfo: planCall.toolCalls![0]!.toolInfo,
          },
        ],
      },
      state,
    ),
    [],
  );
  const complete = normalizePlanEvent(
    {
      type: "model.message.delta",
      id: base.id,
      threadId: "main",
      createdAt: "2026-08-28T00:00:00.200Z",
      toolCalls: [
        {
          index: 0,
          function: {
            arguments: planCall.toolCalls![0]!.function.arguments,
          },
        },
      ],
    },
    state,
  );
  assert.equal(complete[0]?.type, "plan.optimistic");
  assert.equal(state.pending.has("call-plan"), true);
});

test("malformed Todo snapshots fail closed without throwing", () => {
  for (const [name, snapshot] of Object.entries({
    malformedPlan: {
      plan: { title: 42, items: "not-an-array" },
      revision: 1,
      updatedAt: null,
    },
    malformedItem: {
      plan: {
        title: "Plan",
        items: [{ text: "Item", status: "invented" }],
      },
      revision: 1,
      updatedAt: null,
    },
    negativeRevision: { plan: null, revision: -1, updatedAt: null },
    invalidTimestamp: {
      plan: null,
      revision: 1,
      updatedAt: "not-a-timestamp",
    },
  })) {
    const state = createPlanEventState();
    normalizePlanEvent(planCall, state);
    assert.doesNotThrow(() =>
      normalizePlanEvent(
        {
          type: "tool.response",
          id: `response-${name}`,
          threadId: "main",
          toolCallId: "call-plan",
          createdAt: "2026-08-28T00:00:01.000Z",
          content: JSON.stringify(snapshot),
        },
        state,
      ),
    );

    const retryState = createPlanEventState();
    normalizePlanEvent(planCall, retryState);
    assert.deepEqual(
      normalizePlanEvent(
        {
          type: "tool.response",
          id: `response-${name}`,
          threadId: "main",
          toolCallId: "call-plan",
          createdAt: "2026-08-28T00:00:01.000Z",
          content: JSON.stringify(snapshot),
        },
        retryState,
      ),
      [
        {
          type: "plan.failed",
          toolCallId: "call-plan",
          message: "The plan tool did not return canonical state.",
        },
      ],
    );
  }
});

test("approval-required plan calls fail once and leave pending state", () => {
  const state = createPlanEventState();
  normalizePlanEvent(planCall, state);
  const failed = normalizePlanEvent(
    {
      type: "tool.approval_required",
      id: "approval-1",
      threadId: "main",
      createdAt: "2026-08-28T00:00:00.500Z",
      toolCalls: [{ id: "call-plan", sourceEventId: "event-1" }],
    } as TrueForgeApi.ToolApprovalRequiredEvent,
    state,
  );
  assert.equal(failed[0]?.type, "plan.failed");
  assert.equal(state.pending.has("call-plan"), false);
  assert.deepEqual(
    normalizePlanEvent(
      {
        type: "tool.response",
        id: "response-after-approval",
        threadId: "main",
        toolCallId: "call-plan",
        createdAt: "2026-08-28T00:00:01.000Z",
        content: JSON.stringify({ plan: null, revision: 1, updatedAt: null }),
      },
      state,
    ),
    [],
  );
});
