import assert from "node:assert/strict";
import test from "node:test";

import type {
  DataSourceBlobCleanupWorkerResult,
  PendingDataSourceBlobCleanup,
} from "@forty-two/db";

import type { FileDataSourceServerConfig } from "./config";
import { sweepPendingFileDataSourceBlobs } from "./blob-cleanup-service";

const CONFIG: FileDataSourceServerConfig = {
  azureAccountName: "dummy42account",
  azureAccountKey: Buffer.alloc(32).toString("base64"),
  azureContainer: "dummy42",
  allowedOrigins: ["https://forty-two.example"],
  maxFileSizeBytes: 1024,
  uploadSasTtlSeconds: 300,
};
const CLEANUP: PendingDataSourceBlobCleanup = {
  dataSourceId: "ds_01HZX000000000000000000000",
  azureBlobName: "data-sources/ds_01HZX000000000000000000000/source.csv",
  azureCleanupETag: '"generation-one"',
};
type SweepDependencies = NonNullable<
  Parameters<typeof sweepPendingFileDataSourceBlobs>[1]
>;

function fakeDependencies(input: {
  cleanup?: PendingDataSourceBlobCleanup;
  getProperties?: SweepDependencies["getBlobProperties"];
  deleteBlob?: SweepDependencies["deleteBlobIfMatch"];
}) {
  const results: DataSourceBlobCleanupWorkerResult[] = [];
  const deletes: Array<{ blobName: string; ifMatch: string }> = [];
  const dependencies: SweepDependencies = {
    async ensureDatabase() {},
    async sweepPendingDataSourceBlobCleanups(sweepInput) {
      const result = await sweepInput.worker(input.cleanup ?? CLEANUP);
      results.push(result);
      return {
        selected: 1,
        processed: 1,
        skippedLockedOrChanged: 0,
        pendingRemaining: result.outcome === "pending" ? 1 : 0,
        outcomes: {
          pending: result.outcome === "pending" ? 1 : 0,
          deleted: result.outcome === "deleted" ? 1 : 0,
          missing: result.outcome === "missing" ? 1 : 0,
          superseded: result.outcome === "superseded" ? 1 : 0,
        },
      };
    },
    readConfig: () => CONFIG,
    getBlobProperties:
      input.getProperties ??
      (async () =>
        ({ etag: '"generation-one"' }) as Awaited<
          ReturnType<SweepDependencies["getBlobProperties"]>
        >),
    async deleteBlobIfMatch(deleteInput) {
      deletes.push({
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
  return { dependencies, deletes, results };
}

test("sweeper leaves transient failure pending and a restart retries the same generation", async () => {
  let attempts = 0;
  const harness = fakeDependencies({
    deleteBlob: async () => {
      attempts += 1;
      if (attempts === 1) throw { statusCode: 503 };
      return "deleted";
    },
  });

  const first = await sweepPendingFileDataSourceBlobs(
    { limit: 1 },
    harness.dependencies,
  );
  const second = await sweepPendingFileDataSourceBlobs(
    { limit: 1 },
    harness.dependencies,
  );
  assert.equal(first.outcomes.pending, 1);
  assert.equal(second.outcomes.deleted, 1);
  assert.deepEqual(harness.results, [
    {
      outcome: "pending",
      azureETag: '"generation-one"',
      errorCode: "AZURE_STATUS_503",
    },
    { outcome: "deleted", azureETag: '"generation-one"' },
  ]);
  assert.deepEqual(harness.deletes, [
    {
      blobName: CLEANUP.azureBlobName,
      ifMatch: '"generation-one"',
    },
    {
      blobName: CLEANUP.azureBlobName,
      ifMatch: '"generation-one"',
    },
  ]);
  assert.equal(JSON.stringify(first).includes(CONFIG.azureAccountKey), false);
  assert.equal(JSON.stringify(first).includes("sig="), false);
});

test("sweeper maps exact-name 404 and 412 races to terminal outcomes", async () => {
  const missing = fakeDependencies({
    cleanup: { ...CLEANUP, azureCleanupETag: null },
    getProperties: async () => {
      throw { statusCode: 404 };
    },
  });
  await sweepPendingFileDataSourceBlobs({ limit: 1 }, missing.dependencies);
  assert.deepEqual(missing.results, [{ outcome: "missing", azureETag: null }]);
  assert.equal(missing.deletes.length, 0);

  const superseded = fakeDependencies({
    deleteBlob: async () => {
      throw { statusCode: 412 };
    },
  });
  await sweepPendingFileDataSourceBlobs({ limit: 1 }, superseded.dependencies);
  assert.deepEqual(superseded.results, [
    { outcome: "superseded", azureETag: '"generation-one"' },
  ]);
  assert.deepEqual(superseded.deletes, [
    {
      blobName: CLEANUP.azureBlobName,
      ifMatch: '"generation-one"',
    },
  ]);
});

test("sweeper forwards an exact review-owned ID filter and bounded limit", async () => {
  const harness = fakeDependencies({});
  let received: { limit: number; dataSourceIds?: string[] } | undefined;
  harness.dependencies.sweepPendingDataSourceBlobCleanups = async (input) => {
    received = { limit: input.limit, dataSourceIds: input.dataSourceIds };
    return {
      selected: 0,
      processed: 0,
      skippedLockedOrChanged: 0,
      pendingRemaining: 0,
      outcomes: { pending: 0, deleted: 0, missing: 0, superseded: 0 },
    };
  };
  await sweepPendingFileDataSourceBlobs(
    { limit: 7, dataSourceIds: [CLEANUP.dataSourceId] },
    harness.dependencies,
  );
  assert.deepEqual(received, {
    limit: 7,
    dataSourceIds: [CLEANUP.dataSourceId],
  });
});
