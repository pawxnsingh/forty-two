import assert from "node:assert/strict";
import test from "node:test";

import { loadServerConfig, parseConnections } from "../src/config.js";

test("requires a service authentication token", () => {
  assert.throws(() => loadServerConfig({}), /MCP_AUTH_TOKEN is required/);
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
  assert.equal(config.connections[0]?.name, "analytics");
  assert.deepEqual(config.connections[0]?.policy, {
    maxRows: 250,
    queryTimeoutMs: 15_000,
  });
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
