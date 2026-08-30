import {
  beginDataSourceDeletion,
  completeFileDataSourceUpload,
  createFileDataSource,
  DataSourceIdSchema,
  DataSourceTypeSchema,
  generateDataSourceId,
  getDataSource,
  initializeDatabase,
  listDataSources,
  migrateDatabase,
  pinDataSourceBlobCleanupETag,
  recordDataSourceBlobCleanupAttempt,
  updateDataSourceLifecycle,
  type DataSource,
  type DataSourceType,
} from "@forty-two/db";
import { z } from "zod";

import {
  createBlobUploadAuthorization,
  deleteBlobIfMatch,
  downloadBlobToBuffer,
  ensureAzureUploadConfiguration,
  getAzureStatusCode,
  getBlobProperties,
} from "./azure-storage";
import { readFileDataSourceServerConfig } from "./config";
import {
  parseInitiateFileDataSourceInput,
  validateUploadedFileContent,
} from "./file-validation";

const CompleteBodySchema = z.object({}).strict();
const ActiveDataSourceStatusSchema = z.enum([
  "awaiting_upload",
  "testing",
  "ready",
  "failed",
]);
type ActiveDataSourceStatus = z.infer<typeof ActiveDataSourceStatusSchema>;

let databaseReadyPromise: Promise<void> | undefined;

export class DataSourceApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DataSourceApiError";
    this.status = status;
    this.code = code;
  }
}

export type PublicDataSource = Omit<
  DataSource,
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
  | "azureCleanupStatus"
  | "azureCleanupETag"
  | "azureCleanupAttempts"
  | "azureCleanupCompletedAt"
  | "azureCleanupErrorCode"
> & {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export function publicDataSource(dataSource: DataSource): PublicDataSource {
  const publicValue = { ...dataSource } as Partial<DataSource>;
  delete publicValue.azureCleanupStatus;
  delete publicValue.azureCleanupETag;
  delete publicValue.azureCleanupAttempts;
  delete publicValue.azureCleanupCompletedAt;
  delete publicValue.azureCleanupErrorCode;
  return {
    ...(publicValue as Omit<
      DataSource,
      | "azureCleanupStatus"
      | "azureCleanupETag"
      | "azureCleanupAttempts"
      | "azureCleanupCompletedAt"
      | "azureCleanupErrorCode"
    >),
    createdAt: dataSource.createdAt.toISOString(),
    updatedAt: dataSource.updatedAt.toISOString(),
    deletedAt: dataSource.deletedAt?.toISOString() ?? null,
  };
}

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

function parseDataSourceId(value: string): string {
  const parsed = DataSourceIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DataSourceApiError(
      404,
      "DATA_SOURCE_NOT_FOUND",
      "Datasource not found.",
    );
  }
  return parsed.data;
}

async function activeDataSource(dataSourceId: string): Promise<DataSource> {
  await ensureDatabase();
  const dataSource = await getDataSource({ dataSourceId });
  if (!dataSource) {
    throw new DataSourceApiError(
      404,
      "DATA_SOURCE_NOT_FOUND",
      "Datasource not found.",
    );
  }
  return dataSource;
}

function isFileDataSource(
  dataSource: DataSource,
): dataSource is DataSource & { connectorType: "csv" | "xlsx" } {
  return (
    dataSource.connectorType === "csv" || dataSource.connectorType === "xlsx"
  );
}

async function markFailed(
  dataSource: DataSource,
  processingMessage: string,
): Promise<void> {
  if (
    dataSource.status !== "awaiting_upload" &&
    dataSource.status !== "ready"
  ) {
    return;
  }
  await updateDataSourceLifecycle({
    dataSourceId: dataSource.id,
    fromStatus: dataSource.status,
    toStatus: "failed",
    processingMessage,
  });
}

function readyMetadataMatches(
  dataSource: DataSource,
  properties: {
    etag?: string;
    contentLength?: number;
    contentType?: string;
  },
): boolean {
  return (
    properties.etag === dataSource.azureETag &&
    properties.contentLength === dataSource.fileSizeBytes &&
    properties.contentType === dataSource.mimeType
  );
}

