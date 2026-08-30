import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createTodoHttpApp } from "../src/http-server.js";
import type { PlanStore } from "../src/mcp-server.js";

const authToken = "todo-protocol-test-token";

test("discovers exactly one authenticated plan tool and returns canonical state", async (context) => {
  let revision = 0;
  let plan: Awaited<ReturnType<PlanStore["set"]>>["plan"] = null;
  const store: PlanStore = {
    async set(input) {
      plan = {
        title: input.title,
        items: input.items.map((item) => ({
          text: item.text,
          status: item.status ?? "pending",
        })),
      };
      revision += 1;
      return { plan, revision, updatedAt: new Date("2026-08-28T00:00:00Z") };
    },
    async updateItem(input) {
      assert.ok(plan);
      plan = {
        ...plan,
        items: plan.items.map((item, index) =>
          index === input.itemIndex
            ? { ...item, status: input.status, summary: input.summary }
            : item,
        ),
      };
      revision += 1;
      return { plan, revision, updatedAt: new Date("2026-08-28T00:00:01Z") };
    },
  };
  const server = createServer(
    createTodoHttpApp({ host: "127.0.0.1", port: 0, authToken }, store),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const mcpUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

  const anonymous = await fetch(mcpUrl, { method: "POST" });
  assert.equal(anonymous.status, 401);

  const client = new Client({ name: "todo-test", version: "0.1.0" });
  context.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${authToken}` } },
    }),
  );
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map(({ name }) => name),
    ["plan"],
  );
  assert.deepEqual(listed.tools[0]?.inputSchema.required, [
    "sessionId",
    "action",
  ]);
  assert.deepEqual(
    Object.keys(listed.tools[0]?.inputSchema.properties ?? {}).sort(),
    ["action", "itemIndex", "items", "sessionId", "status", "summary", "title"],
  );
  assert.equal(listed.tools[0]?.annotations?.idempotentHint, true);
  assert.equal(listed.tools[0]?.annotations?.destructiveHint, false);

  const sessionId = "sess_01HZX000000000000000000000";
  const setResult = await client.callTool({
    name: "plan",
    arguments: {
      sessionId,
      action: "set",
      title: "Test plan",
      items: [
        { text: "First", status: null },
        { text: "Second", status: null },
      ],
      itemIndex: null,
      status: null,
      summary: null,
    },
  });
  assert.equal(setResult.isError, undefined);
  assert.equal(setResult.structuredContent?.revision, 1);
  const updateResult = await client.callTool({
    name: "plan",
    arguments: {
      sessionId,
      action: "update_item",
      itemIndex: 0,
      status: "completed",
      summary: "Done",
    },
  });
  assert.equal(updateResult.structuredContent?.revision, 2);
  assert.deepEqual(
    (updateResult.structuredContent?.plan as { items: unknown[] }).items[0],
    { text: "First", status: "completed", summary: "Done" },
  );

  const invalid = await client.callTool({
    name: "plan",
    arguments: {
      sessionId,
      action: "update_item",
      itemIndex: 0,
      status: "invalid",
    },
  });
  assert.equal(invalid.isError, true);
  const wrongShape = await client.callTool({
    name: "plan",
    arguments: {
      sessionId,
      action: "set",
      title: "Rejected shape",
      items: [{ text: "Rejected" }],
      status: "completed",
    },
  });
  assert.equal(wrongShape.isError, true);
});
