import {
  initializeDatabase,
  migrateDatabase,
  sweepPendingDataSourceBlobCleanups,
  type DataSourceBlobCleanupSweepSummary,
  type DataSourceBlobCleanupWorkerResult,
  type PendingDataSourceBlobCleanup,
} from "@forty-two/db";

import {
  deleteBlobIfMatch,
  getAzureStatusCode,
  getBlobProperties,
} from "./azure-storage";
import { readFileDataSourceServerConfig } from "./config";

let databaseReadyPromise: Promise<void> | undefined;

async function ensureDatabase(): Promise<void> {
  if (!databaseReadyPromise) {
    databaseReadyPromise = (async () => {
      initializeDatabase();
      await migrateDatabase();
    })().catch((error: unknown) => {
      databaseReadyPromise = undefined;
      throw error;
    });
  }
  await databaseReadyPromise;
}

type SweepDependencies = {
  ensureDatabase: typeof ensureDatabase;
  sweepPendingDataSourceBlobCleanups: typeof sweepPendingDataSourceBlobCleanups;
  readConfig: typeof readFileDataSourceServerConfig;
  getBlobProperties: typeof getBlobProperties;
  deleteBlobIfMatch: typeof deleteBlobIfMatch;
  getAzureStatusCode: typeof getAzureStatusCode;
};

const sweepDependencies: SweepDependencies = {
  ensureDatabase,
  sweepPendingDataSourceBlobCleanups,
  readConfig: readFileDataSourceServerConfig,
  getBlobProperties,
  deleteBlobIfMatch,
  getAzureStatusCode,
};

export async function sweepPendingFileDataSourceBlobs(
  input: { limit: number; dataSourceIds?: string[] },
  dependencies: SweepDependencies = sweepDependencies,
): Promise<DataSourceBlobCleanupSweepSummary> {
  await dependencies.ensureDatabase();
  const config = dependencies.readConfig();
  return dependencies.sweepPendingDataSourceBlobCleanups({
    ...input,
    worker: async (cleanup) => cleanupOneBlob(cleanup, config, dependencies),
  });
}

async function cleanupOneBlob(
  cleanup: PendingDataSourceBlobCleanup,
  config: ReturnType<typeof readFileDataSourceServerConfig>,
  dependencies: Pick<
    SweepDependencies,
    "getBlobProperties" | "deleteBlobIfMatch" | "getAzureStatusCode"
  >,
): Promise<DataSourceBlobCleanupWorkerResult> {
  let azureETag = cleanup.azureCleanupETag;
  if (!azureETag) {
    try {
      const properties = await dependencies.getBlobProperties({
        config,
        blobName: cleanup.azureBlobName,
      });
      azureETag = properties.etag?.trim() || null;
      if (!azureETag) {
        return {
          outcome: "pending",
          azureETag: null,
          errorCode: "AZURE_ETAG_MISSING",
        };
      }
    } catch (error) {
      const statusCode = dependencies.getAzureStatusCode(error);
      if (statusCode === 404) {
        return { outcome: "missing", azureETag: null };
      }
      return {
        outcome: "pending",
        azureETag: null,
        errorCode: azureCleanupErrorCode(statusCode),
      };
    }
  }

  try {
    const outcome = await dependencies.deleteBlobIfMatch({
      config,
      blobName: cleanup.azureBlobName,
      ifMatch: azureETag,
    });
    return { outcome, azureETag };
  } catch (error) {
    const statusCode = dependencies.getAzureStatusCode(error);
    if (statusCode === 404) return { outcome: "missing", azureETag };
    if (statusCode === 412) return { outcome: "superseded", azureETag };
    return {
      outcome: "pending",
      azureETag,
      errorCode: azureCleanupErrorCode(statusCode),
    };
  }
}

function azureCleanupErrorCode(statusCode: number | undefined): string {
  return statusCode === undefined
    ? "AZURE_STORAGE_UNAVAILABLE"
    : `AZURE_STATUS_${statusCode}`;
}
