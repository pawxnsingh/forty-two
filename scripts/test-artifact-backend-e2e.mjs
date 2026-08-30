import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  parseCanonicalTableV1,
  serializeCanonicalTableV1,
} from "../packages/artifacts/dist/index.js";
import { validateChartConfigV1 } from "../packages/charting/dist/server/artifact-contracts.js";
import {
  activateChatSession,
  closeDatabase,
  createChatSession,
  getAnalysisArtifact,
  getChatSession,
  initializeDatabase,
  listAnalysisArtifactParents,
  listAnalysisArtifacts,
  mintArtifactBrowserCapability,
  migrateDatabase,
  revokeChatSessionCapability,
  softDeleteChatSession,
} from "../packages/db/dist/index.js";

const requireFromMcp = createRequire(
  new URL("../apps/data-source-mcp/package.json", import.meta.url),
);
const { Client } = requireFromMcp("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireFromMcp(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);

const webUrl = normalizeUrl(process.env.WEB_URL || "http://127.0.0.1:3000");
const mcpUrl = normalizeUrl(
  process.env.DATA_SOURCE_MCP_URL || "http://127.0.0.1:8791",
);
const databaseUrl = requiredEnvironment("DATABASE_URL");
const signingKey = requiredEnvironment("MCP_CAPABILITY_SIGNING_KEY");
const mcpAuthToken = requiredEnvironment("MCP_AUTH_TOKEN");
const coffeePath =
  process.env.COFFEE_SALES_CSV_PATH?.trim() ||
  "/home/pawxnsingh/Downloads/Coffee_Sales.csv";
const nonce = `artifact-e2e-${Date.now()}-${process.pid}`;
const cleanupDataSourceIds = new Set();
const cleanupSessionIds = new Set();

try {
  initializeDatabase({ connectionString: databaseUrl, maxConnections: 4 });
  await migrateDatabase();
  await run();
  console.log(
    `Artifact backend E2E passed with real Coffee_Sales.csv, exact MySQL BIGINT/DECIMAL values, Azure, MCP, PostgreSQL, and Next.js (${nonce}).`,
  );
} finally {
  for (const sessionId of cleanupSessionIds) {
    await softDeleteChatSession({ chatSessionId: sessionId }).catch(
      () => undefined,
    );
  }
  for (const dataSourceId of cleanupDataSourceIds) {
    await api(`/api/data-sources/${dataSourceId}`, { method: "DELETE" }).catch(
      () => undefined,
    );
  }
  await closeDatabase();
}

async function run() {
  const coffeeBytes = await readFile(coffeePath);
  const coffeeRows = parseCsv(coffeeBytes.toString("utf8"));
  assert.ok(coffeeRows.length > 100, "Coffee fixture was unexpectedly small");
  const numericRows = coffeeRows.map((row, index) => ({
    Sales: requiredNumber(row.Sales, index, "Sales"),
    Profit: requiredNumber(row.Profit, index, "Profit"),
  }));
  const averageSales =
    numericRows.reduce((sum, row) => sum + row.Sales, 0) / numericRows.length;

  const file = await createReadyCoffeeDataSource(coffeeBytes);
  const database = await registerPostgresqlDataSource();
  const mysql = await registerMysqlDataSource();
  const session = await createActiveSession([file.id, database.id, mysql.id]);
  const scoped = await scopedClient(session);

  const table = serializeCanonicalTableV1({
    columns: [
      { name: "Sales", type: "number", nullable: false },
      { name: "Profit", type: "number", nullable: false },
      { name: "AverageSales", type: "number", nullable: false },
    ],
    rows: numericRows.map((row) => ({ ...row, AverageSales: averageSales })),
  });
  const coffeeSourceReference = `datasource:${file.id}@${file.azureETag}`;
  const coffeeArtifact = await emitThroughAzure(scoped.client, {
    table,
    title: "Coffee sales and profit",
    parentArtifactIds: [],
    sourceReferences: [coffeeSourceReference],
  });

  const chartCallAt = Date.now();
  const chartReceiptPayload = {
    sessionId: session.id,
    schemaVersion: "chart.receipt.v1",
    inputArtifactId: coffeeArtifact.artifactId,
    sourceContentSha256: table.contentSha256,
    rowCount: numericRows.length,
    title: "Sales vs profit",
    description: "Every Coffee Sales source row",
    config: {
      selectedChartType: "scatter",
      scatterAxis: {
        x: ["Sales"],
        y: ["Profit"],
        category: [],
        size: [],
        tooltip: ["AverageSales"],
      },
      scatterDotSize: [4, 18],
      trendlines: [
        {
          columnId: "Profit",
          id: "profit-linear-trend",
          type: "linear_regression",
          show: true,
        },
      ],
      columnLabelFormats: {
        Sales: {
          columnType: "number",
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        },
        Profit: {
          columnType: "number",
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        },
      },
    },
    warnings: [],
  };
  const chartRequest = {
    ...chartReceiptPayload,
    receiptSha256: sha256(
      Buffer.from(JSON.stringify(stableJsonValue(chartReceiptPayload)), "utf8"),
    ),
  };
  assert.equal(JSON.stringify(chartRequest).includes('"rows"'), false);
  const expectedChartConfig = validateChartConfigV1({
    config: chartReceiptPayload.config,
    columns: table.columns,
    rowCount: table.rowCount,
  });
  const chartResult = await call(
    scoped.client,
    "finalize_chart_artifact",
    chartRequest,
  );
  const chart = chartResult.structuredContent;
  assert.equal(chart.sourceArtifactId, coffeeArtifact.artifactId);
  assert.equal(chart.sourceContentSha256, table.contentSha256);
  assert.deepEqual(chart.config, expectedChartConfig);

  const persistedTable = await getAnalysisArtifact({
    chatSessionId: session.id,
    artifactId: coffeeArtifact.artifactId,
  });
  const persistedChart = await getAnalysisArtifact({
    chatSessionId: session.id,
    artifactId: chart.artifactId,
  });
  assert.ok(persistedTable && persistedChart);
  assert.ok(persistedTable.createdAt.getTime() <= chartCallAt);
  assert.equal(persistedChart.chartConfig.sourceArtifactId, persistedTable.id);
  assert.deepEqual(persistedChart.chartConfig.config, expectedChartConfig);

  await proveBrowserArtifactCapability({
    session,
    artifactId: persistedTable.id,
  });

  const tableDetail = await api(
    `/api/chat/sessions/${session.id}/artifacts/${persistedTable.id}`,
    { artifactCapability: session.artifactCapability },
  );
  assert.equal(tableDetail.status, 200, JSON.stringify(tableDetail.body));
  assert.equal(tableDetail.body.data.preview.length <= 30, true);
  assert.equal(tableDetail.body.data.rowCount, numericRows.length);
  assert.equal(
    JSON.stringify(tableDetail.body).includes(JSON.stringify(numericRows[100])),
    false,
  );

  const chartDetail = await api(
    `/api/chat/sessions/${session.id}/artifacts/${persistedChart.id}`,
    { artifactCapability: session.artifactCapability },
  );
  assert.equal(chartDetail.status, 200, JSON.stringify(chartDetail.body));
  assert.equal(chartDetail.body.data.schemaVersion, "chart.v1");
  assert.equal(chartDetail.body.data.sourceContentSha256, table.contentSha256);
  assert.deepEqual(chartDetail.body.data.config, expectedChartConfig);
  assert.equal(chartDetail.body.data.data.length, numericRows.length);
  assert.deepEqual(
    chartDetail.body.data.data.map(({ Sales, Profit }) => ({ Sales, Profit })),
    numericRows,
  );
  assert.equal(chartDetail.body.data.data[0].AverageSales, averageSales);

  const download = await fetch(
    `${webUrl}/api/chat/sessions/${session.id}/artifacts/${persistedTable.id}/download`,
    { headers: { authorization: `Bearer ${session.artifactCapability}` } },
  );
  assert.equal(download.status, 200);
  const downloadedBytes = Buffer.from(await download.arrayBuffer());
  assert.equal(downloadedBytes.equals(table.bytes), true);
  assert.equal(sha256(downloadedBytes), persistedTable.contentSha256);

  const beforeRead = await listAnalysisArtifacts({
    chatSessionId: session.id,
    limit: 100,
  });
  const queryRequestId = randomUUID();
  const databaseResult = await call(scoped.client, "run_read_query", {
    dataSourceId: database.id,
    sql: "SELECT id, label, value FROM demo.metrics ORDER BY id",
    maxRows: 100,
    requestId: queryRequestId,
  });
  const afterRead = await listAnalysisArtifacts({
    chatSessionId: session.id,
    limit: 100,
  });
  assert.equal(afterRead.artifacts.length, beforeRead.artifacts.length);
  const databaseArtifact = await call(
    scoped.client,
    "create_query_table_artifact",
    {
      dataSourceId: database.id,
      sql: "SELECT id, label, value FROM demo.metrics ORDER BY id",
      maxRows: 100,
      requestId: queryRequestId,
    },
  );
  const databaseReceipt = databaseArtifact.structuredContent.artifact;
  assert.ok(databaseReceipt?.artifactId);
  assert.equal(databaseArtifact.structuredContent.storedRowCount >= 1, true);
  assert.equal(databaseArtifact.structuredContent.sourceLimited, false);
  assert.equal(JSON.stringify(databaseArtifact).includes('"rows"'), false);

  const mysqlRequestId = randomUUID();
  const mysqlArtifactResult = await call(
    scoped.client,
    "create_query_table_artifact",
    {
      dataSourceId: mysql.id,
      sql: `SELECT
        CAST(9223372036854775807 AS SIGNED) AS signed_bigint,
        CAST(18446744073709551615 AS UNSIGNED) AS unsigned_bigint,
        CAST(12345678901234567890.1234567890 AS DECIMAL(30, 10)) AS exact_decimal,
        CAST(NULL AS SIGNED) AS null_bigint,
        CAST(NULL AS DECIMAL(30, 10)) AS null_decimal`,
      maxRows: 10,
      requestId: mysqlRequestId,
    },
  );
  assert.equal(JSON.stringify(mysqlArtifactResult).includes('"rows"'), false);
  const mysqlReceipt = mysqlArtifactResult.structuredContent.artifact;
  assert.deepEqual(mysqlReceipt.preview, [
    {
      signed_bigint: "9223372036854775807",
      unsigned_bigint: "18446744073709551615",
      exact_decimal: "12345678901234567890.1234567890",
      null_bigint: null,
      null_decimal: null,
    },
  ]);
  assert.deepEqual(
    mysqlReceipt.columns.map(({ name, type, encoding }) => ({
      name,
      type,
      encoding: encoding ?? null,
    })),
    [
      { name: "signed_bigint", type: "integer", encoding: "string" },
      { name: "unsigned_bigint", type: "integer", encoding: "string" },
      { name: "exact_decimal", type: "decimal", encoding: "string" },
      { name: "null_bigint", type: "integer", encoding: "string" },
      { name: "null_decimal", type: "decimal", encoding: "string" },
    ],
  );
  const mysqlDownload = await fetch(
    `${webUrl}/api/chat/sessions/${session.id}/artifacts/${mysqlReceipt.artifactId}/download`,
    { headers: { authorization: `Bearer ${session.artifactCapability}` } },
  );
  assert.equal(mysqlDownload.status, 200);
  const mysqlBytes = Buffer.from(await mysqlDownload.arrayBuffer());
  const mysqlTable = parseCanonicalTableV1(mysqlBytes, {
    contentSha256: mysqlReceipt.contentSha256,
    byteSize: mysqlReceipt.byteSize,
    rowCount: 1,
    columns: mysqlReceipt.columns,
  });
  assert.deepEqual(mysqlTable.rows, mysqlReceipt.preview);

  const combined = serializeCanonicalTableV1({
    columns: [
      { name: "AverageCoffeeSales", type: "number", nullable: false },
      { name: "DatabaseValue", type: "integer", nullable: false },
    ],
    rows: [
      {
        AverageCoffeeSales: averageSales,
        DatabaseValue: databaseResult.structuredContent.rows[0].value,
      },
    ],
  });
  const combinedArtifact = await emitThroughAzure(scoped.client, {
    table: combined,
    title: "Coffee and database combined result",
    parentArtifactIds: [coffeeArtifact.artifactId, databaseReceipt.artifactId],
    sourceReferences: [],
  });
  assert.deepEqual(
    await listAnalysisArtifactParents({
      chatSessionId: session.id,
      artifactId: combinedArtifact.artifactId,
    }),
    [coffeeArtifact.artifactId, databaseReceipt.artifactId].sort(),
  );

  await proveRetriesAndFailures({
    session,
    client: scoped.client,
    token: scoped.token,
    databaseId: database.id,
    coffeeArtifactId: coffeeArtifact.artifactId,
    tableSourceReference: coffeeSourceReference,
    table,
  });

  const listed = await api(
    `/api/chat/sessions/${session.id}/artifacts?limit=2`,
    { artifactCapability: session.artifactCapability },
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.artifacts.length, 2);
  assert.ok(listed.body.data.nextPageToken);
  const pageTwo = await api(
    `/api/chat/sessions/${session.id}/artifacts?limit=100&pageToken=${encodeURIComponent(listed.body.data.nextPageToken)}`,
    { artifactCapability: session.artifactCapability },
  );
  assert.equal(pageTwo.status, 200);
  assert.equal(
    new Set(
      [...listed.body.data.artifacts, ...pageTwo.body.data.artifacts].map(
        (artifact) => artifact.id,
      ),
    ).size >= 4,
    true,
  );

  await revokeChatSessionCapability({
    chatSessionId: session.id,
    capabilityId: session.capabilityId,
  });
  const stillActive = await scoped.client.callTool({
    name: "list_data_sources",
    arguments: {},
  });
  assert.notEqual(stillActive.isError, true);

  await scoped.client.close();
}

async function proveBrowserArtifactCapability({ session, artifactId }) {
  const other = await createActiveSession([]);
  const deleted = await createActiveSession([]);
  const deletedCapability = deleted.artifactCapability;
  await softDeleteChatSession({ chatSessionId: deleted.id });
  const expired = mintArtifactBrowserCapability({
    chatSessionId: session.id,
    capabilityId: session.capabilityId,
    issuedAt: new Date(Date.now() - 2 * 60 * 60_000),
    expiresAt: new Date(Date.now() - 60 * 60_000),
    signingKey,
  });
  const paths = [
    `/api/chat/sessions/${session.id}/artifacts`,
    `/api/chat/sessions/${session.id}/artifacts/${artifactId}`,
    `/api/chat/sessions/${session.id}/artifacts/${artifactId}/download`,
  ];
  for (const path of paths) {
    for (const artifactCapability of [
      undefined,
      "malformed",
      other.artifactCapability,
      expired,
    ]) {
      const denied = await api(path, { artifactCapability });
      assert.equal(denied.status, 404, `${path} leaked capability distinction`);
      assert.equal(denied.body.error.code, "ARTIFACT_NOT_FOUND");
    }
  }
  const deletedDenied = await api(
    `/api/chat/sessions/${deleted.id}/artifacts`,
    { artifactCapability: deletedCapability },
  );
  assert.equal(deletedDenied.status, 404);
  assert.equal(deletedDenied.body.error.code, "ARTIFACT_NOT_FOUND");
}

async function proveRetriesAndFailures(input) {
  const retry = await emitThroughAzure(input.client, {
    table: input.table,
    title: "Coffee sales and profit",
    parentArtifactIds: [],
    sourceReferences: [input.tableSourceReference],
    acceptExistingUpload: true,
  });
  assert.equal(retry.artifactId, input.coffeeArtifactId);

  const invented = await input.client.callTool({
    name: "finalize_chart_artifact",
    arguments: {
      schemaVersion: "chart.receipt.v1",
      inputArtifactId: input.coffeeArtifactId,
      sourceContentSha256: input.table.contentSha256,
      rowCount: input.table.rowCount,
      title: "Invented",
      config: {
        selectedChartType: "scatter",
        scatterAxis: { x: ["Invented"], y: ["Profit"] },
      },
      warnings: [],
      receiptSha256: "a".repeat(64),
    },
  });
  assert.equal(invented.isError, true);

  const oversized = await input.client.callTool({
    name: "begin_table_artifact_upload",
    arguments: {
      contentSha256: "a".repeat(64),
      byteSize: 5 * 1024 * 1024 + 1,
      rowCount: 1,
      columns: [{ name: "x", type: "number", nullable: false }],
      parentArtifactIds: [],
      sourceReferences: [],
    },
  });
  assert.equal(oversized.isError, true);

  const malformedBytes = Buffer.from('{"not":"table.v1"}\n', "utf8");
  const malformedBegin = await call(
    input.client,
    "begin_table_artifact_upload",
    {
      contentSha256: sha256(malformedBytes),
      byteSize: malformedBytes.byteLength,
      rowCount: 1,
      columns: [{ name: "x", type: "number", nullable: false }],
      parentArtifactIds: [],
      sourceReferences: [],
    },
  );
  const malformedUpload = await fetch(
    malformedBegin.structuredContent.upload.url,
    {
      method: "PUT",
      headers: malformedBegin.structuredContent.upload.headers,
      body: malformedBytes,
    },
  );
  assert.equal(malformedUpload.status, 201);
  const malformedFinalize = await input.client.callTool({
    name: "finalize_table_artifact",
    arguments: {
      artifactId: malformedBegin.structuredContent.artifactId,
      contentSha256: sha256(malformedBytes),
      title: "Malformed",
      parentArtifactIds: [],
      sourceReferences: [],
    },
  });
  assert.equal(malformedFinalize.isError, true);

  const limited = await call(input.client, "create_query_table_artifact", {
    dataSourceId: input.databaseId,
    sql: "SELECT id, label, value, copy FROM demo.metrics CROSS JOIN (VALUES (1), (2), (3)) AS copies(copy) ORDER BY copy, id",
    maxRows: 2,
    requestId: randomUUID(),
  });
  assert.equal(limited.structuredContent.sourceLimited, true);
  const limitedParent = await input.client.callTool({
    name: "begin_table_artifact_upload",
    arguments: {
      contentSha256: "d".repeat(64),
      byteSize: 10,
      rowCount: 1,
      columns: [{ name: "x", type: "number", nullable: false }],
      parentArtifactIds: [limited.structuredContent.artifact.artifactId],
      sourceReferences: [],
    },
  });
  assert.equal(limitedParent.isError, true);

  const other = await createActiveSession([]);
  const otherScoped = await scopedClient(other);
  const crossSession = await otherScoped.client.callTool({
    name: "get_table_artifact_download_url",
    arguments: { artifactId: input.coffeeArtifactId },
  });
  assert.equal(crossSession.isError, true);
  await otherScoped.client.close();
}

async function emitThroughAzure(
  client,
  {
    table,
    title,
    parentArtifactIds,
    sourceReferences,
    acceptExistingUpload = false,
  },
) {
  const beginArguments = {
    contentSha256: table.contentSha256,
    byteSize: table.byteSize,
    rowCount: table.rowCount,
    columns: table.columns,
    parentArtifactIds,
    sourceReferences,
  };
  assert.equal(JSON.stringify(beginArguments).includes('"rows"'), false);
  const begin = await call(
    client,
    "begin_table_artifact_upload",
    beginArguments,
  );
  assert.equal(
    JSON.stringify(begin.structuredContent).includes('"rows"'),
    false,
  );
  const upload = begin.structuredContent.upload;
  const response = await fetch(upload.url, {
    method: "PUT",
    headers: upload.headers,
    body: table.bytes,
  });
  assert.ok(
    response.status === 201 ||
      (acceptExistingUpload && [403, 409, 412].includes(response.status)),
    `Unexpected Azure upload status ${response.status}`,
  );
  const finalizeArguments = {
    artifactId: begin.structuredContent.artifactId,
    contentSha256: table.contentSha256,
    title,
    parentArtifactIds,
    sourceReferences,
  };
  assert.equal(JSON.stringify(finalizeArguments).includes('"rows"'), false);
  const finalized = await call(
    client,
    "finalize_table_artifact",
    finalizeArguments,
  );
  assert.equal(finalized.structuredContent.contentSha256, table.contentSha256);
  assert.equal(finalized.structuredContent.rowCount, table.rowCount);
  assert.equal(finalized.structuredContent.preview.length <= 30, true);
  return finalized.structuredContent;
}

async function createReadyCoffeeDataSource(bytes) {
  const initiated = await api("/api/data-sources/files/initiate", {
    method: "POST",
    body: {
      name: `${nonce} Coffee Sales`,
      filename: "Coffee_Sales.csv",
      mimeType: "text/csv",
      fileSizeBytes: bytes.byteLength,
    },
  });
  assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
  cleanupDataSourceIds.add(initiated.body.data.id);
  const uploaded = await fetch(initiated.body.upload.url, {
    method: "PUT",
    headers: initiated.body.upload.headers,
    body: bytes,
  });
  assert.equal(uploaded.status, 201);
  const completed = await api(
    `/api/data-sources/${initiated.body.data.id}/complete`,
    { method: "POST" },
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.data.azureETag, uploaded.headers.get("etag"));
  return completed.body.data;
}

async function registerPostgresqlDataSource() {
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
  assert.equal(
    response.body.data.status,
    "ready",
    JSON.stringify(response.body),
  );
  cleanupDataSourceIds.add(response.body.data.id);
  return response.body.data;
}

async function registerMysqlDataSource() {
  const response = await api("/api/data-sources/databases", {
    method: "POST",
    body: {
      connectorType: "mysql",
      name: `${nonce} MySQL exact numbers`,
      mutationMode: "disabled",
      config: {
        host: process.env.E2E_MYSQL_TARGET_HOST || "mysql",
        port: 3306,
        database: "forty_two_demo",
        sslMode: "disable",
      },
      credentials: {
        username: "forty_two_reader",
        password: requiredEnvironment("MYSQL_READER_PASSWORD"),
      },
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(
    response.body.data.status,
    "ready",
    JSON.stringify(response.body),
  );
  cleanupDataSourceIds.add(response.body.data.id);
  return response.body.data;
}

async function createActiveSession(dataSourceIds) {
  const capabilityId = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const created = await createChatSession({
    dataSourceIds,
    maxDataSources: 10,
    capabilityId,
    capabilityExpiresAt: expiresAt,
  });
  const active = await activateChatSession({
    chatSessionId: created.chatSession.id,
    trueforgeSessionId: `artifact-e2e-${randomUUID()}`,
  });
  assert.ok(active);
  cleanupSessionIds.add(active.id);
  return {
    ...active,
    artifactCapability: mintArtifactBrowserCapability({
      chatSessionId: active.id,
      capabilityId: active.capabilityId,
      expiresAt: active.capabilityExpiresAt,
      signingKey,
    }),
  };
}

async function scopedClient(session) {
  const current = await getChatSession({ chatSessionId: session.id });
  assert.ok(current);
  const client = new Client({ name: "artifact-backend-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${mcpUrl}/mcp`),
    {
      requestInit: { headers: { authorization: `Bearer ${mcpAuthToken}` } },
    },
  );
  await client.connect(transport);
  const rawCallTool = client.callTool.bind(client);
  client.callTool = (request) =>
    rawCallTool({
      ...request,
      arguments: { sessionId: current.id, ...(request.arguments ?? {}) },
    });
  return { client };
}

async function call(client, name, arguments_) {
  const result = await client.callTool({ name, arguments: arguments_ });
  if (result.isError) {
    throw new Error(
      `${name} failed: ${result.content?.map((item) => item.text ?? "").join("; ")}`,
    );
  }
  return result;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift();
  assert.ok(headers?.length);
  return rows
    .filter((values) => values.some((candidate) => candidate !== ""))
    .map((values) =>
      Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? ""]),
      ),
    );
}

function requiredNumber(value, rowIndex, column) {
  const number = Number(value);
  assert.ok(
    Number.isFinite(number),
    `${column} row ${rowIndex} was not numeric`,
  );
  return number;
}

async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers["content-type"] = "application/json";
  if (options.artifactCapability) {
    headers.authorization = `Bearer ${options.artifactCapability}`;
  }
  const response = await fetch(`${webUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJsonValue(value[key])]),
    );
  }
  return value;
}

function normalizeUrl(value) {
  return new URL(value).toString().replace(/\/$/, "");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
