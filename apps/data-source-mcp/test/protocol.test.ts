import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DataSourceType } from "@forty-two/data-source";
import { type ActiveChatSessionScope } from "@forty-two/db";

import type { ServerConfig } from "../src/config.js";
import { ConnectionRegistry } from "../src/connection-registry.js";
import {
  createHttpApp,
  HttpRequestLifecycle,
  type HttpAppDependencies,
} from "../src/http-server.js";
import { toolFailure } from "../src/json.js";
import { drainAndClose } from "../src/shutdown.js";
import type { ArtifactStore } from "../src/artifact-store.js";

const authToken = "protocol-test-token";
const capabilitySessionId = "sess_01HZX000000000000000000001";
const protocolDataSourceId = "ds_01HZX000000000000000000007";

test("MCP tool failures never expose connector error details", () => {
  const failure = toolFailure(
    new Error("password authentication failed for user confidential-reader"),
  );
  assert.equal(failure.isError, true);
  assert.equal(failure.content[0].text, "Data source operation failed.");
  assert.equal(
    toolFailure(new Error("Only read-only queries are allowed")).content[0]
      .text,
    "Only read-only queries are allowed",
  );
});

test("serves the shared transport and requires active session scope on every tool", async (context) => {
  const registry = new ConnectionRegistry([]);
  const capability = capabilityFixture([]);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    authToken,
    allowedOrigins: ["https://trusted.example"],
    shutdownTimeoutMs: 15_000,
    connections: [],
    fileDownloads: {
      accountName: "dummy42account",
      accountKey: Buffer.alloc(32, 42).toString("base64"),
      container: "dummy42",
    },
    dynamic: {
      controlDatabaseUrl: "postgresql://unused.invalid/unused",
      encryptionKey: "a".repeat(64),
    },
  };
  const server = createServer(
    createHttpApp(
      config,
      registry,
      new HttpRequestLifecycle(),
      capability.dependencies,
    ),
  );
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

  const sharedTransport = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {},
    }),
  });
  assert.equal(sharedTransport.status, 406);

  const hostileOrigin = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: {},
    }),
  });
  assert.equal(hostileOrigin.status, 403);

  const client = new Client({ name: "forty-two-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: { authorization: `Bearer ${authToken}` },
      },
    },
  );
  context.after(async () => client.close());

  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      "list_data_sources",
      "prepare_sql_change",
      "apply_sql_change",
      "get_file_download_url",
      "begin_table_artifact_upload",
      "get_table_artifact_download_url",
      "finalize_table_artifact",
      "finalize_chart_artifact",
      "test_data_source",
      "list_databases",
      "list_schemas",
      "list_tables",
      "describe_table",
      "run_read_query",
      "create_query_table_artifact",
    ],
  );
  const toolByName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  assert.equal(
    toolByName.get("prepare_sql_change")?.annotations?.readOnlyHint,
    true,
  );
  assert.equal(
    toolByName.get("prepare_sql_change")?.annotations?.destructiveHint,
    false,
  );
  const prepareSchema = toolByName.get("prepare_sql_change")?.inputSchema;
  assert.deepEqual(prepareSchema?.required?.sort(), [
    "dataSourceId",
    "operation",
    "sessionId",
  ]);
  assert.deepEqual(Object.keys(prepareSchema?.properties ?? {}).sort(), [
    "columnName",
    "columnType",
    "dataSourceId",
    "destinationColumn",
    "expression",
    "operation",
    "sessionId",
    "sourceColumn",
    "sql",
    "target",
  ]);
  const deepPrepare = {
    sessionId: capabilitySessionId,
    dataSourceId: protocolDataSourceId,
    operation: "add_and_backfill_column",
    target: { catalog: null, schema: "public", table: "metrics" },
    columnName: "copied_value",
    columnType: "integer",
    expression: deeplyNestedExpression(3_000),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(deepPrepare)) < 1_048_576);
  try {
    const invalid = await client.callTool({
      name: "prepare_sql_change",
      arguments: deepPrepare,
    });
    assert.equal(invalid.isError, true);
  } catch (error) {
    assert.equal(error instanceof RangeError, false);
    assert.match(String(error), /invalid|structural safety bound/i);
  }
  const healthyAfterDeepInput = await fetch(`${baseUrl}/healthz`);
  assert.equal(healthyAfterDeepInput.status, 200);
  const responsiveAfterDeepInput = await client.callTool({
    name: "list_data_sources",
    arguments: { sessionId: capabilitySessionId },
  });
  assert.equal(responsiveAfterDeepInput.isError, undefined);
  assert.deepEqual(responsiveAfterDeepInput.structuredContent, {
    dataSources: [],
  });
  assert.equal(
    toolByName.get("apply_sql_change")?.annotations?.readOnlyHint,
    false,
  );
  assert.equal(
    toolByName.get("apply_sql_change")?.annotations?.destructiveHint,
    true,
  );
  assert.equal(
    toolByName.get("apply_sql_change")?.annotations?.idempotentHint,
    false,
  );
  assert.equal(
    toolByName.get("begin_table_artifact_upload")?.annotations?.readOnlyHint,
    true,
  );
  assert.equal(
    toolByName.get("get_table_artifact_download_url")?.annotations
      ?.readOnlyHint,
    true,
  );
  for (const name of [
    "finalize_table_artifact",
    "finalize_chart_artifact",
    "create_query_table_artifact",
  ]) {
    assert.equal(toolByName.get(name)?.annotations?.readOnlyHint, false);
    assert.equal(toolByName.get(name)?.annotations?.destructiveHint, false);
    assert.equal(toolByName.get(name)?.annotations?.idempotentHint, true);
  }
  assert.equal(
    listed.tools
      .filter((tool) => tool.name !== "apply_sql_change")
      .every(
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
  assert.match(
    descriptions.create_query_table_artifact ?? "",
    /writes an Azure blob and PostgreSQL metadata/,
  );
  assert.match(
    descriptions.finalize_table_artifact ?? "",
    /idempotent compatibility response/,
  );
  assert.match(descriptions.prepare_sql_change ?? "", /without modifying/);
  assert.match(
    descriptions.apply_sql_change ?? "",
    /always requires TrueForge approval/,
  );

  const result = await client.callTool({
    name: "list_data_sources",
    arguments: { sessionId: capabilitySessionId },
  });
  assert.deepEqual(result.structuredContent, { dataSources: [] });
});

