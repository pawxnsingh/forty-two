import {
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";

import type { FileDownloadConfig } from "./config.js";

export type FileDownloadSource = {
  id: string;
  name: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  azureBlobName: string;
  azureETag: string;
};

export type FileDownloadDescriptor = {
  dataSourceId: string;
  url: string;
  expiresAt: string;
  expectedETag: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  requestHeaders: { "If-Match": string };
};

export function createFileDownloadDescriptor(input: {
  config: FileDownloadConfig;
  source: FileDownloadSource;
  now?: Date;
}): FileDownloadDescriptor {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const credential = new StorageSharedKeyCredential(
    input.config.accountName,
    input.config.accountKey,
  );
  const sas = generateBlobSASQueryParameters(
    {
      containerName: input.config.container,
      blobName: input.source.azureBlobName,
      permissions: BlobSASPermissions.parse("r"),
      protocol: SASProtocol.Https,
      startsOn: new Date(now.getTime() - 60_000),
      expiresOn: expiresAt,
    },
    credential,
  ).toString();
  const blobPath = input.source.azureBlobName
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  return {
    dataSourceId: input.source.id,
    url: `https://${input.config.accountName}.blob.core.windows.net/${encodeURIComponent(input.config.container)}/${blobPath}?${sas}`,
    expiresAt: expiresAt.toISOString(),
    expectedETag: input.source.azureETag,
    filename: input.source.originalFilename,
    mimeType: input.source.mimeType,
    sizeBytes: input.source.fileSizeBytes,
    requestHeaders: { "If-Match": input.source.azureETag },
  };
}
