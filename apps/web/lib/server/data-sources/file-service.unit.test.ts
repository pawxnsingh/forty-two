import assert from "node:assert/strict";
import test from "node:test";

import type { DataSource } from "@forty-two/db";

import { DataSourceApiError, deletePublicDataSource } from "./file-service";
import type { FileDataSourceServerConfig } from "./config";

const CONFIG: FileDataSourceServerConfig = {
  azureAccountName: "dummy42account",
  azureAccountKey: Buffer.alloc(32).toString("base64"),
  azureContainer: "dummy42",
  allowedOrigins: ["https://forty-two.example"],
  maxFileSizeBytes: 1024,
  uploadSasTtlSeconds: 300,
};

const SOURCE_ID = "ds_01HZX000000000000000000000";
const OTHER_SOURCE_ID = "ds_01HZX000000000000000000001";
const SOURCE_BLOB = `data-sources/${SOURCE_ID}/source.csv`;
const OTHER_BLOB = `data-sources/${OTHER_SOURCE_ID}/source.csv`;

type DeleteDependencies = NonNullable<
  Parameters<typeof deletePublicDataSource>[1]
>;

function fileDataSource(
  overrides: Partial<DataSource> = {},
): DataSource & { connectorType: "csv" } {
  return {
    id: SOURCE_ID,
    connectorType: "csv",
    name: "Source",
    status: "ready",
    config: {},
    originalFilename: "source.csv",
    mimeType: "text/csv",
    fileSizeBytes: 42,
    azureBlobName: SOURCE_BLOB,
    azureETag: '"generation-one"',
    azureCleanupStatus: null,
    azureCleanupETag: null,
    azureCleanupAttempts: 0,
    azureCleanupCompletedAt: null,
    azureCleanupErrorCode: null,
    processingMessage: null,
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  } as DataSource & { connectorType: "csv" };
}

function fakeDeletionDependencies(input: {
  initial: DataSource;
  getProperties?: DeleteDependencies["getBlobProperties"];
  deleteBlob?: DeleteDependencies["deleteBlobIfMatch"];
}) {
  let state = structuredClone(input.initial);
  const deleteCalls: Array<{ blobName: string; ifMatch: string }> = [];
  const dependencies: DeleteDependencies = {
    async ensureDatabase() {},
    async beginDataSourceDeletion({ dataSourceId }) {
      if (dataSourceId !== state.id) return null;
      if (state.status !== "deleted") {
        const isFile =
          state.connectorType === "csv" || state.connectorType === "xlsx";
        state = {
          ...state,
          status: "deleted",
          deletedAt: new Date(),
          azureCleanupStatus: isFile ? "pending" : null,
          azureCleanupETag: isFile ? state.azureETag : null,
          azureCleanupAttempts: 0,
          azureCleanupCompletedAt: null,
          azureCleanupErrorCode: null,
        };
      }
      return structuredClone(state);
    },
    async getDataSource({ dataSourceId }) {
      return dataSourceId === state.id ? structuredClone(state) : null;
    },
    async pinDataSourceBlobCleanupETag({
      dataSourceId,
      azureBlobName,
      azureETag,
    }) {
      if (
        dataSourceId !== state.id ||
        azureBlobName !== state.azureBlobName ||
        state.azureCleanupStatus !== "pending" ||
        state.azureCleanupETag !== null
      ) {
        return null;
      }
      state = { ...state, azureCleanupETag: azureETag };
      return structuredClone(state);
    },
    async recordDataSourceBlobCleanupAttempt(attempt) {
      if (
        attempt.dataSourceId !== state.id ||
        attempt.azureBlobName !== state.azureBlobName ||
        attempt.expectedAzureETag !== state.azureCleanupETag ||
        state.azureCleanupStatus !== "pending"
      ) {
        return null;
      }
      state = {
        ...state,
        azureCleanupStatus: attempt.outcome,
        azureCleanupAttempts: state.azureCleanupAttempts + 1,
        azureCleanupCompletedAt:
          attempt.outcome === "pending" ? null : new Date(),
        azureCleanupErrorCode: attempt.errorCode ?? null,
      };
      return structuredClone(state);
    },
    readConfig: () => CONFIG,
    getBlobProperties:
      input.getProperties ??
      (async () =>
        ({ etag: '"generation-one"' }) as Awaited<
          ReturnType<DeleteDependencies["getBlobProperties"]>
        >),
    async deleteBlobIfMatch(deleteInput) {
      deleteCalls.push({
        blobName: deleteInput.blobName,
        ifMatch: deleteInput.ifMatch,
      });
      return input.deleteBlob
        ? input.deleteBlob(deleteInput)
        : Promise.resolve("deleted");
    },
    getAzureStatusCode(error) {
      return typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    },
  };
  return {
    dependencies,
    deleteCalls,
    state: () => structuredClone(state),
  };
}