test("read query is side-effect-free and explicit query artifact creation is an honest write", async (context) => {
  const connection = {
    name: protocolDataSourceId,
    type: DataSourceType.PostgreSQL,
    credentials: {
      type: DataSourceType.PostgreSQL,
      host: "database.internal",
      default_database: "analytics",
      username: "reader",
      password: "secret",
    },
    policy: { maxRows: 100, queryTimeoutMs: 1_500 },
  };
  const registry = new ConnectionRegistry([connection]);
  const rows = Array.from({ length: 40 }, (_, index) => ({ value: index }));
  registry.dataSource.execute = async () => ({
    success: true,
    rows,
    columns: [{ name: "value", type: "integer", nullable: false }],
    executionTime: 1,
    dataSource: "analytics",
  });
  let persistCalls = 0;
  let persistedColumns: unknown;
  const artifactStore = {
    async persistQueryResult(input: { columns: unknown; rows: unknown[] }) {
      persistCalls += 1;
      persistedColumns = input.columns;
      assert.equal(input.rows.length, 40);
      return {
        artifactId: "art_01HZX000000000000000000000",
        schemaVersion: "table.v1",
        contentSha256: "a".repeat(64),
        byteSize: 100,
        rowCount: 40,
        columns: [{ name: "value", type: "integer", nullable: false }],
        preview: rows.slice(0, 30),
        sourceLimited: false,
        sourceMaxRows: null,
        warnings: [],
      };
    },
  } as unknown as ArtifactStore;
  const capability = capabilityFixture([
    databaseScopeSource(protocolDataSourceId),
  ]);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    authToken,
    allowedOrigins: [],
    shutdownTimeoutMs: 15_000,
    connections: [connection],
  };
  const server = createServer(
    createHttpApp(config, registry, new HttpRequestLifecycle(), {
      ...capability.dependencies,
      artifactStore,
    }),
  );
  const baseUrl = await listen(server);
  const client = new Client({ name: "query-write-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: { headers: { authorization: `Bearer ${authToken}` } },
    },
  );
  context.after(async () => {
    await client.close().catch(() => undefined);
    await close(server);
    await registry.close();
  });
  await client.connect(transport);

  const read = await client.callTool({
    name: "run_read_query",
    arguments: {
      sessionId: capabilitySessionId,
      dataSourceId: protocolDataSourceId,
      sql: "SELECT value FROM metrics",
    },
  });
  assert.notEqual(read.isError, true, JSON.stringify(read.content));
  assert.equal(persistCalls, 0);
  assert.equal((read.structuredContent?.rows as unknown[]).length, 40);

  const created = await client.callTool({
    name: "create_query_table_artifact",
    arguments: {
      sessionId: capabilitySessionId,
      dataSourceId: protocolDataSourceId,
      sql: "SELECT value FROM metrics",
      requestId: "77777777-7777-4777-8777-777777777777",
    },
  });
  assert.equal(created.isError, undefined);
  assert.equal(persistCalls, 1);
  assert.deepEqual(persistedColumns, [
    { name: "value", type: "integer", nullable: false },
  ]);
  assert.equal(JSON.stringify(created).includes('"rows"'), false);
  assert.equal(JSON.stringify(created).includes('"value":39'), false);
});

