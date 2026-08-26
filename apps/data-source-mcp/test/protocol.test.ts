import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ServerConfig } from "../src/config.js";
import { ConnectionRegistry } from "../src/connection-registry.js";
import { createHttpApp } from "../src/http-server.js";

const authToken = "protocol-test-token";

test("serves authenticated MCP tools and rejects anonymous requests", async (context) => {
  const registry = new ConnectionRegistry([]);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    authToken,
    connections: [],
  };
  const server = createServer(createHttpApp(config, registry));
  const baseUrl = await listen(server);
  context.after(async () => {
    await close(server);
    await registry.close();
  });

  const unauthorized = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  });
  assert.equal(unauthorized.status, 401);

  const client = new Client({ name: "forty-two-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: { headers: { authorization: `Bearer ${authToken}` } },
    },
  );
  context.after(async () => client.close());

  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      "list_data_sources",
      "test_data_source",
      "list_databases",
      "list_schemas",
      "list_tables",
      "describe_table",
      "run_read_query",
    ],
  );
  assert.equal(
    listed.tools.every((tool) => tool.annotations?.readOnlyHint),
    true,
  );

  const result = await client.callTool({
    name: "list_data_sources",
    arguments: {},
  });
  assert.deepEqual(result.structuredContent, { dataSources: [] });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
