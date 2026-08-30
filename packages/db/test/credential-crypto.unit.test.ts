import assert from "node:assert/strict";
import test from "node:test";

import {
  BigqueryDataSourceConfigSchema,
  DatabaseSecretSchema,
  decryptDatabaseSecret,
  encryptDatabaseSecret,
  generateDataSourceId,
  MysqlDataSourceConfigSchema,
  MutationModeSchema,
  PostgresqlDataSourceConfigSchema,
  RedshiftDataSourceConfigSchema,
  resolveDatabaseMutationTarget,
  SnowflakeDataSourceConfigSchema,
  SqlserverDataSourceConfigSchema,
  type DatabaseConnectorType,
  type DatabaseSecret,
} from "../src/index.js";

const encryptionKey = Buffer.alloc(32, 42).toString("base64");

const secrets: DatabaseSecret[] = [
  { connectorType: "postgresql", username: "reader", password: "secret" },
  { connectorType: "mysql", username: "reader", password: "secret" },
  { connectorType: "sqlserver", username: "reader", password: "secret" },
  {
    connectorType: "snowflake",
    username: "reader",
    password: "secret",
  },
  {
    connectorType: "bigquery",
    serviceAccount: {
      clientEmail: "reader@example.test",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----",
    },
  },
  { connectorType: "redshift", username: "reader", password: "secret" },
];

test("AES-256-GCM round trips all connector secrets with random envelopes", () => {
  for (const secret of secrets) {
    const dataSourceId = generateDataSourceId();
    const first = encryptDatabaseSecret({
      dataSourceId,
      connectorType: secret.connectorType,
      secret,
      encryptionKey,
    });
    const second = encryptDatabaseSecret({
      dataSourceId,
      connectorType: secret.connectorType,
      secret,
      encryptionKey,
    });
    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.deepEqual(
      decryptDatabaseSecret({
        dataSourceId,
        connectorType: secret.connectorType,
        credentials: first,
        encryptionKey,
      }),
      secret,
    );
  }
});

test("credential AAD prevents record and connector transplantation", () => {
  const sourceId = generateDataSourceId();
  const targetId = generateDataSourceId();
  const credentials = encryptDatabaseSecret({
    dataSourceId: sourceId,
    connectorType: "postgresql",
    secret: secrets[0]!,
    encryptionKey,
  });
  assert.throws(
    () =>
      decryptDatabaseSecret({
        dataSourceId: targetId,
        connectorType: "postgresql",
        credentials,
        encryptionKey,
      }),
    /could not be decrypted/,
  );
  assert.throws(
    () =>
      decryptDatabaseSecret({
        dataSourceId: sourceId,
        connectorType: "mysql",
        credentials,
        encryptionKey,
      }),
    /could not be decrypted/,
  );
});

test("strict configs reject secrets, URLs, DSNs, and unknown keys", () => {
  const cases: Array<readonly [DatabaseConnectorType, unknown]> = [
    [
      "postgresql",
      { host: "postgresql://reader:secret@db/app", database: "app" },
    ],
    ["mysql", { host: "db", database: "app", password: "secret" }],
    ["sqlserver", { host: "db", database: "app", dsn: "secret" }],
    [
      "snowflake",
      {
        accountId: "https://account.snowflakecomputing.com",
        warehouseId: "compute",
        database: "app",
      },
    ],
    ["bigquery", { projectId: "https://example.test/project" }],
    ["redshift", { host: "db", database: "app", username: "reader" }],
  ];
  const schemas = {
    postgresql: PostgresqlDataSourceConfigSchema,
    mysql: MysqlDataSourceConfigSchema,
    sqlserver: SqlserverDataSourceConfigSchema,
    snowflake: SnowflakeDataSourceConfigSchema,
    bigquery: BigqueryDataSourceConfigSchema,
    redshift: RedshiftDataSourceConfigSchema,
  };
  for (const [connectorType, value] of cases) {
    assert.equal(schemas[connectorType].safeParse(value).success, false);
  }
});

test("mutation policy is extensible and defaults disabled for every connector", () => {
  assert.equal(MutationModeSchema.parse("controlled"), "controlled");
  assert.equal(
    MysqlDataSourceConfigSchema.parse({ host: "db", database: "app" })
      .mutationMode,
    "disabled",
  );
  assert.equal(
    BigqueryDataSourceConfigSchema.parse({
      projectId: "sample-project",
      mutationMode: "controlled",
      mutationAllowlist: [{ schema: "analytics", table: "metrics" }],
    }).mutationMode,
    "controlled",
  );
  assert.equal(
    BigqueryDataSourceConfigSchema.safeParse({
      projectId: "sample-project",
      mutationMode: "controlled",
    }).success,
    false,
  );
});

test("controlled mutation allowlists resolve exactly one table for all connectors", () => {
  const cases = [
    ["postgresql", { host: "db", database: "app", schema: "public" }],
    ["mysql", { host: "db", database: "app" }],
    ["sqlserver", { host: "db", database: "app" }],
    [
      "snowflake",
      { accountId: "account", warehouseId: "warehouse", database: "app" },
    ],
    ["bigquery", { projectId: "project" }],
    ["redshift", { host: "db", database: "app" }],
  ] as const;
  for (const [connectorType, baseConfig] of cases) {
    const config = {
      ...baseConfig,
      mutationMode: "controlled" as const,
      mutationAllowlist: [{ schema: "analytics", table: "metrics" }],
    };
    assert.deepEqual(
      resolveDatabaseMutationTarget({
        connectorType,
        config,
        target: { catalog: null, schema: null, table: "METRICS" },
      }),
      {
        catalog:
          connectorType === "bigquery"
            ? "project"
            : "database" in baseConfig
              ? baseConfig.database
              : null,
        schema: "analytics",
        table: "metrics",
      },
      connectorType,
    );
    assert.equal(
      resolveDatabaseMutationTarget({
        connectorType,
        config,
        target: { catalog: null, schema: null, table: "other" },
      }),
      null,
      connectorType,
    );
  }
});

test("connector secret schemas reject unknown or mismatched material", () => {
  assert.equal(
    DatabaseSecretSchema.safeParse({
      connectorType: "postgresql",
      username: "reader",
      password: "secret",
      token: "not-allowed",
    }).success,
    false,
  );
  assert.throws(() =>
    encryptDatabaseSecret({
      dataSourceId: generateDataSourceId(),
      connectorType: "mysql",
      secret: secrets[0]!,
      encryptionKey,
    }),
  );
});
