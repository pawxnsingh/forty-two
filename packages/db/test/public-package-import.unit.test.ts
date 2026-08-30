import assert from "node:assert/strict";
import test from "node:test";

const SYNTHETIC_ENVELOPE = {
  ciphertext: "c3ludGhldGlj",
  iv: "c3ludGhldGljLWl2",
  authTag: "c3ludGhldGljLXRhZw",
  encryptionVersion: 1,
};

test("built public package imports and validates every database connector", async () => {
  const databasePackage = await import("@forty-two/db");
  const dataSourceId = databasePackage.generateDataSourceId();
  const valid = [
    ["postgresql", { host: "db", database: "app" }],
    ["mysql", { host: "db", database: "app" }],
    ["sqlserver", { host: "db", database: "app" }],
    [
      "snowflake",
      { accountId: "account", warehouseId: "warehouse", database: "app" },
    ],
    ["bigquery", { projectId: "sample-project" }],
    ["redshift", { host: "db", database: "app" }],
  ] as const;

  for (const [connectorType, config] of valid) {
    const parsed = databasePackage.CreateDatabaseDataSourceInputSchema.parse({
      dataSourceId,
      connectorType,
      name: `${connectorType} source`,
      config,
      credentials: SYNTHETIC_ENVELOPE,
    });
    assert.equal(parsed.connectorType, connectorType);
    assert.equal(parsed.config.mutationMode, "disabled");
  }

  assert.equal(
    databasePackage.ListReadyDataSourcesInputSchema.safeParse({
      connectorTypes: valid.map(([connectorType]) => connectorType),
    }).success,
    true,
  );

  assert.equal(
    databasePackage.CreateDatabaseDataSourceInputSchema.safeParse({
      dataSourceId,
      connectorType: "mysql",
      name: "mismatched",
      config: { projectId: "sample-project" },
      credentials: SYNTHETIC_ENVELOPE,
    }).success,
    false,
  );
  assert.equal(
    databasePackage.CreateDatabaseDataSourceInputSchema.safeParse({
      dataSourceId,
      connectorType: "postgresql",
      name: "secret in config",
      config: { host: "db", database: "app", password: "plaintext" },
      credentials: SYNTHETIC_ENVELOPE,
    }).success,
    false,
  );

  const projected = databasePackage.parseDatabaseDataSource({
    id: dataSourceId,
    connectorType: "postgresql",
    name: "Projected source",
    status: "ready",
    config: { host: "db", database: "app" },
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
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
  assert.equal(projected.id, dataSourceId);
  assert.equal(projected.azureCleanupStatus, null);
  assert.equal(projected.azureCleanupAttempts, 0);
});