export async function initiateFileDataSource(body: unknown): Promise<{
  data: PublicDataSource;
  upload: {
    url: string;
    method: "PUT";
    expiresAt: string;
    headers: Readonly<Record<string, string>>;
  };
}> {
  const config = readFileDataSourceServerConfig();
  let input: ReturnType<typeof parseInitiateFileDataSourceInput>;
  try {
    input = parseInitiateFileDataSourceInput(body, config.maxFileSizeBytes);
  } catch (error) {
    throw new DataSourceApiError(
      400,
      "INVALID_FILE_UPLOAD",
      error instanceof Error
        ? error.message
        : "File upload request is invalid.",
    );
  }

  await ensureDatabase();
  try {
    await ensureAzureUploadConfiguration(config);
  } catch {
    throw new DataSourceApiError(
      502,
      "AZURE_STORAGE_UNAVAILABLE",
      "Azure Blob Storage could not prepare the upload.",
    );
  }

  const dataSourceId = generateDataSourceId();
  const blobName = `data-sources/${dataSourceId}/${input.filename}`;
  const authorization = createBlobUploadAuthorization({
    config,
    blobName,
    mimeType: input.mimeType,
  });
  const dataSource = await createFileDataSource({
    dataSourceId,
    connectorType: input.connectorType,
    name: input.name,
    originalFilename: input.filename,
    mimeType: input.mimeType,
    fileSizeBytes: input.fileSizeBytes,
    azureBlobName: blobName,
    config: {},
  });

  return {
    data: publicDataSource(dataSource),
    upload: {
      url: authorization.url,
      method: "PUT",
      expiresAt: authorization.expiresAt.toISOString(),
      headers: authorization.headers,
    },
  };
}

