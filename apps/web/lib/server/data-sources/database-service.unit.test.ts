import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDatabasePersistenceInput,
  parseDatabaseDataSourceRegistration,
} from "./database-service";
import { publicDataSource } from "./file-service";

const DATA_SOURCE_ID = "ds_01HZX000000000000000000000";
const ENVELOPE = {
  ciphertext: "ciphertext",
  iv: "initialization-vector",
  authTag: "authentication-tag",
  encryptionVersion: 1,
};

test("database registration parses all six strict connector branches", () => {
  const cases = [
    [
      "postgresql",
      { host: "db", database: "app" },
      { username: "u", password: "p" },
    ],
    [
      "mysql",
      { host: "db", database: "app" },
      { username: "u", password: "p" },
    ],
    [
      "sqlserver",
      { host: "db", database: "app" },
      { username: "u", password: "p" },
    ],
    [
      "snowflake",
      { accountId: "account", warehouseId: "warehouse", database: "app" },
      { username: "u", password: "p" },
    ],
    [
      "bigquery",
      { projectId: "sample-project" },
      {
        serviceAccount: {
          clientEmail: "reader@example.test",
          privateKey: "key",
        },
      },
    ],
    [
      "redshift",
      { host: "db", database: "app" },
      { username: "u", password: "p" },
    ],
  ] as const;

  for (const [connectorType, config, credentials] of cases) {
    const parsed = parseDatabaseDataSourceRegistration({
      connectorType,
      name: `${connectorType} source`,
      mutationMode: "controlled",
      mutationAllowlist: [{ table: "metrics" }],
      config,
      credentials,
    });
    assert.equal(parsed.connectorType, connectorType);
    assert.equal(parsed.config.mutationMode, "controlled");
    assert.equal(parsed.config.mutationAllowlist.length, 1);
    assert.equal(parsed.secret.connectorType, connectorType);
    const persistenceInput = buildDatabasePersistenceInput(
      DATA_SOURCE_ID,
      parsed,
      ENVELOPE,
    );
    assert.equal(persistenceInput.connectorType, connectorType);
    assert.equal(persistenceInput.config.mutationMode, "controlled");
    assert.equal(persistenceInput.config.mutationAllowlist.length, 1);
  }
});

test("database registration rejects DSNs, config secrets, duplicate policy, and unknown secret keys", () => {
  const invalid = [
    {
      connectorType: "postgresql",
      name: "DSN",
      config: { host: "postgresql://reader:secret@db/app", database: "app" },
      credentials: { username: "u", password: "p" },
    },
    {
      connectorType: "mysql",
      name: "Config secret",
      config: { host: "db", database: "app", password: "p" },
      credentials: { username: "u", password: "p" },
    },
    {
      connectorType: "sqlserver",
      name: "Duplicate policy",
      mutationMode: "disabled",
      config: { host: "db", database: "app", mutationMode: "controlled" },
      credentials: { username: "u", password: "p" },
    },
    {
      connectorType: "redshift",
      name: "Unknown secret",
      config: { host: "db", database: "app" },
      credentials: { username: "u", password: "p", token: "not-allowed" },
    },
    {
      connectorType: "postgresql",
      name: "Missing controlled allowlist",
      mutationMode: "controlled",
      config: { host: "db", database: "app" },
      credentials: { username: "u", password: "p" },
    },
  ];
  for (const value of invalid) {
    assert.throws(() => parseDatabaseDataSourceRegistration(value));
  }
});

test("database registration serialization excludes Azure cleanup internals", () => {
  const serialized = publicDataSource({
    id: DATA_SOURCE_ID,
    connectorType: "postgresql",
    name: "Analytics",
    status: "ready",
    config: {
      host: "db.internal",
      port: 5432,
      database: "analytics",
      sslMode: "require",
      connectionTimeoutMs: 30_000,
      mutationMode: "disabled",
      mutationAllowlist: [],
    },
    originalFilename: null,
    mimeType: null,
    fileSizeBytes: null,
    azureBlobName: null,
    azureETag: null,
    azureCleanupStatus: null,
    azureCleanupETag: null,
    azureCleanupAttempts: 0,
    azureCleanupCompletedAt: null,
    azureCleanupErrorCode: null,
    processingMessage: null,
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    deletedAt: null,
  });

  for (const internalField of [
    "azureCleanupStatus",
    "azureCleanupETag",
    "azureCleanupAttempts",
    "azureCleanupCompletedAt",
    "azureCleanupErrorCode",
  ]) {
    assert.equal(internalField in serialized, false);
  }
});
