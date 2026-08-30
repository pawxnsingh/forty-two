import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  closeDatabase,
  createDatabaseDataSource,
  encryptDatabaseSecret,
  generateDataSourceId,
  getDataSourceCredentials,
  initializeDatabase,
  migrateDatabase,
  rotateDataSourceCredentials,
  softDeleteDataSource,
  updateDataSourceLifecycle,
} from "../packages/db/dist/index.js";
import { MySQLAdapter } from "../packages/data-source/dist/adapters/mysql.js";
import { PostgreSQLAdapter } from "../packages/data-source/dist/adapters/postgresql.js";
import { SQLServerAdapter } from "../packages/data-source/dist/adapters/sqlserver.js";
import { DataSourceType } from "../packages/data-source/dist/types/credentials.js";

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
const authToken = requiredEnvironment("MCP_AUTH_TOKEN");
const encryptionKey = requiredEnvironment(
  "DATA_SOURCE_CREDENTIALS_ENCRYPTION_KEY",
);
const databaseUrl = resolveControlDatabaseUrl();
const nonce = `database-e2e-${Date.now()}-${process.pid}`;
const cleanupIds = new Set();
let applicationSessionId;
const client = new Client({ name: "database-e2e", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${authToken}` } },
});

try {
  initializeDatabase({ connectionString: databaseUrl, maxConnections: 2 });
  await migrateDatabase();
  await client.connect(transport);
  await run();
  console.log(
    "Database datasource E2E passed against live HTTP/MCP PostgreSQL, MySQL, and SQL Server services.",
  );
} catch (error) {
  process.exitCode = 1;
  console.error(`Database datasource E2E failed: ${safeMessage(error)}`);
} finally {
  await client.close().catch(() => undefined);
  if (applicationSessionId) {
    await api(`/api/chat/sessions/${applicationSessionId}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
  for (const dataSourceId of cleanupIds) {
    await softDeleteDataSource({ dataSourceId }).catch(() => undefined);
  }
  await closeDatabase().catch(() => undefined);
}

async function run() {
  console.log("E2E stage: testing-only internal validation");
  let testing = await createTestingPostgres();
  cleanupIds.add(testing.id);

  const internal = await fetch(
    `${mcpUrl}/internal/data-sources/${encodeURIComponent(testing.id)}/validate`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    },
  );
  assert.equal(internal.status, 200);
  const internalBody = await internal.json();
  assert.equal(internalBody.data.connected, true);
  const readyTesting = await updateDataSourceLifecycle({
    dataSourceId: testing.id,
    fromStatus: "testing",
    toStatus: "ready",
  });
  assert.ok(readyTesting);
  testing = readyTesting;

  console.log("E2E stage: public registration for three live connectors");
  const postgres = await register({
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
  });
  const mysql = await register({
    connectorType: "mysql",
    name: `${nonce} MySQL`,
    mutationMode: "controlled",
    mutationAllowlist: [{ table: "metrics" }],
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
  });
  const sqlserver = await register({
    connectorType: "sqlserver",
    name: `${nonce} SQL Server`,
    config: {
      host: process.env.E2E_SQLSERVER_TARGET_HOST || "sqlserver",
      port: 1433,
      database: "forty_two_demo",
      encrypt: true,
      trustServerCertificate: true,
    },
    credentials: {
      username: "forty_two_reader",
      password: requiredEnvironment("SQLSERVER_READER_PASSWORD"),
    },
  });

  const session = await api("/api/chat/sessions", {
    method: "POST",
    body: { dataSourceIds: [testing.id, postgres.id, mysql.id, sqlserver.id] },
  });
  assert.equal(session.status, 201, JSON.stringify(session.body));
  applicationSessionId = session.body.data.id;

  console.log("E2E stage: ready-only dynamic discovery and reads");
  for (const source of [testing, postgres, mysql, sqlserver]) {
    cleanupIds.add(source.id);
    assert.equal(source.status, "ready");
    assert.equal(await isListed(source.id), true);
  }
  assert.equal(
    (await read(testing.id, "SELECT value FROM demo.metrics")).rows[0].value,
    42,
  );
  assert.equal(
    (await read(postgres.id, "SELECT value FROM demo.metrics")).rows[0].value,
    42,
  );
  assert.equal(
    (await read(mysql.id, "SELECT value FROM metrics")).rows[0].value,
    42,
  );
  assert.equal(
    (await read(sqlserver.id, "SELECT value FROM dbo.metrics")).rows[0].value,
    42,
  );

  console.log("E2E stage: MCP mutation rejection for three connectors");
  for (const attemptedMutation of [
    {
      dataSource: postgres.id,
      sql: "UPDATE demo.metrics SET value = 0 WHERE id = 1",
      verify: "SELECT value FROM demo.metrics",
    },
    {
      dataSource: mysql.id,
      sql: "UPDATE metrics SET value = 0 WHERE id = 1",
      verify: "SELECT value FROM metrics",
    },
    {
      dataSource: sqlserver.id,
      sql: "UPDATE dbo.metrics SET value = 0 WHERE id = 1",
      verify: "SELECT value FROM dbo.metrics",
    },
  ]) {
    const blockedMutation = await call("run_read_query", {
      dataSource: attemptedMutation.dataSource,
      sql: attemptedMutation.sql,
    });
    assert.equal(blockedMutation.isError, true);
    assert.equal(
      (await read(attemptedMutation.dataSource, attemptedMutation.verify))
        .rows[0].value,
      42,
    );
  }

  console.log("E2E stage: database/driver read-only with demo writers");
  await proveDatabaseEnforcedReadOnlyWithWriterCredentials();

  console.log("E2E stage: credential revision cache replacement");
  await proveCacheRotation(postgres);
  console.log("E2E stage: sanitized failed registration");
  await proveBadSecretIsSanitized();

  console.log("E2E stage: soft-delete cache invalidation");
  await softDeleteDataSource({ dataSourceId: postgres.id });
  cleanupIds.delete(postgres.id);
  await assertUnavailable(postgres.id);
  assert.equal(await isListed(postgres.id), false);

  console.log("E2E stage: credential-gated live cloud suites");
  await runCloudSuites();
}

