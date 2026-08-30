import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
  type BlobClient,
  type BlobGetPropertiesResponse,
  type CorsRule,
} from "@azure/storage-blob";

import type { FileDataSourceServerConfig } from "./config";

const MANAGED_ALLOWED_METHODS = "PUT,OPTIONS";
const MANAGED_ALLOWED_HEADERS =
  "content-type,if-none-match,x-ms-blob-content-type,x-ms-blob-type,x-ms-client-request-id,x-ms-version";
const MANAGED_EXPOSED_HEADERS = "etag,x-ms-request-id,x-ms-version";

type AzureStorageClients = {
  credential: StorageSharedKeyCredential;
  service: BlobServiceClient;
};

export type UploadAuthorization = {
  url: string;
  expiresAt: Date;
  headers: Readonly<Record<string, string>>;
};

let cachedClients:
  | { accountName: string; accountKey: string; clients: AzureStorageClients }
  | undefined;
let corsConfigurationPromise: Promise<void> | undefined;
let corsConfigurationKey: string | undefined;

function getClients(config: FileDataSourceServerConfig): AzureStorageClients {
  if (
    cachedClients?.accountName === config.azureAccountName &&
    cachedClients.accountKey === config.azureAccountKey
  ) {
    return cachedClients.clients;
  }

  const credential = new StorageSharedKeyCredential(
    config.azureAccountName,
    config.azureAccountKey,
  );
  const clients = {
    credential,
    service: new BlobServiceClient(
      `https://${config.azureAccountName}.blob.core.windows.net`,
      credential,
    ),
  };
  cachedClients = {
    accountName: config.azureAccountName,
    accountKey: config.azureAccountKey,
    clients,
  };
  corsConfigurationPromise = undefined;
  corsConfigurationKey = undefined;
  return clients;
}

function corsRuleEquals(left: CorsRule, right: CorsRule): boolean {
  return (
    left.allowedOrigins === right.allowedOrigins &&
    left.allowedMethods === right.allowedMethods &&
    left.allowedHeaders === right.allowedHeaders &&
    left.exposedHeaders === right.exposedHeaders &&
    left.maxAgeInSeconds === right.maxAgeInSeconds
  );
}

function isManagedCorsRule(rule: CorsRule): boolean {
  return (
    rule.allowedMethods === MANAGED_ALLOWED_METHODS &&
    rule.allowedHeaders === MANAGED_ALLOWED_HEADERS &&
    rule.exposedHeaders === MANAGED_EXPOSED_HEADERS
  );
}

async function configureCorsAndContainer(
  config: FileDataSourceServerConfig,
): Promise<void> {
  const { service } = getClients(config);
  const desiredRule: CorsRule = {
    allowedOrigins: config.allowedOrigins.join(","),
    allowedMethods: MANAGED_ALLOWED_METHODS,
    allowedHeaders: MANAGED_ALLOWED_HEADERS,
    exposedHeaders: MANAGED_EXPOSED_HEADERS,
    maxAgeInSeconds: 3_600,
  };

  const properties = await service.getProperties();
  const currentRules = properties.cors ?? [];
  const managedRule = currentRules.find(isManagedCorsRule);
  const unsafeWildcardRules = currentRules.filter((rule) =>
    rule.allowedOrigins
      .split(",")
      .some((origin) => origin.trim().includes("*")),
  );
  if (
    !managedRule ||
    !corsRuleEquals(managedRule, desiredRule) ||
    unsafeWildcardRules.length > 0
  ) {
    const unrelatedRules = currentRules.filter(
      (rule) => !isManagedCorsRule(rule) && !unsafeWildcardRules.includes(rule),
    );
    if (unrelatedRules.length >= 5) {
      throw new Error(
        "Azure Blob Storage already has five unrelated CORS rules; no managed rule can be added safely.",
      );
    }
    await service.setProperties({
      cors: [...unrelatedRules, desiredRule],
    });
  }

  await service
    .getContainerClient(config.azureContainer)
    .createIfNotExists({ access: undefined });
}

export function ensureAzureUploadConfiguration(
  config: FileDataSourceServerConfig,
): Promise<void> {
  const key = [
    config.azureAccountName,
    config.azureContainer,
    ...config.allowedOrigins,
  ].join("\n");
  if (!corsConfigurationPromise || corsConfigurationKey !== key) {
    corsConfigurationKey = key;
    corsConfigurationPromise = configureCorsAndContainer(config).catch(
      (error: unknown) => {
        corsConfigurationPromise = undefined;
        corsConfigurationKey = undefined;
        throw error;
      },
    );
  }
  return corsConfigurationPromise;
}

export function createBlobUploadAuthorization(input: {
  config: FileDataSourceServerConfig;
  blobName: string;
  mimeType: string;
  now?: Date;
}): UploadAuthorization {
  const { credential } = getClients(input.config);
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + input.config.uploadSasTtlSeconds * 1_000,
  );
  const query = generateBlobSASQueryParameters(
    {
      containerName: input.config.azureContainer,
      blobName: input.blobName,
      permissions: BlobSASPermissions.parse("c"),
      protocol: SASProtocol.Https,
      startsOn: new Date(now.getTime() - 5 * 60 * 1_000),
      expiresOn: expiresAt,
      contentType: input.mimeType,
    },
    credential,
  ).toString();
  const encodedBlobName = input.blobName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return {
    url: `https://${input.config.azureAccountName}.blob.core.windows.net/${encodeURIComponent(input.config.azureContainer)}/${encodedBlobName}?${query}`,
    expiresAt,
    headers: {
      "Content-Type": input.mimeType,
      "If-None-Match": "*",
      "x-ms-blob-content-type": input.mimeType,
      "x-ms-blob-type": "BlockBlob",
    },
  };
}

export function getBlobClient(
  config: FileDataSourceServerConfig,
  blobName: string,
): BlobClient {
  return getClients(config)
    .service.getContainerClient(config.azureContainer)
    .getBlobClient(blobName);
}

export async function getBlobProperties(input: {
  config: FileDataSourceServerConfig;
  blobName: string;
  ifMatch?: string;
}): Promise<BlobGetPropertiesResponse> {
  return getBlobClient(input.config, input.blobName).getProperties({
    conditions: input.ifMatch ? { ifMatch: input.ifMatch } : undefined,
  });
}

export async function downloadBlobToBuffer(input: {
  config: FileDataSourceServerConfig;
  blobName: string;
  expectedSizeBytes: number;
  ifMatch: string;
}): Promise<Buffer> {
  return getBlobClient(input.config, input.blobName).downloadToBuffer(
    0,
    input.expectedSizeBytes,
    {
      conditions: { ifMatch: input.ifMatch },
      concurrency: 1,
      maxRetryRequestsPerBlock: 1,
    },
  );
}

export type ConditionalBlobDeleteResult = "deleted" | "missing";

export async function deleteBlobClientIfMatch(
  client: Pick<BlobClient, "deleteIfExists">,
  ifMatch: string,
): Promise<ConditionalBlobDeleteResult> {
  const response = await client.deleteIfExists({
    conditions: { ifMatch },
    deleteSnapshots: "include",
  });
  return response.succeeded ? "deleted" : "missing";
}

export async function deleteBlobIfMatch(input: {
  config: FileDataSourceServerConfig;
  blobName: string;
  ifMatch: string;
}): Promise<ConditionalBlobDeleteResult> {
  return deleteBlobClientIfMatch(
    getBlobClient(input.config, input.blobName),
    input.ifMatch,
  );
}

export function getAzureStatusCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return undefined;
}