export async function completeFileDataSource(
  rawDataSourceId: string,
  body: unknown = {},
): Promise<PublicDataSource> {
  try {
    CompleteBodySchema.parse(body);
  } catch {
    throw new DataSourceApiError(
      400,
      "INVALID_COMPLETION_REQUEST",
      "Completion request body must be empty.",
    );
  }

  const dataSourceId = parseDataSourceId(rawDataSourceId);
  const dataSource = await activeDataSource(dataSourceId);
  if (!isFileDataSource(dataSource)) {
    throw new DataSourceApiError(
      409,
      "NOT_A_FILE_DATA_SOURCE",
      "Only CSV and XLSX datasources have file uploads.",
    );
  }
  if (
    !dataSource.azureBlobName ||
    !dataSource.mimeType ||
    dataSource.fileSizeBytes === null
  ) {
    throw new DataSourceApiError(
      409,
      "FILE_METADATA_MISSING",
      "Datasource file metadata is incomplete.",
    );
  }

  const config = readFileDataSourceServerConfig();
  if (dataSource.status === "ready") {
    if (!dataSource.azureETag) {
      await markFailed(
        dataSource,
        "Ready file metadata did not contain an ETag.",
      );
      throw new DataSourceApiError(
        409,
        "UPLOAD_CHANGED",
        "The uploaded blob no longer matches the completed datasource.",
      );
    }

    try {
      const properties = await getBlobProperties({
        config,
        blobName: dataSource.azureBlobName,
        ifMatch: dataSource.azureETag,
      });
      if (!readyMetadataMatches(dataSource, properties)) {
        await markFailed(
          dataSource,
          "Ready file metadata changed after completion.",
        );
        throw new DataSourceApiError(
          409,
          "UPLOAD_CHANGED",
          "The uploaded blob no longer matches the completed datasource.",
        );
      }
      return publicDataSource(dataSource);
    } catch (error) {
      if (error instanceof DataSourceApiError) {
        throw error;
      }
      const statusCode = getAzureStatusCode(error);
      if (statusCode === 404 || statusCode === 412) {
        await markFailed(
          dataSource,
          "Ready file was missing or overwritten after completion.",
        );
        throw new DataSourceApiError(
          409,
          "UPLOAD_CHANGED",
          "The uploaded blob no longer matches the completed datasource.",
        );
      }
      throw new DataSourceApiError(
        502,
        "AZURE_STORAGE_UNAVAILABLE",
        "Azure Blob Storage could not verify the upload.",
      );
    }
  }

  if (dataSource.status !== "awaiting_upload") {
    throw new DataSourceApiError(
      409,
      "INVALID_DATA_SOURCE_STATUS",
      "Datasource is not awaiting an upload.",
    );
  }

  let properties: Awaited<ReturnType<typeof getBlobProperties>>;
  try {
    properties = await getBlobProperties({
      config,
      blobName: dataSource.azureBlobName,
    });
  } catch (error) {
    if (getAzureStatusCode(error) === 404) {
      await markFailed(dataSource, "Uploaded blob was not found.");
      throw new DataSourceApiError(
        422,
        "UPLOAD_BLOB_MISSING",
        "The uploaded blob was not found.",
      );
    }
    throw new DataSourceApiError(
      502,
      "AZURE_STORAGE_UNAVAILABLE",
      "Azure Blob Storage could not verify the upload.",
    );
  }

  const etag = properties.etag?.trim();
  const actualSizeBytes = properties.contentLength;
  const actualMimeType = properties.contentType;
  if (
    !etag ||
    actualSizeBytes === undefined ||
    actualSizeBytes !== dataSource.fileSizeBytes ||
    actualSizeBytes > config.maxFileSizeBytes ||
    actualMimeType !== dataSource.mimeType
  ) {
    await markFailed(
      dataSource,
      "Uploaded blob metadata did not match the initiated upload.",
    );
    throw new DataSourceApiError(
      422,
      "UPLOAD_METADATA_MISMATCH",
      "The uploaded blob metadata does not match the initiated upload.",
    );
  }

  let buffer: Buffer;
  try {
    buffer = await downloadBlobToBuffer({
      config,
      blobName: dataSource.azureBlobName,
      expectedSizeBytes: actualSizeBytes,
      ifMatch: etag,
    });
  } catch (error) {
    if (getAzureStatusCode(error) === 412) {
      await markFailed(
        dataSource,
        "Uploaded blob changed while it was being validated.",
      );
      throw new DataSourceApiError(
        409,
        "UPLOAD_CHANGED",
        "The uploaded blob changed while it was being validated.",
      );
    }
    throw new DataSourceApiError(
      502,
      "AZURE_STORAGE_UNAVAILABLE",
      "Azure Blob Storage could not read the upload.",
    );
  }

  try {
    await validateUploadedFileContent({
      buffer,
      connectorType: dataSource.connectorType,
      maxFileSizeBytes: config.maxFileSizeBytes,
    });
  } catch (error) {
    await markFailed(dataSource, "Uploaded file content failed validation.");
    throw new DataSourceApiError(
      422,
      "INVALID_FILE_CONTENT",
      error instanceof Error
        ? error.message
        : "Uploaded file content is invalid.",
    );
  }

  const completed = await completeFileDataSourceUpload({
    dataSourceId,
    originalFilename: dataSource.originalFilename!,
    mimeType: actualMimeType,
    fileSizeBytes: actualSizeBytes,
    azureBlobName: dataSource.azureBlobName,
    azureETag: etag,
  });
  if (completed) {
    return publicDataSource(completed);
  }

  const concurrent = await getDataSource({ dataSourceId });
  if (
    concurrent?.status === "ready" &&
    concurrent.azureETag === etag &&
    concurrent.fileSizeBytes === actualSizeBytes &&
    concurrent.mimeType === actualMimeType
  ) {
    return publicDataSource(concurrent);
  }
  throw new DataSourceApiError(
    409,
    "UPLOAD_COMPLETION_CONFLICT",
    "Datasource upload was completed or changed concurrently.",
  );
}

export async function getPublicDataSource(
  rawDataSourceId: string,
): Promise<PublicDataSource> {
  return publicDataSource(
    await activeDataSource(parseDataSourceId(rawDataSourceId)),
  );
}