test("transient Azure failure remains retryable after local revocation", async () => {
  let attempts = 0;
  const harness = fakeDeletionDependencies({
    initial: fileDataSource(),
    deleteBlob: async () => {
      attempts += 1;
      if (attempts === 1) throw { statusCode: 503 };
      return "deleted";
    },
  });

  await assert.rejects(
    deletePublicDataSource(SOURCE_ID, harness.dependencies),
    (error: unknown) =>
      error instanceof DataSourceApiError &&
      error.status === 502 &&
      error.code === "AZURE_STORAGE_UNAVAILABLE",
  );
  assert.equal(harness.state().status, "deleted");
  assert.equal(harness.state().azureCleanupStatus, "pending");
  assert.equal(harness.state().azureCleanupAttempts, 1);
  assert.equal(harness.state().azureCleanupErrorCode, "AZURE_STATUS_503");
  assert.equal(
    JSON.stringify(harness.state()).includes(CONFIG.azureAccountKey),
    false,
  );
  assert.equal(JSON.stringify(harness.state()).includes("sig="), false);

  await deletePublicDataSource(SOURCE_ID, harness.dependencies);
  assert.equal(harness.state().azureCleanupStatus, "deleted");
  assert.equal(harness.state().azureCleanupAttempts, 2);
  assert.equal(harness.state().azureCleanupErrorCode, null);
  assert.deepEqual(harness.deleteCalls, [
    { blobName: SOURCE_BLOB, ifMatch: '"generation-one"' },
    { blobName: SOURCE_BLOB, ifMatch: '"generation-one"' },
  ]);

  await deletePublicDataSource(SOURCE_ID, harness.dependencies);
  assert.equal(harness.deleteCalls.length, 2);
});

test("404 is terminal missing and never invokes a blob mutation", async () => {
  const harness = fakeDeletionDependencies({
    initial: fileDataSource({ status: "failed", azureETag: null }),
    getProperties: async () => {
      throw { statusCode: 404 };
    },
  });

  await deletePublicDataSource(SOURCE_ID, harness.dependencies);
  assert.equal(harness.state().azureCleanupStatus, "missing");
  assert.equal(harness.state().azureCleanupAttempts, 1);
  assert.equal(harness.deleteCalls.length, 0);
});

test("412 records a terminal superseded generation and never retries it", async () => {
  const harness = fakeDeletionDependencies({
    initial: fileDataSource(),
    deleteBlob: async () => {
      throw { statusCode: 412 };
    },
  });

  await deletePublicDataSource(SOURCE_ID, harness.dependencies);
  await deletePublicDataSource(SOURCE_ID, harness.dependencies);
  assert.equal(harness.state().azureCleanupStatus, "superseded");
  assert.equal(harness.state().azureCleanupAttempts, 1);
  assert.equal(harness.deleteCalls.length, 1);
});

test("conditional deletion targets only the selected datasource binding", async () => {
  const blobs = new Map([
    [SOURCE_BLOB, '"generation-one"'],
    [OTHER_BLOB, '"other-generation"'],
  ]);
  const harness = fakeDeletionDependencies({
    initial: fileDataSource(),
    deleteBlob: async ({ blobName, ifMatch }) => {
      assert.equal(blobs.get(blobName), ifMatch);
      blobs.delete(blobName);
      return "deleted";
    },
  });

  await deletePublicDataSource(SOURCE_ID, harness.dependencies);
  assert.equal(blobs.has(SOURCE_BLOB), false);
  assert.equal(blobs.get(OTHER_BLOB), '"other-generation"');
});

test("database datasource deletion never calls Azure", async () => {
  const databaseSource = fileDataSource({
    connectorType: "postgresql",
    config: {
      host: "db.internal",
      port: 5432,
      database: "analytics",
      sslMode: "require",
      connectionTimeoutMs: 1000,
      mutationMode: "disabled",
      mutationAllowlist: [],
    },
    originalFilename: null,
    mimeType: null,
    fileSizeBytes: null,
    azureBlobName: null,
    azureETag: null,
  } as Partial<DataSource>);
  const harness = fakeDeletionDependencies({ initial: databaseSource });

  await deletePublicDataSource(SOURCE_ID, harness.dependencies);
  await deletePublicDataSource(SOURCE_ID, harness.dependencies);
  assert.equal(harness.state().status, "deleted");
  assert.equal(harness.state().azureCleanupStatus, null);
  assert.equal(harness.deleteCalls.length, 0);
});
