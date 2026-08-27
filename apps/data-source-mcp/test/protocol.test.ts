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
  assert.equal(
    listed.tools.every(
      (tool) =>
        tool.annotations?.destructiveHint === false &&
        tool.annotations?.idempotentHint === true &&
        typeof tool.description === "string" &&
        tool.description.length >= 150,
    ),
    true,
  );
  const descriptions = Object.fromEntries(
    listed.tools.map((tool) => [tool.name, tool.description]),
  );
  assert.match(
    descriptions.list_data_sources ?? "",
    /Credentials are never returned/,
  );
  assert.match(
    descriptions.describe_table ?? "",
    /exact returned identifiers and types/,
  );
  assert.match(
    descriptions.run_read_query ?? "",
    /bounded, read-only SQL query/,
  );
  assert.match(descriptions.run_read_query ?? "", /Never infer missing rows/);

  const result = await client.callTool({
    name: "list_data_sources",
    arguments: {},
  });
  assert.deepEqual(result.structuredContent, { dataSources: [] });
});

test("shutdown lifecycle awaits response-triggered session cleanup", async () => {
  const lifecycle = new HttpRequestLifecycle();
  let releaseClose: () => void = () => undefined;
  const closeReleased = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let closeCalls = 0;
  const session = {
    async close() {
      closeCalls += 1;
      await closeReleased;
    },
  };
  lifecycle.add(session);

  const responseCleanup = lifecycle.close(session);
  let shutdownSettled = false;
  const shutdown = lifecycle.beginShutdown().then(() => {
    shutdownSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(shutdownSettled, false);
  assert.equal(closeCalls, 1);

  releaseClose();
  await Promise.all([responseCleanup, shutdown]);

  assert.equal(shutdownSettled, true);
  assert.equal(closeCalls, 1);
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

test("records authenticated server-side evidence for traced queries", async (context) => {
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
  registry.dataSource.execute = async () => ({
    success: true,
    rows: [{ database_name: "analytics", nonce: "server-result" }],
    columns: [],
    executionTime: 1,
    dataSource: "analytics",
  });
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
  const client = new Client({ name: "telemetry-test", version: "0.1.0" });
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
  const requestId = "8a649768-e5f7-4de8-92e3-fc5194fdad6a";
  await client.callTool({
    name: "run_read_query",
    arguments: { dataSource: "analytics", sql: "SELECT 1", requestId },
  });

  const unauthorized = await fetch(
    `${baseUrl}/internal/query-executions/${requestId}`,
  );
  assert.equal(unauthorized.status, 401);
  const response = await fetch(
    `${baseUrl}/internal/query-executions/${requestId}`,
    { headers: { authorization: `Bearer ${authToken}` } },
  );
  assert.equal(response.status, 200);
  const record = (await response.json()).data;
  assert.deepEqual(
    { ...record, recordedAt: undefined },
    {
      requestId,
      dataSource: "analytics",
      rows: [{ database_name: "analytics", nonce: "server-result" }],
      recordedAt: undefined,
    },
  );
  assert.equal(Number.isNaN(Date.parse(record.recordedAt)), false);
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
