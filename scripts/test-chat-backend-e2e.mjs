import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { TrueForge } from "../apps/web/node_modules/@truefoundry/trueforge-sdk/dist/esm/index.mjs";

import {
  buildCombinedFlowMessage,
  cleanupTrackedDataSources,
  commandContainsExactSqlLiteral,
  COMBINED_READ_SQL,
  persistedCombinedExecCalls,
  requireReadyTrackedDataSource,
  sqlSha256,
} from "./lib/combined-flow-contract.mjs";
import { collectAllPageItems } from "./lib/integration-events.mjs";
import {
  closeDatabase,
  getChatSession,
  initializeDatabase,
  listChatSessionDataSourceIds,
} from "../packages/db/dist/index.js";

const requireFromMcp = createRequire(
  new URL("../apps/data-source-mcp/package.json", import.meta.url),
);
const { Client } = requireFromMcp("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireFromMcp(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);

const webUrl = normalizeUrl(process.env.WEB_URL || "http://127.0.0.1:3000");
const trueForgeUrl = normalizeUrl(
  process.env.TRUEFORGE_URL || "http://127.0.0.1:8790",
);
const trueforge = new TrueForge({
  baseUrl: trueForgeUrl,
  timeoutInSeconds: 300,
  maxRetries: 2,
});
const mcpUrl = normalizeUrl(
  process.env.DATA_SOURCE_MCP_URL || "http://127.0.0.1:8791",
);
const databaseUrl = requiredEnvironment("DATABASE_URL");
const mcpAuthToken = requiredEnvironment("MCP_AUTH_TOKEN");
const agentName =
  process.env.FORTY_TWO_AGENT_NAME?.trim() || "forty-two-data-agent";
const nonce = `bound-session-${Date.now()}-${process.pid}`;
const fileValue = randomInt(10, 10_000);
const cleanupSessionIds = new Set();
const cleanupDataSourceIds = new Set();
const cleanupTrueForgeSessionIds = new Set();
let primaryError;

try {
  initializeDatabase({ connectionString: databaseUrl, maxConnections: 2 });
  await run();
  console.log(
    `Datasource-bound session E2E passed against live Azure, PostgreSQL, MCP, TrueForge, and Daytona (${nonce}).`,
  );
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  for (const sessionId of cleanupSessionIds) {
    try {
      const response = await api(`/api/chat/sessions/${sessionId}`, {
        method: "DELETE",
      });
      assert.equal(response.status, 204);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  cleanupErrors.push(
    ...(await cleanupTrackedDataSources(
      cleanupDataSourceIds,
      async (dataSourceId) => {
        const response = await api(`/api/data-sources/${dataSourceId}`, {
          method: "DELETE",
        });
        assert.ok(response.status === 204 || response.status === 404);
      },
    )),
  );
  for (const sessionId of cleanupTrueForgeSessionIds) {
    try {
      const response = await trueForgeApi(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      );
      assert.ok(response.status === 204 || response.status === 404);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await closeDatabase().catch((error) => cleanupErrors.push(error));
  if (primaryError || cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      "Datasource-bound session E2E failed or cleanup was incomplete.",
    );
  }
}

async function run() {
  await proveGlobalNamedAgentDenied();

  const file = await createReadyCsv(
    `${nonce}.csv`,
    `label,value,nonce\nazure,${fileValue},${nonce}\n`,
  );
  const otherFile = await createReadyCsv(
    `${nonce}-other.csv`,
    `label,value,nonce\nother,13,${nonce}-other\n`,
  );
  const database = await registerPostgresql();

  const idempotencyKey = `bound-session-${randomUUID()}`;
  const created = await createSession(
    [database.id, file.id, database.id],
    idempotencyKey,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sessionId = requiredPublicSessionId(created.body.data?.id);
  cleanupSessionIds.add(sessionId);
  assert.equal(created.body.data.status, "active");
  assert.match(created.body.data.artifactCapability, /^ftart1\./);
  assert.equal(JSON.stringify(created.body).includes("ftmcp1"), false);
  assert.equal(JSON.stringify(created.body).includes("trueforge"), false);

  const retry = await createSession([file.id, database.id], idempotencyKey);
  assert.equal(retry.body.data.id, sessionId);
  assert.equal(
    retry.body.data.artifactCapability,
    created.body.data.artifactCapability,
  );
  const conflict = await createSession([file.id], idempotencyKey);
  assert.equal(conflict.status, 409);

  const application = await getChatSession({ chatSessionId: sessionId });
  assert.equal(application?.status, "active");
  assert.ok(application?.trueforgeSessionId);
  assert.equal(application?.mcpServerName, null);
  assert.deepEqual(
    await listChatSessionDataSourceIds({ chatSessionId: sessionId }),
    [database.id, file.id].sort(),
  );

  const connector = await trueForgeApi(
    "/api/v1/settings/mcp-servers/forty-two-data-source",
  );
  assert.equal(connector.status, 200);
  assert.equal(connector.body.data?.manifest?.name, "forty-two-data-source");
  assert.equal(
    connector.body.data?.manifest?.url,
    "http://data-source-mcp:8791/mcp",
  );
  assert.notEqual(
    connector.body.data?.manifest?.auth?.headers?.Authorization,
    undefined,
  );
  assert.equal(JSON.stringify(connector.body).includes(mcpAuthToken), false);
  const runtime = await trueForgeApi(
    `/api/v1/sessions/${application.trueforgeSessionId}`,
  );
  assert.equal(runtime.status, 200);
  const publicSession = await api(`/api/chat/sessions/${sessionId}`);
  assert.equal(publicSession.status, 200);
  assert.equal(publicSession.body.data.id, sessionId);
  assert.equal(
    JSON.stringify(publicSession.body).includes(application.trueforgeSessionId),
    false,
  );

  await proveScopedCapability(application, database.id, file.id);

  const second = await createSession([otherFile.id], `other-${randomUUID()}`);
  const secondSessionId = requiredPublicSessionId(second.body.data?.id);
  cleanupSessionIds.add(secondSessionId);
  const secondApplication = await getChatSession({
    chatSessionId: secondSessionId,
  });
  assert.ok(secondApplication);
  await proveCrossSessionDenial(secondApplication, database.id, file.id);

  await runRealBoundTurn({
    sessionId,
    trueforgeSessionId: application.trueforgeSessionId,
    connectorName: "forty-two-data-source",
    file,
    database,
  });

  const deleted = await api(`/api/chat/sessions/${secondSessionId}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 204);
  cleanupSessionIds.delete(secondSessionId);
  await assertDeletedSessionRejected(secondApplication);
}

async function proveGlobalNamedAgentDenied() {
  const globalTools = await trueForgeApi(
    "/api/v1/mcp-servers/forty-two-data-source/tools",
  );
  assert.equal(globalTools.status, 200);

  const created = await trueForgeApi("/api/v1/sessions", {
    method: "POST",
    body: { agent: { name: agentName } },
  });
  assert.ok(created.status >= 200 && created.status < 300);
  const trueforgeSessionId = String(created.body?.data?.id ?? "");
  assert.ok(trueforgeSessionId);
  cleanupTrueForgeSessionIds.add(trueforgeSessionId);

  const turn = await trueForgeApi(
    `/api/v1/sessions/${encodeURIComponent(trueforgeSessionId)}/turns`,
    {
      method: "POST",
      body: {
        stream: false,
        input: [
          {
            type: "user.message",
            content:
              'Call the datasource MCP server to list sources, then run SQL "SELECT 1" against local-postgres. Report only tool results.',
          },
        ],
      },
    },
  );
  assert.ok(turn.status >= 200 && turn.status < 300);
  const turnId = String(turn.body?.data?.id ?? "");
  assert.ok(turnId);
  let current = turn.body.data;
  const deadline = Date.now() + 90_000;
  while (current.state?.status === "running" && Date.now() < deadline) {
    await delay(500);
    const response = await trueForgeApi(
      `/api/v1/sessions/${encodeURIComponent(trueforgeSessionId)}/turns/${encodeURIComponent(turnId)}`,
    );
    assert.equal(response.status, 200);
    current = response.body.data;
  }
  assert.notEqual(current.state?.status, "running");

  const eventResponse = await trueForgeApi(
    `/api/v1/sessions/${encodeURIComponent(trueforgeSessionId)}/turns/${encodeURIComponent(turnId)}/events?limit=100&order=asc`,
  );
  assert.equal(eventResponse.status, 200);
  const events = eventResponse.body.data.map((item) => item.event ?? item);
  const globalCalls = events.flatMap((event) =>
    event.type === "model.message" && Array.isArray(event.toolCalls)
      ? event.toolCalls.filter(
          (call) =>
            call.toolInfo?.serverName === "forty-two-data-source" ||
            ["list_data_sources", "run_read_query"].includes(
              call.toolInfo?.name,
            ),
        )
      : [],
  );
  const successfulDatasourceResponses = events.filter(
    (event) =>
      event.type === "tool.response" &&
      globalCalls.some((call) => call.id === event.toolCallId) &&
      !String(event.content).includes("failed"),
  );
  assert.deepEqual(successfulDatasourceResponses, []);
}

async function createReadyCsv(filename, contents) {
  const bytes = Buffer.from(contents, "utf8");
  const initiated = await api("/api/data-sources/files/initiate", {
    method: "POST",
    body: {
      name: filename,
      filename,
      mimeType: "text/csv",
      fileSizeBytes: bytes.length,
    },
  });
  assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
  const dataSourceId = initiated.body.data.id;
  cleanupDataSourceIds.add(dataSourceId);
  const upload = await fetch(initiated.body.upload.url, {
    method: "PUT",
    headers: initiated.body.upload.headers,
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(upload.status, 201);
  const completed = await api(`/api/data-sources/${dataSourceId}/complete`, {
    method: "POST",
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.data.status, "ready");
  assert.equal(completed.body.data.azureETag, upload.headers.get("etag"));
  return { ...completed.body.data, contents, bytes };
}

async function registerPostgresql() {
  const response = await api("/api/data-sources/databases", {
    method: "POST",
    body: {
      connectorType: "postgresql",
      name: `${nonce} PostgreSQL`,
      mutationMode: "disabled",
      config: {
        host: process.env.E2E_POSTGRES_TARGET_HOST || "postgres",
        port: 5432,
        database: process.env.POSTGRES_DB || "forty_two",
        schema: "demo",
        sslMode: "disable",
      },
      credentials: {
        username: "forty_two_reader",
        password: requiredEnvironment("POSTGRES_READER_PASSWORD"),
      },
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return requireReadyTrackedDataSource(
    response.body.data,
    cleanupDataSourceIds,
  );
}

function createSession(dataSourceIds, idempotencyKey) {
  return api("/api/chat/sessions", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: { dataSourceIds },
  });
}

async function proveScopedCapability(application, databaseId, fileId) {
  const { client, close } = await scopedMcpClient(application);
  try {
    const listed = await callTool(client, "list_data_sources", {
      sessionId: application.id,
    });
    assert.deepEqual(
      listed.dataSources.map((source) => source.name),
      [databaseId],
    );
    const descriptor = await callTool(client, "get_file_download_url", {
      sessionId: application.id,
      dataSourceId: fileId,
    });
    const sas = new URL(descriptor.url);
    assert.equal(sas.protocol, "https:");
    assert.equal(sas.searchParams.get("sp"), "r");
    assert.equal(sas.searchParams.get("sr"), "b");
    assert.equal(sas.searchParams.get("spr"), "https");
    assert.equal(
      descriptor.expectedETag,
      descriptor.requestHeaders["If-Match"],
    );
    const expiresIn = Date.parse(descriptor.expiresAt) - Date.now();
    assert.ok(expiresIn > 290_000 && expiresIn <= 300_000);
  } finally {
    await close();
  }
}

async function proveCrossSessionDenial(
  application,
  unboundDatabaseId,
  unboundFileId,
) {
  const { client, close } = await scopedMcpClient(application);
  try {
    const listed = await callTool(client, "list_data_sources", {
      sessionId: application.id,
    });
    assert.deepEqual(listed.dataSources, []);
    for (const attempted of [
      client.callTool({
        name: "run_read_query",
        arguments: {
          sessionId: application.id,
          dataSourceId: unboundDatabaseId,
          sql: "SELECT 1",
        },
      }),
      client.callTool({
        name: "get_file_download_url",
        arguments: {
          sessionId: application.id,
          dataSourceId: unboundFileId,
        },
      }),
    ]) {
      const response = await attempted;
      assert.equal(response.isError, true);
    }
  } finally {
    await close();
  }
}

async function runRealBoundTurn({
  sessionId,
  trueforgeSessionId,
  connectorName,
  file,
  database,
}) {
  const requestId = randomUUID();
  const marker = `BOUND_E2E_OK nonce=${nonce} file=${fileValue} database=42 total=${fileValue + 42}`;
  const message = buildCombinedFlowMessage({
    connectorName,
    sessionId,
    fileDataSourceId: file.id,
    databaseDataSourceId: database.id,
    requestId,
    nonce,
  });
  const created = await api(`/api/chat/sessions/${sessionId}/turns`, {
    method: "POST",
    body: { message },
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.data.sessionId, sessionId);
  const turnId = created.body.data.id;
  const waited = await api(
    `/api/chat/sessions/${sessionId}/turns/${turnId}/wait`,
    {
      method: "POST",
      body: { timeoutSeconds: 300 },
      timeoutMs: 330_000,
    },
  );
  assert.equal(waited.status, 200, JSON.stringify(waited.body));
  assert.equal(waited.body.data.sessionId, sessionId);
  assert.equal(waited.body.data.state?.status, "done");
  const eventsResponse = await api(
    `/api/chat/sessions/${sessionId}/turns/${turnId}/events`,
  );
  assert.equal(eventsResponse.status, 200);
  assert.deepEqual(
    eventsResponse.body.data,
    eventsResponse.body.normalizedEvents,
  );
  assert.equal(
    eventsResponse.body.data.every(
      (event) => typeof event.type === "string" && !("event" in event),
    ),
    true,
  );
  const events = await collectAllPageItems(
    await trueforge.sessions.listTurnEvents(trueforgeSessionId, turnId, {
      limit: 100,
      order: "asc",
    }),
  );
  assert.equal(
    JSON.stringify(waited.body.data.state?.output).includes(marker),
    true,
    JSON.stringify({
      state: waited.body.data.state,
      executionEvents: diagnosticExecutionEvents(events),
    }),
  );
  assert.equal(
    events.some((event) => event.type === "sandbox.created"),
    true,
  );
  const combinedExecCalls = persistedCombinedExecCalls(events, connectorName);
  assert.equal(
    combinedExecCalls.length,
    1,
    JSON.stringify(diagnosticExecutionEvents(events)),
  );
  assert.equal(
    commandContainsExactSqlLiteral(combinedExecCalls[0].command),
    true,
    redactSasSecrets(combinedExecCalls[0].command),
  );
  assert.equal(
    combinedExecCalls[0].command.includes(`${COMBINED_READ_SQL}.`),
    false,
    redactSasSecrets(combinedExecCalls[0].command),
  );
  const execResponses = correlatedExecResponses(events, combinedExecCalls);
  assert.equal(
    execResponses.some((value) => value.includes(marker)),
    true,
  );
  const evidence = await fetch(
    `${mcpUrl}/internal/query-executions/${requestId}`,
    {
      headers: { authorization: `Bearer ${mcpAuthToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(evidence.status, 200);
  const execution = (await evidence.json()).data;
  assert.equal(execution.dataSource, database.id);
  assert.equal(execution.executedSqlSha256, sqlSha256());
  assert.equal(Number(execution.rows[0]?.value), 42);
}

function diagnosticExecutionEvents(events) {
  return events.flatMap((event) => {
    if (event.type === "model.message" && Array.isArray(event.toolCalls)) {
      return event.toolCalls
        .filter(
          (call) =>
            call.toolInfo?.name === "exec" || call.function?.name === "exec",
        )
        .map((call) => ({
          type: event.type,
          toolCallId: call.id,
          arguments: redactSasSecrets(call.function?.arguments),
        }));
    }
    if (event.type === "tool.response") {
      return [
        {
          type: event.type,
          toolCallId: event.toolCallId,
          content: redactSasSecrets(event.content),
        },
      ];
    }
    return [];
  });
}

function redactSasSecrets(value) {
  if (typeof value !== "string") return value;
  return value.replace(/([?&]sig=)[^&\s"']+/gi, "$1<redacted>");
}

function correlatedExecResponses(events, combinedExecCalls) {
  const callIds = new Set(combinedExecCalls.map((call) => call.id));
  return events
    .filter(
      (event) =>
        event.type === "tool.response" &&
        callIds.has(event.toolCallId) &&
        typeof event.content === "string",
    )
    .map((event) => event.content);
}

async function assertDeletedSessionRejected(application) {
  const { client, close } = await scopedMcpClient(application);
  try {
    const response = await client.callTool({
      name: "list_data_sources",
      arguments: { sessionId: application.id },
    });
    assert.equal(response.isError, true);
  } finally {
    await close();
  }
}

async function scopedMcpClient(application) {
  const client = new Client({ name: "bound-session-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${mcpUrl}/mcp`),
    {
      requestInit: { headers: { authorization: `Bearer ${mcpAuthToken}` } },
    },
  );
  await client.connect(transport);
  return {
    client,
    close: () => client.close().catch(() => undefined),
  };
}

async function callTool(client, name, arguments_) {
  const response = await client.callTool({ name, arguments: arguments_ });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  return response.structuredContent;
}

async function api(
  path,
  { method = "GET", headers = {}, body, timeoutMs = 60_000 } = {},
) {
  const response = await fetch(`${webUrl}${path}`, {
    method,
    headers:
      body === undefined
        ? headers
        : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = response.status === 204 ? "" : await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
  };
}

async function trueForgeApi(
  path,
  { method = "GET", body, timeoutMs = 30_000 } = {},
) {
  const response = await fetch(`${trueForgeUrl}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = response.status === 204 ? "" : await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredPublicSessionId(value) {
  assert.match(String(value), /^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("E2E URLs must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}