test("internal validation is bearer-only and sanitizes adapter failures", async (context) => {
  const registry = new ConnectionRegistry([]);
  const marker = "sensitive-password-marker";
  let invalidated: string | undefined;
  registry.resolveTesting = async () => {
    throw new Error(marker);
  };
  registry.invalidateDynamic = async (dataSourceId) => {
    invalidated = dataSourceId;
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    authToken,
    allowedOrigins: [],
    shutdownTimeoutMs: 15_000,
    connections: [],
  };
  const server = createServer(createHttpApp(config, registry));
  const baseUrl = await listen(server);
  context.after(async () => {
    await close(server);
    await registry.close();
  });
  const dataSourceId = "ds_01HZX000000000000000000000";

  const unauthorized = await fetch(
    `${baseUrl}/internal/data-sources/${dataSourceId}/validate`,
    { method: "POST" },
  );
  assert.equal(unauthorized.status, 401);

  const response = await fetch(
    `${baseUrl}/internal/data-sources/${dataSourceId}/validate`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    },
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(marker), false);
  assert.deepEqual(JSON.parse(text), {
    data: { dataSourceId, connected: false },
  });
  assert.equal(invalidated, dataSourceId);
});

test("persisted ds_ bindings scope every MCP tool, file SAS, and revocation", async (context) => {
  const firstDatabaseId = "ds_01HZX000000000000000000001";
  const secondDatabaseId = "ds_01HZX000000000000000000002";
  const fileId = "ds_01HZX000000000000000000003";
  const sessionId = "sess_01HZX000000000000000000001";
  const connections = [firstDatabaseId, secondDatabaseId].map((name) => ({
    name,
    type: DataSourceType.PostgreSQL,
    credentials: {
      type: DataSourceType.PostgreSQL,
      host: "database.internal",
      default_database: "analytics",
      username: "reader",
      password: "secret",
    },
    policy: { maxRows: 25, queryTimeoutMs: 1_500 },
  }));
  const registry = new ConnectionRegistry(connections);
  let executionCalls = 0;
  registry.dataSource.execute = async ({ dataSource }) => {
    executionCalls += 1;
    return {
      success: true,
      rows: [{ data_source: dataSource }],
      columns: [],
      executionTime: 1,
      dataSource,
    };
  };
  let revoked = false;
  const scope: ActiveChatSessionScope = {
    chatSessionId: sessionId,
    dataSources: [
      {
        id: firstDatabaseId,
        connectorType: "postgresql",
        name: "First database",
        originalFilename: null,
        mimeType: null,
        fileSizeBytes: null,
        azureBlobName: null,
        azureETag: null,
      },
      {
        id: fileId,
        connectorType: "csv",
        name: "Bound file",
        originalFilename: "bound.csv",
        mimeType: "text/csv",
        fileSizeBytes: 42,
        azureBlobName: `${fileId}/bound.csv`,
        azureETag: '"etag-1"',
      },
    ],
  };
  const dependencies: HttpAppDependencies = {
    authorizeSession: async (input) =>
      !revoked && input.chatSessionId === sessionId ? scope : null,
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    authToken,
    allowedOrigins: [],
    shutdownTimeoutMs: 15_000,
    connections,
    fileDownloads: {
      accountName: "dummy42account",
      accountKey: Buffer.alloc(32, 42).toString("base64"),
      container: "dummy42",
    },
  };
  const server = createServer(
    createHttpApp(config, registry, new HttpRequestLifecycle(), dependencies),
  );
  const baseUrl = await listen(server);
  const client = new Client({ name: "scoped-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${authToken}` } } },
  );
  context.after(async () => {
    await client.close().catch(() => undefined);
    await close(server);
    await registry.close();
  });

  await client.connect(transport);
  const listed = await client.callTool({
    name: "list_data_sources",
    arguments: { sessionId },
  });
  assert.deepEqual(
    listed.structuredContent?.dataSources.map(
      (source: { name: string }) => source.name,
    ),
    [firstDatabaseId, fileId],
  );
  assert.deepEqual(listed.structuredContent?.dataSources[1], {
    name: fileId,
    type: "csv",
    description: "Bound file",
  });

  const allowed = await client.callTool({
    name: "run_read_query",
    arguments: {
      sessionId,
      dataSourceId: firstDatabaseId,
      sql: "SELECT 1",
    },
  });
  assert.equal(allowed.isError, undefined);
  assert.deepEqual(allowed.structuredContent?.rows, [
    { data_source: firstDatabaseId },
  ]);
  assert.equal(executionCalls, 1);

  const denied = await client.callTool({
    name: "run_read_query",
    arguments: { sessionId, dataSourceId: secondDatabaseId, sql: "SELECT 1" },
  });
  assert.equal(denied.isError, true);
  assert.equal(executionCalls, 1);

  const descriptor = await client.callTool({
    name: "get_file_download_url",
    arguments: { sessionId, dataSourceId: fileId },
  });
  const file = descriptor.structuredContent as Record<string, unknown>;
  const sas = new URL(String(file.url));
  assert.equal(sas.searchParams.get("sp"), "r");
  assert.equal(sas.searchParams.get("spr"), "https");
  assert.equal(file.expectedETag, '"etag-1"');
  assert.deepEqual(file.requestHeaders, { "If-Match": '"etag-1"' });
  const ttl = Date.parse(String(file.expiresAt)) - Date.now();
  assert.ok(ttl > 295_000 && ttl <= 300_000);

  const unboundFile = await client.callTool({
    name: "get_file_download_url",
    arguments: {
      sessionId,
      dataSourceId: "ds_01HZX000000000000000000004",
    },
  });
  assert.equal(unboundFile.isError, true);

  revoked = true;
  const revokedResult = await client.callTool({
    name: "list_data_sources",
    arguments: { sessionId },
  });
  assert.equal(revokedResult.isError, true);
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
    name: protocolDataSourceId,
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
  const capability = capabilityFixture([
    databaseScopeSource(protocolDataSourceId),
  ]);
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
      dataSource: protocolDataSourceId,
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
  const server = createServer(
    createHttpApp(config, registry, lifecycle, capability.dependencies),
  );
  const baseUrl = await listen(server);
  const client = new Client({ name: "shutdown-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: { authorization: `Bearer ${authToken}` },
      },
    },
  );
  context.after(async () => {
    await client.close().catch(() => undefined);
    if (server.listening) await close(server);
  });

  await client.connect(transport);
  const call = client.callTool({
    name: "run_read_query",
    arguments: {
      sessionId: capabilitySessionId,
      dataSourceId: protocolDataSourceId,
      sql: "SELECT 1",
    },
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
    name: protocolDataSourceId,
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
  const capability = capabilityFixture([
    databaseScopeSource(protocolDataSourceId),
  ]);
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
  const server = createServer(
    createHttpApp(
      config,
      registry,
      new HttpRequestLifecycle(),
      capability.dependencies,
    ),
  );
  const baseUrl = await listen(server);
  const client = new Client({ name: "discovery-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: { authorization: `Bearer ${authToken}` },
      },
    },
  );
  context.after(async () => {
    await client.close();
    await close(server);
    await registry.close();
  });

  await client.connect(transport);
  const result = await client.callTool({
    name: "list_databases",
    arguments: {
      sessionId: capabilitySessionId,
      dataSourceId: protocolDataSourceId,
      limit: 2,
    },
  });

  assert.deepEqual(receivedOptions, { limit: 3, timeout: 1_500 });
  assert.deepEqual(result.structuredContent, {
    dataSourceId: protocolDataSourceId,
    databases: [{ name: "one" }, { name: "two" }],
    truncated: true,
  });
});

test("records authenticated server-side evidence for traced queries", async (context) => {
  const connection = {
    name: protocolDataSourceId,
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
  const capability = capabilityFixture([
    databaseScopeSource(protocolDataSourceId),
  ]);
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
  const server = createServer(
    createHttpApp(
      config,
      registry,
      new HttpRequestLifecycle(),
      capability.dependencies,
    ),
  );
  const baseUrl = await listen(server);
  const client = new Client({ name: "telemetry-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: { authorization: `Bearer ${authToken}` },
      },
    },
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
    arguments: {
      sessionId: capabilitySessionId,
      dataSourceId: protocolDataSourceId,
      sql: "SELECT 1",
      requestId,
    },
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
      dataSource: protocolDataSourceId,
      executedSqlSha256: createHash("sha256")
        .update("SELECT 1", "utf8")
        .digest("hex"),
      rows: [{ database_name: "analytics", nonce: "server-result" }],
      recordedAt: undefined,
    },
  );
  assert.equal(JSON.stringify(record).includes("SELECT 1"), false);
  assert.equal(Number.isNaN(Date.parse(record.recordedAt)), false);
});

function capabilityFixture(
  dataSources: ActiveChatSessionScope["dataSources"],
): { token: string; dependencies: HttpAppDependencies } {
  const scope: ActiveChatSessionScope = {
    chatSessionId: capabilitySessionId,
    dataSources,
  };
  return {
    token: authToken,
    dependencies: {
      authorizeSession: async (input) =>
        input.chatSessionId === capabilitySessionId ? scope : null,
    },
  };
}

function databaseScopeSource(
  id: string,
): ActiveChatSessionScope["dataSources"][number] {
  return {
    id,
    connectorType: "postgresql",
    name: id,
    originalFilename: null,
    mimeType: null,
    fileSizeBytes: null,
    azureBlobName: null,
    azureETag: null,
  };
}

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

function deeplyNestedExpression(depth: number): unknown {
  let expression: unknown = { kind: "literal", value: 1 };
  for (let index = 0; index < depth; index += 1) {
    expression = {
      kind: "binary",
      operator: "add",
      left: expression,
      right: { kind: "literal", value: 1 },
    };
  }
  return expression;
}
