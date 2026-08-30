import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DataSourceConfigSchema,
  PostgresqlDataSourceConfigSchema,
} from "../src/index.js";

describe("PostgreSQL datasource config", () => {
  it("accepts and normalizes only the supported non-secret shape", () => {
    assert.deepEqual(
      PostgresqlDataSourceConfigSchema.parse({
        host: "analytics.internal",
        database: "analytics",
        schema: "reporting",
        sslMode: "require",
      }),
      {
        host: "analytics.internal",
        port: 5432,
        database: "analytics",
        schema: "reporting",
        sslMode: "require",
        connectionTimeoutMs: 10_000,
        mutationMode: "disabled",
        mutationAllowlist: [],
      },
    );
  });

  it("rejects URLs, credential aliases, unknown keys, and nested config", () => {
    const invalidConfigs: unknown[] = [
      { url: "postgresql://reader:plaintext@db/demo" },
      { host: "db", database: "demo", pwd: "plaintext" },
      { host: "db", database: "demo", "P-W_D": "plaintext" },
      { host: "db", database: "demo", username: "reader" },
      { host: "db", database: "demo", connectionString: "secret" },
      { host: "db", database: "demo", token: "secret" },
      { host: "db", database: "demo", nested: { password: "secret" } },
      {
        host: "postgresql://reader:plaintext@db/demo",
        database: "demo",
      },
    ];

    for (const config of invalidConfigs) {
      assert.equal(
        PostgresqlDataSourceConfigSchema.safeParse(config).success,
        false,
        `Expected config to be rejected: ${JSON.stringify(config)}`,
      );
      assert.equal(DataSourceConfigSchema.safeParse(config).success, false);
    }
  });
});