async function proveDatabaseEnforcedReadOnlyWithWriterCredentials() {
  const checks = [
    {
      adapter: new PostgreSQLAdapter(),
      readerAdapter: new PostgreSQLAdapter(),
      credentials: {
        type: DataSourceType.PostgreSQL,
        host: process.env.E2E_POSTGRES_TARGET_HOST || "postgres",
        port: Number(process.env.POSTGRES_PORT || 5432),
        database: process.env.POSTGRES_DB || "forty_two",
        schema: "demo",
        ssl: false,
        username: "forty_two_writer",
        password: requiredEnvironment("POSTGRES_WRITER_PASSWORD"),
      },
      readerCredentials: {
        type: DataSourceType.PostgreSQL,
        host: process.env.E2E_POSTGRES_TARGET_HOST || "postgres",
        port: Number(process.env.POSTGRES_PORT || 5432),
        database: process.env.POSTGRES_DB || "forty_two",
        schema: "demo",
        ssl: false,
        username: "forty_two_reader",
        password: requiredEnvironment("POSTGRES_READER_PASSWORD"),
      },
      write: "UPDATE demo.metrics SET value = 43 WHERE id = 1",
      restore: "UPDATE demo.metrics SET value = 42 WHERE id = 1",
      blocked: "UPDATE demo.metrics SET value = 0 WHERE id = 1",
      verify: "SELECT value FROM demo.metrics WHERE id = 1",
      ddl: "CREATE TABLE demo.forbidden_writer_ddl (id integer)",
    },
    {
      adapter: new MySQLAdapter(),
      readerAdapter: new MySQLAdapter(),
      credentials: {
        type: DataSourceType.MySQL,
        host: process.env.E2E_MYSQL_TARGET_HOST || "mysql",
        port: Number(process.env.MYSQL_PORT || 3306),
        default_database: "forty_two_demo",
        ssl: false,
        username: "forty_two_writer",
        password: requiredEnvironment("MYSQL_WRITER_PASSWORD"),
      },
      readerCredentials: {
        type: DataSourceType.MySQL,
        host: process.env.E2E_MYSQL_TARGET_HOST || "mysql",
        port: Number(process.env.MYSQL_PORT || 3306),
        default_database: "forty_two_demo",
        ssl: false,
        username: "forty_two_reader",
        password: requiredEnvironment("MYSQL_READER_PASSWORD"),
      },
      write: "UPDATE metrics SET value = 43 WHERE id = 1",
      restore: "UPDATE metrics SET value = 42 WHERE id = 1",
      blocked: "UPDATE metrics SET value = 0 WHERE id = 1",
      verify: "SELECT value FROM metrics WHERE id = 1",
      ddl: "CREATE TABLE forbidden_writer_ddl (id integer)",
    },
    {
      adapter: new SQLServerAdapter(),
      readerAdapter: new SQLServerAdapter(),
      credentials: {
        type: DataSourceType.SQLServer,
        server: process.env.E2E_SQLSERVER_TARGET_HOST || "sqlserver",
        port: Number(process.env.SQLSERVER_PORT || 1433),
        default_database: "forty_two_demo",
        encrypt: true,
        trust_server_certificate: true,
        username: "forty_two_writer",
        password: requiredEnvironment("SQLSERVER_WRITER_PASSWORD"),
      },
      readerCredentials: {
        type: DataSourceType.SQLServer,
        server: process.env.E2E_SQLSERVER_TARGET_HOST || "sqlserver",
        port: Number(process.env.SQLSERVER_PORT || 1433),
        default_database: "forty_two_demo",
        encrypt: true,
        trust_server_certificate: true,
        username: "forty_two_reader",
        password: requiredEnvironment("SQLSERVER_READER_PASSWORD"),
      },
      write: "UPDATE dbo.metrics SET value = 43 WHERE id = 1",
      restore: "UPDATE dbo.metrics SET value = 42 WHERE id = 1",
      blocked: "UPDATE dbo.metrics SET value = 0 WHERE id = 1",
      verify: "SELECT value FROM dbo.metrics WHERE id = 1",
      ddl: "CREATE TABLE dbo.forbidden_writer_ddl (id integer)",
    },
  ];

  for (const check of checks) {
    await check.readerAdapter.initialize(check.readerCredentials);
    try {
      await assert.rejects(check.readerAdapter.query(check.blocked));
      assert.equal(
        (await check.readerAdapter.query(check.verify)).rows[0].value,
        42,
      );
    } finally {
      await check.readerAdapter.close();
    }

    await check.adapter.initialize(check.credentials);
    try {
      await check.adapter.query(check.write);
      assert.equal((await check.adapter.query(check.verify)).rows[0].value, 43);
      await check.adapter.query(check.restore);
      assert.equal((await check.adapter.query(check.verify)).rows[0].value, 42);
      await assert.rejects(check.adapter.query(check.ddl));
      await check.adapter.queryReadOnly(check.blocked).catch(() => undefined);
      const verified = await check.adapter.query(check.verify);
      assert.equal(verified.rows[0].value, 42);
    } finally {
      await check.adapter.query(check.restore).catch(() => undefined);
      await check.adapter.close();
    }
  }
}

