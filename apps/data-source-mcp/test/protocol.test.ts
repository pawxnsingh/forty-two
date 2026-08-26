import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DataSourceType } from "@forty-two/data-source";

import type { ServerConfig } from "../src/config.js";
import { ConnectionRegistry } from "../src/connection-registry.js";
import { createHttpApp, HttpRequestLifecycle } from "../src/http-server.js";
import { drainAndClose } from "../src/shutdown.js";

const authToken = "protocol-test-token";

test("serves authenticated MCP tools and rejects anonymous requests", async (context) => {
  const registry = new ConnectionRegistry([]);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    authToken,
    allowedOrigins: ["https://trusted.example"],
    shutdownTimeoutMs: 15_000,
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

  const hostileOrigin = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {},
    }),
  });
  assert.equal(hostileOrigin.status, 403);

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

test("shutdown lifecycle rejects admission and closes active sessions", async () => {
  const lifecycle = new HttpRequestLifecycle();
  let closed = false;
  lifecycle.add({
    async close() {
      closed = true;
    },
  });

  await lifecycle.beginShutdown();

  assert.equal(closed, true);
  assert.equal(lifecycle.isDraining, true);
});

test("graceful shutdown drains an active MCP query before closing adapters", async (context) => {
  const connection = {
    name: "analytics",
    type: DataSourceType.PostgreSQL,
    credentials: {
      type: DataSourceType.PostgreSQL,
      host: "database.internal",
      default_database: "analytics",
      username: "reader",
      password: "secret",
    },
    policy: { maxRows: 25, queryTimeoutMs: 1_500 },
  };
  const registry = new ConnectionRegistry([connection]);
  const lifecycle = new HttpRequestLifecycle();
  const order: string[] = [];
  let releaseQuery: () => void = () => undefined;
  const queryReleased = new Promise<void>((resolve) => {
    releaseQuery = resolve;
  });
  let markQueryStarted: () => void = () => undefined;
  const queryStarted = new Promise<void>((resolve) => {
    markQueryStarted = resolve;
  });
  registry.dataSource.execute = async () => {
    order.push("query-started");
    markQueryStarted();
    await queryReleased;
    order.push("query-finished");
    return {
      success: true,
      rows: [{ value: 1 }],
      columns: [{ name: "value", type: "number", nullable: false }],
      executionTime: 1,
      dataSource: "analytics",
    };
  };
  registry.close = async () => {
    order.push("adapters-closed");
  };

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    authToken,
    allowedOrigins: [],
    shutdownTimeoutMs: 2_000,
    connections: [connection],
  };
  const server = createServer(createHttpApp(config, registry, lifecycle));
  const baseUrl = await listen(server);
  const client = new Client({ name: "shutdown-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${authToken}` } } },
  );
  context.after(async () => {
    await client.close().catch(() => undefined);
    if (server.listening) await close(server);
  });

  await client.connect(transport);
  const call = client.callTool({
    name: "run_read_query",
    arguments: { dataSource: "analytics", sql: "SELECT 1" },
  });
  await queryStarted;

  let shutdownSettled = false;
  const shutdown = drainAndClose({
    httpServer: server,
    lifecycle,
    registry,
    timeoutMs: config.shutdownTimeoutMs,
  }).then(() => {
    shutdownSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(shutdownSettled, false);
  assert.deepEqual(order, ["query-started"]);
  const rejectedDuringDrain = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(rejectedDuringDrain.status, 503);

  releaseQuery();
  const result = await call;
  await shutdown;

  assert.equal(result.isError, undefined);
  assert.deepEqual(order, [
    "query-started",
    "query-finished",
    "adapters-closed",
  ]);
  assert.equal(server.listening, false);
});

test("discovery limits are enforced before connector metadata retrieval", async (context) => {
  const connection = {
    name: "analytics",
    type: DataSourceType.PostgreSQL,
    credentials: {
      type: DataSourceType.PostgreSQL,
      host: "database.internal",
      default_database: "analytics",
      username: "reader",
      password: "secret",
    },
    policy: { maxRows: 25, queryTimeoutMs: 1_500 },
  };
  const registry = new ConnectionRegistry([connection]);
  let receivedOptions: unknown;
  registry.dataSource.getDatabases = async (_name, options) => {
    receivedOptions = options;
    return [{ name: "one" }, { name: "two" }, { name: "three" }];
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    authToken,
    allowedOrigins: [],
    shutdownTimeoutMs: 15_000,
    connections: [connection],
  };
  const server = createServer(createHttpApp(config, registry));
  const baseUrl = await listen(server);
  const client = new Client({ name: "discovery-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${authToken}` } } },
  );
  context.after(async () => {
    await client.close();
    await close(server);
    await registry.close();
  });

  await client.connect(transport);
  const result = await client.callTool({
    name: "list_databases",
    arguments: { dataSource: "analytics", limit: 2 },
  });

  assert.deepEqual(receivedOptions, { limit: 3, timeout: 1_500 });
  assert.deepEqual(result.structuredContent, {
    dataSource: "analytics",
    databases: [{ name: "one" }, { name: "two" }],
    truncated: true,
  });
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