function commaSeparatedValues(value: string | null): string[] | undefined {
  if (value === null) {
    return undefined;
  }
  return value.split(",").map((part) => part.trim());
}

export async function listPublicDataSources(
  searchParams: URLSearchParams,
): Promise<PublicDataSource[]> {
  await ensureDatabase();
  let connectorTypes: DataSourceType[] | undefined;
  let statuses: ActiveDataSourceStatus[] | undefined;
  try {
    const typeValues = commaSeparatedValues(searchParams.get("type"));
    const statusValues = commaSeparatedValues(searchParams.get("status"));
    connectorTypes = typeValues?.map((value) =>
      DataSourceTypeSchema.parse(value),
    );
    statuses = statusValues?.map((value) =>
      ActiveDataSourceStatusSchema.parse(value),
    );
  } catch {
    throw new DataSourceApiError(
      400,
      "INVALID_DATA_SOURCE_FILTER",
      "Datasource type or status filter is invalid.",
    );
  }

  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DataSourceApiError(
      400,
      "INVALID_DATA_SOURCE_FILTER",
      "limit must be an integer from 1 to 100.",
    );
  }

  const rows = await listDataSources({ connectorTypes, statuses, limit });
  return rows.map(publicDataSource);
}

export async function deletePublicDataSource(
  rawDataSourceId: string,
  dependencies: DeleteDataSourceDependencies = deleteDataSourceDependencies,
): Promise<void> {
  const dataSourceId = parseDataSourceId(rawDataSourceId);
  await dependencies.ensureDatabase();
  const dataSource = await dependencies.beginDataSourceDeletion({
    dataSourceId,
  });
  if (!dataSource) {
    throw new DataSourceApiError(
      404,
      "DATA_SOURCE_NOT_FOUND",
      "Datasource not found.",
    );
  }
  if (!isFileDataSource(dataSource)) return;
  if (!dataSource.azureBlobName || !dataSource.azureCleanupStatus) {
    throw new DataSourceApiError(
      500,
      "DATA_SOURCE_CLEANUP_STATE_INVALID",
      "Datasource cleanup state is invalid.",
    );
  }
  if (isTerminalCleanupStatus(dataSource.azureCleanupStatus)) return;

  const config = dependencies.readConfig();
  const azureBlobName = dataSource.azureBlobName;
  let cleanupETag = dataSource.azureCleanupETag;
  if (!cleanupETag) {
    try {
      const properties = await dependencies.getBlobProperties({
        config,
        blobName: azureBlobName,
      });
      cleanupETag = properties.etag?.trim() || null;
      if (!cleanupETag) {
        await recordPendingCleanupFailure(
          dataSourceId,
          azureBlobName,
          null,
          "AZURE_ETAG_MISSING",
          dependencies,
        );
        throw azureCleanupUnavailable();
      }
      const pinned = await dependencies.pinDataSourceBlobCleanupETag({
        dataSourceId,
        azureBlobName,
        azureETag: cleanupETag,
      });
      if (!pinned) {
        const concurrent = await dependencies.getDataSource({
          dataSourceId,
          includeDeleted: true,
        });
        if (
          concurrent &&
          isFileDataSource(concurrent) &&
          concurrent.azureBlobName === azureBlobName &&
          concurrent.azureCleanupStatus &&
          isTerminalCleanupStatus(concurrent.azureCleanupStatus)
        ) {
          return;
        }
        if (
          !concurrent ||
          !isFileDataSource(concurrent) ||
          concurrent.azureBlobName !== azureBlobName ||
          concurrent.azureCleanupStatus !== "pending" ||
          !concurrent.azureCleanupETag
        ) {
          throw new DataSourceApiError(
            409,
            "DATA_SOURCE_CLEANUP_CONFLICT",
            "Datasource cleanup changed concurrently.",
          );
        }
        cleanupETag = concurrent.azureCleanupETag;
      }
    } catch (error) {
      if (error instanceof DataSourceApiError) throw error;
      const statusCode = dependencies.getAzureStatusCode(error);
      if (statusCode === 404) {
        await dependencies.recordDataSourceBlobCleanupAttempt({
          dataSourceId,
          azureBlobName,
          expectedAzureETag: null,
          outcome: "missing",
        });
        return;
      }
      await recordPendingCleanupFailure(
        dataSourceId,
        azureBlobName,
        null,
        azureCleanupErrorCode(statusCode),
        dependencies,
      );
      throw azureCleanupUnavailable();
    }
  }

  if (!cleanupETag) {
    throw new DataSourceApiError(
      500,
      "DATA_SOURCE_CLEANUP_STATE_INVALID",
      "Datasource cleanup state is invalid.",
    );
  }

  let result: Awaited<ReturnType<typeof deleteBlobIfMatch>>;
  try {
    result = await dependencies.deleteBlobIfMatch({
      config,
      blobName: azureBlobName,
      ifMatch: cleanupETag,
    });
  } catch (error) {
    const statusCode = dependencies.getAzureStatusCode(error);
    if (statusCode === 404 || statusCode === 412) {
      await dependencies.recordDataSourceBlobCleanupAttempt({
        dataSourceId,
        azureBlobName,
        expectedAzureETag: cleanupETag,
        outcome: statusCode === 404 ? "missing" : "superseded",
      });
      return;
    }
    await recordPendingCleanupFailure(
      dataSourceId,
      azureBlobName,
      cleanupETag,
      azureCleanupErrorCode(statusCode),
      dependencies,
    );
    throw azureCleanupUnavailable();
  }
  await dependencies.recordDataSourceBlobCleanupAttempt({
    dataSourceId,
    azureBlobName,
    expectedAzureETag: cleanupETag,
    outcome: result,
  });
}