async function createTestingPostgres() {
  const id = generateDataSourceId();
  const connectorType = "postgresql";
  const secret = {
    connectorType,
    username: "forty_two_reader",
    password: requiredEnvironment("POSTGRES_READER_PASSWORD"),
  };
  return createDatabaseDataSource({
    dataSourceId: id,
    connectorType,
    name: `${nonce} testing PostgreSQL`,
    config: {
      host: process.env.E2E_POSTGRES_TARGET_HOST || "postgres",
      port: 5432,
      database: process.env.POSTGRES_DB || "forty_two",
      schema: "demo",
      sslMode: "disable",
      connectionTimeoutMs: 10_000,
      mutationMode: "disabled",
    },
    credentials: encryptDatabaseSecret({
      dataSourceId: id,
      connectorType,
      secret,
      encryptionKey,
    }),
  });
}

async function proveCacheRotation(source) {
  const current = await getDataSourceCredentials({ dataSourceId: source.id });
  assert.ok(current);
  const badSecret = {
    connectorType: "postgresql",
    username: "forty_two_reader",
    password: `${nonce}-bad`,
  };
  const badRotation = await rotateDataSourceCredentials({
    dataSourceId: source.id,
    expectedRevision: current.revision,
    credentials: encryptDatabaseSecret({
      dataSourceId: source.id,
      connectorType: "postgresql",
      secret: badSecret,
      encryptionKey,
    }),
  });
  assert.ok(badRotation);
  assert.equal(badRotation.revision, current.revision + 1);
  await assertUnavailable(source.id);

  const goodSecret = {
    connectorType: "postgresql",
    username: "forty_two_reader",
    password: requiredEnvironment("POSTGRES_READER_PASSWORD"),
  };
  const goodRotation = await rotateDataSourceCredentials({
    dataSourceId: source.id,
    expectedRevision: badRotation.revision,
    credentials: encryptDatabaseSecret({
      dataSourceId: source.id,
      connectorType: "postgresql",
      secret: goodSecret,
      encryptionKey,
    }),
  });
  assert.equal(goodRotation?.revision, badRotation.revision + 1);
  assert.equal(
    (await read(source.id, "SELECT value FROM demo.metrics")).rows[0].value,
    42,
  );
}

