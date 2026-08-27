import assert from "node:assert/strict";
import test from "node:test";

import {
  loadServerConfig,
  parseAllowedOrigins,
  parseConnections,
} from "../src/config.js";

test("requires a service authentication token", () => {
  assert.throws(() => loadServerConfig({}), /MCP_AUTH_TOKEN is required/);
});

test("keeps the maximum drain deadline below the Compose grace period", () => {
  assert.equal(
    loadServerConfig({
      MCP_AUTH_TOKEN: "test-token",
      SHUTDOWN_TIMEOUT_MS: "20000",
    }).shutdownTimeoutMs,
    20_000,
  );
  assert.throws(
    () =>
      loadServerConfig({
        MCP_AUTH_TOKEN: "test-token",
        SHUTDOWN_TIMEOUT_MS: "20001",
      }),
    /SHUTDOWN_TIMEOUT_MS/,
  );
});

test("loads server-side connection configuration without exposing defaults", () => {
  const config = loadServerConfig({
    MCP_AUTH_TOKEN: "test-token",
    PORT: "9000",
    DATA_SOURCE_CONNECTIONS_JSON: JSON.stringify([
      {
        name: "analytics",
        type: "postgres",
        credentials: {
          type: "postgres",
          host: "database.internal",
          default_database: "analytics",
          username: "reader",
          password: "secret",
        },
        policy: { maxRows: 250, queryTimeoutMs: 15_000 },
      },
    ]),
  });

  assert.equal(config.port, 9000);
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.shutdownTimeoutMs, 15_000);
  assert.equal(config.connections[0]?.name, "analytics");
  assert.deepEqual(config.connections[0]?.policy, {
    maxRows: 250,
    queryTimeoutMs: 15_000,
  });
});

test("provisions the Compose PostgreSQL source when no custom JSON is supplied", () => {
  const config = loadServerConfig({
    MCP_AUTH_TOKEN: "test-token",
    PLATFORM_POSTGRES_HOST: "postgres",
    PLATFORM_POSTGRES_USER: "forty_two",
    PLATFORM_POSTGRES_PASSWORD: "database-secret",
    PLATFORM_POSTGRES_DATABASE: "forty_two",
  });

  assert.equal(config.connections.length, 1);
  assert.equal(config.connections[0]?.name, "local-postgres");
  assert.equal(config.connections[0]?.type, "postgres");
  assert.equal(
    config.connections[0]?.credentials.default_database,
    "forty_two",
  );
});

test("normalizes allowed HTTP origins and rejects URL-like impostors", () => {
  assert.deepEqual(
    parseAllowedOrigins("https://Example.com:443,http://localhost:3000"),
    ["https://example.com", "http://localhost:3000"],
  );
  for (const invalid of [
    "*",
    "example.com",
    "https://example.com/path",
    "https://user@example.com",
    "https://example.com,",
  ]) {
    assert.throws(() => parseAllowedOrigins(invalid), /invalid|empty/i);
  }
});

test("rejects credentials that could change connector security behavior", () => {
  const invalidCredentials = [
    {
      type: "bigquery",
      project_id: "project-a",
      service_account_key: true,
    },
    {
      type: "bigquery",
      project_id: "project-a",
      service_account_key: "{}",
    },
    {
      type: "postgres",
      host: "db",
      default_database: "app",
      username: "reader",
      password: "secret",
      ssl: { rejectUnauthorized: "false" },
    },
    {
      type: "mysql",
      host: "db",
      default_database: "app",
      username: "reader",
      password: "secret",
      connection_timeout: "1000",
    },
    {
      type: "sqlserver",
      server: "db",
      default_database: "app",
      username: "reader",
      password: "secret",
      encrypt: "false",
    },
    {
      type: "redshift",
      host: "db",
      default_database: "app",
      username: "reader",
      password: "secret",
      ssl: {},
    },
    {
      type: "snowflake",
      account_id: "account",
      warehouse_id: "warehouse",
      username: "reader",
      password: "secret",
      default_database: "app",
      custom_host: true,
    },
  ];

  for (const credentials of invalidCredentials) {
    assert.throws(
      () =>
        parseConnections(
          JSON.stringify([
            {
              name: "hostile",
              type: credentials.type,
              credentials,
            },
          ]),
        ),
      /invalid credentials/i,
    );
  }
});

test("rejects duplicate, invalid, and mismatched connections", () => {
  const postgres = {
    name: "analytics",
    type: "postgres",
    credentials: {
      type: "postgres",
      host: "database.internal",
      default_database: "analytics",
      username: "reader",
      password: "secret",
    },
  };

  assert.throws(
    () => parseConnections(JSON.stringify([postgres, postgres])),
    /Duplicate connection name/,
  );
  assert.throws(
    () =>
      parseConnections(
        JSON.stringify([
          {
            ...postgres,
            type: "mysql",
          },
        ]),
      ),
    /type does not match/i,
  );
  assert.throws(
    () =>
      parseConnections(
        JSON.stringify([
          {
            ...postgres,
            policy: { maxRows: Number.NaN },
          },
        ]),
      ),
    /maxRows/,
  );
});