type DeleteDataSourceDependencies = {
  ensureDatabase: typeof ensureDatabase;
  beginDataSourceDeletion: typeof beginDataSourceDeletion;
  getDataSource: typeof getDataSource;
  pinDataSourceBlobCleanupETag: typeof pinDataSourceBlobCleanupETag;
  recordDataSourceBlobCleanupAttempt: typeof recordDataSourceBlobCleanupAttempt;
  readConfig: typeof readFileDataSourceServerConfig;
  getBlobProperties: typeof getBlobProperties;
  deleteBlobIfMatch: typeof deleteBlobIfMatch;
  getAzureStatusCode: typeof getAzureStatusCode;
};

const deleteDataSourceDependencies: DeleteDataSourceDependencies = {
  ensureDatabase,
  beginDataSourceDeletion,
  getDataSource,
  pinDataSourceBlobCleanupETag,
  recordDataSourceBlobCleanupAttempt,
  readConfig: readFileDataSourceServerConfig,
  getBlobProperties,
  deleteBlobIfMatch,
  getAzureStatusCode,
};

function isTerminalCleanupStatus(
  status: NonNullable<DataSource["azureCleanupStatus"]>,
): boolean {
  return status !== "pending";
}

async function recordPendingCleanupFailure(
  dataSourceId: string,
  azureBlobName: string,
  expectedAzureETag: string | null,
  errorCode: string,
  dependencies: DeleteDataSourceDependencies,
): Promise<void> {
  await dependencies.recordDataSourceBlobCleanupAttempt({
    dataSourceId,
    azureBlobName,
    expectedAzureETag,
    outcome: "pending",
    errorCode,
  });
}

function azureCleanupErrorCode(statusCode: number | undefined): string {
  return statusCode === undefined
    ? "AZURE_STORAGE_UNAVAILABLE"
    : `AZURE_STATUS_${statusCode}`;
}

function azureCleanupUnavailable(): DataSourceApiError {
  return new DataSourceApiError(
    502,
    "AZURE_STORAGE_UNAVAILABLE",
    "Azure Blob Storage could not delete the datasource file. Retry deletion.",
  );
}

export function dataSourceApiError(error: unknown): Response {
  if (error instanceof DataSourceApiError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed.",
        },
      },
      { status: 400 },
    );
  }
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The datasource request could not be completed.",
      },
    },
    { status: 500 },
  );
}
