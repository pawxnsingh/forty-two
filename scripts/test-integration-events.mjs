import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoDirectDatasourceCalls,
  correlatedCodeModeResults,
  discoverSandboxEvents,
  listAllEventPages,
} from "./lib/integration-events.mjs";

test("rejects direct and deferred datasource tool calls", () => {
  assert.throws(() =>
    assertNoDirectDatasourceCalls([
      {
        type: "model.message",
        tool_calls: [
          {
            tool_info: {
              type: "mcp",
              server_name: "forty-two-data-source",
              name: "run_read_query",
            },
            function: { name: "run_read_query", arguments: "{}" },
          },
        ],
      },
    ]),
  );
  assert.throws(() =>
    assertNoDirectDatasourceCalls([
      {
        type: "model.message",
        tool_calls: [
          {
            function: {
              name: "deferred-tools__call_tool",
              arguments: JSON.stringify({
                mcp_server: "forty-two-data-source",
              }),
            },
          },
        ],
      },
    ]),
  );
});

test("correlates only the response to the matching Code Mode exec", () => {
  const requestId = "2fe427e9-7d7d-45d0-b0ad-8d53f31ed098";
  const command = `from mcp_client import call_tool\ncall_tool("forty-two-data-source", "run_read_query", {"dataSource":"local-postgres","requestId":"${requestId}"})`;
  const events = [
    {
      type: "model.message",
      tool_calls: [
        {
          id: "exec-1",
          tool_info: { name: "exec" },
          function: {
            name: "exec",
            arguments: JSON.stringify({ command }),
          },
        },
      ],
    },
    { type: "tool.response", tool_call_id: "other", content: "forged" },
    { type: "tool.response", tool_call_id: "exec-1", content: "verified" },
  ];
  assert.deepEqual(correlatedCodeModeResults(events, requestId), ["verified"]);
});

test("walks every event page and rejects repeated cursors", async () => {
  const pages = new Map([
    [undefined, { data: [{ id: 1 }], pagination: { next_page_token: "p2" } }],
    ["p2", { data: [{ id: 2 }], pagination: {} }],
  ]);
  assert.deepEqual(await listAllEventPages(async (token) => pages.get(token)), [
    { id: 1 },
    { id: 2 },
  ]);
  await assert.rejects(() =>
    listAllEventPages(async () => ({
      data: [],
      pagination: { next_page_token: "same" },
    })),
  );
});

test("retries successful sandbox-free responses and fails closed", async () => {
  let calls = 0;
  const found = await discoverSandboxEvents({
    initialEvents: [{ type: "turn.done" }],
    fetchEvents: async () => {
      calls += 1;
      return calls === 3 ? [{ type: "sandbox.created", sandbox_id: "sb" }] : [];
    },
    pause: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(found[0].type, "sandbox.created");

  await assert.rejects(() =>
    discoverSandboxEvents({
      initialEvents: [],
      fetchEvents: async () => [],
      pause: async () => {},
    }),
  );
});
