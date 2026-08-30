import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoDirectDatasourceCalls,
  collectAllPageItems,
  correlatedCodeModeResults,
  discoverSandboxEvents,
  listAllEventPages,
} from "./lib/integration-events.mjs";
import {
  COMBINED_READ_SQL,
  persistedCombinedExecCalls,
} from "./lib/combined-flow-contract.mjs";

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

test("retains an earlier combined-flow exec call across an auto-paginated SDK page", async () => {
  const command = [
    'call_tool("forty-two-data-source", "get_file_download_url", {})',
    'requestHeaders = descriptor["requestHeaders"]',
    'expectedETag = descriptor["expectedETag"]',
    `call_tool("forty-two-data-source", "run_read_query", {"sql":"${COMBINED_READ_SQL}"})`,
  ].join("\n");
  const sdkPage = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "tool.response",
        toolCallId: "exec-early",
        content: "BOUND_E2E_OK",
      };
      yield {
        type: "model.message",
        toolCalls: [
          {
            id: "exec-early",
            toolInfo: { name: "exec" },
            function: {
              name: "exec",
              arguments: JSON.stringify({ command }),
            },
          },
        ],
      };
    },
  };
  const events = await collectAllPageItems(sdkPage);

  const calls = persistedCombinedExecCalls(events, "forty-two-data-source");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "exec-early");
  assert.equal(
    events.some(
      (event) =>
        event.type === "tool.response" &&
        event.toolCallId === calls[0].id &&
        event.content === "BOUND_E2E_OK",
    ),
    true,
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