async function proveBadSecretIsSanitized() {
  const marker = `${nonce}-must-not-leak`;
  const response = await api("/api/data-sources/databases", {
    method: "POST",
    body: {
      connectorType: "postgresql",
      name: `${nonce} bad credentials`,
      config: {
        host: process.env.E2E_POSTGRES_TARGET_HOST || "postgres",
        database: process.env.POSTGRES_DB || "forty_two",
        sslMode: "disable",
      },
      credentials: { username: "forty_two_reader", password: marker },
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.status, "failed");
  assert.equal(JSON.stringify(response.body).includes(marker), false);
  cleanupIds.add(response.body.data.id);
  assert.equal(await isListed(response.body.data.id), false);
  await assertUnavailable(response.body.data.id);
}

async function runCloudSuites() {
  await cloudSuite(
    "Snowflake",
    [
      "SNOWFLAKE_ACCOUNT_ID",
      "SNOWFLAKE_WAREHOUSE_ID",
      "SNOWFLAKE_DATABASE",
      "SNOWFLAKE_USERNAME",
      "SNOWFLAKE_PASSWORD",
    ],
    () => ({
      connectorType: "snowflake",
      name: `${nonce} Snowflake`,
      config: {
        accountId: process.env.SNOWFLAKE_ACCOUNT_ID,
        warehouseId: process.env.SNOWFLAKE_WAREHOUSE_ID,
        database: process.env.SNOWFLAKE_DATABASE,
      },
      credentials: {
        username: process.env.SNOWFLAKE_USERNAME,
        password: process.env.SNOWFLAKE_PASSWORD,
      },
    }),
  );
  await cloudSuite(
    "BigQuery",
    ["BIGQUERY_PROJECT_ID", "BIGQUERY_SERVICE_ACCOUNT_JSON"],
    () => {
      const serviceAccount = JSON.parse(
        process.env.BIGQUERY_SERVICE_ACCOUNT_JSON,
      );
      return {
        connectorType: "bigquery",
        name: `${nonce} BigQuery`,
        config: {
          projectId: process.env.BIGQUERY_PROJECT_ID,
          location: process.env.BIGQUERY_LOCATION || "US",
        },
        credentials: {
          serviceAccount: {
            clientEmail: serviceAccount.client_email,
            privateKey: serviceAccount.private_key,
            privateKeyId: serviceAccount.private_key_id,
            clientId: serviceAccount.client_id,
          },
        },
      };
    },
  );
  await cloudSuite(
    "Redshift",
    [
      "REDSHIFT_HOST",
      "REDSHIFT_DATABASE",
      "REDSHIFT_USERNAME",
      "REDSHIFT_PASSWORD",
    ],
    () => ({
      connectorType: "redshift",
      name: `${nonce} Redshift`,
      config: {
        host: process.env.REDSHIFT_HOST,
        port: Number(process.env.REDSHIFT_PORT || 5439),
        database: process.env.REDSHIFT_DATABASE,
        ssl: true,
      },
      credentials: {
        username: process.env.REDSHIFT_USERNAME,
        password: process.env.REDSHIFT_PASSWORD,
      },
    }),
  );
}

async function cloudSuite(label, requiredNames, requestFactory) {
  if (!requiredNames.every((name) => process.env[name]?.trim())) {
    console.log(
      `SKIP ${label} live-cloud suite: credentials are not configured.`,
    );
    return;
  }
  const source = await register(requestFactory());
  cleanupIds.add(source.id);
  assert.equal(source.status, "ready");
  assert.equal((await read(source.id, "SELECT 1 AS value")).rows[0].value, 1);
}

async function register(body) {
  const response = await api("/api/data-sources/databases", {
    method: "POST",
    body,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const serialized = JSON.stringify(response.body);
  for (const value of secretStrings(body.credentials)) {
    assert.equal(serialized.includes(value), false);
  }
  return response.body.data;
}

async function read(dataSource, sql) {
  const response = await call("run_read_query", {
    dataSource,
    sql,
    maxRows: 10,
  });
  if (response.isError === true) {
    const message = response.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("; ");
    throw new Error(`MCP read failed: ${message || "sanitized failure"}`);
  }
  return response.structuredContent;
}

async function assertUnavailable(dataSource) {
  const response = await call("run_read_query", {
    dataSource,
    sql: "SELECT 1 AS value",
  });
  assert.equal(response.isError, true);
}

async function isListed(dataSource) {
  const response = await call("list_data_sources", {});
  assert.notEqual(response.isError, true);
  return response.structuredContent.dataSources.some(
    (source) => source.name === dataSource,
  );
}

function call(name, arguments_) {
  assert.match(applicationSessionId, /^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
  const { dataSource, ...rest } = arguments_;
  return client.callTool({
    name,
    arguments: {
      sessionId: applicationSessionId,
      ...rest,
      ...(dataSource ? { dataSourceId: dataSource } : {}),
    },
  });
}

async function api(path, options = {}) {
  const response = await fetch(`${webUrl}${path}`, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function normalizeUrl(value) {
  const url = new URL(value);
  return url.toString().replace(/\/$/, "");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function resolveControlDatabaseUrl() {
  const configured = process.env.DATABASE_URL?.trim();
  if (configured) return configured;

  const username = process.env.POSTGRES_USER?.trim() || "forty_two";
  const password = requiredEnvironment("POSTGRES_PASSWORD");
  const database = process.env.POSTGRES_DB?.trim() || "forty_two";
  const port = process.env.POSTGRES_PORT?.trim() || "5432";
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${encodeURIComponent(port)}/${encodeURIComponent(database)}`;
}

function secretStrings(value) {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(secretStrings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(secretStrings);
  }
  return [];
}

function safeMessage(error) {
  if (!(error instanceof Error)) return "Unknown test failure";
  return error.message.replace(/:\/\/[^\s@]+@/g, "://[redacted]@");
}
