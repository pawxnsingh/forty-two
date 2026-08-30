import assert from "node:assert/strict";
import test from "node:test";

import {
  createBlobUploadAuthorization,
  deleteBlobClientIfMatch,
  mergeManagedCorsRules,
} from "./azure-storage";
import type { FileDataSourceServerConfig } from "./config";
import { CSV_MIME_TYPE } from "./file-validation";

test("upload authorization is HTTPS, blob scoped, create-only, and short lived", () => {
  const config: FileDataSourceServerConfig = {
    azureAccountName: "dummy42account",
    azureAccountKey: Buffer.alloc(32).toString("base64"),
    azureContainer: "dummy42",
    allowedOrigins: ["https://forty-two.example"],
    maxFileSizeBytes: 1_024,
    uploadSasTtlSeconds: 300,
  };
  const now = new Date("2026-08-28T12:00:00.000Z");
  const authorization = createBlobUploadAuthorization({
    config,
    blobName: "data-sources/ds_01HZX000000000000000000000/report.csv",
    mimeType: CSV_MIME_TYPE,
    now,
  });
  const url = new URL(authorization.url);

  assert.equal(url.protocol, "https:");
  assert.equal(url.searchParams.get("spr"), "https");
  assert.equal(url.searchParams.get("sp"), "c");
  assert.equal(url.searchParams.get("sr"), "b");
  assert.equal(authorization.expiresAt.getTime() - now.getTime(), 300_000);
  assert.deepEqual(authorization.headers, {
    "Content-Type": CSV_MIME_TYPE,
    "If-None-Match": "*",
    "x-ms-blob-content-type": CSV_MIME_TYPE,
    "x-ms-blob-type": "BlockBlob",
  });
  assert.equal(authorization.url.includes(config.azureAccountKey), false);
});

test("conditional deletion pins the exact ETag and treats a missing blob idempotently", async () => {
  const calls: unknown[] = [];
  const deleted = await deleteBlobClientIfMatch(
    {
      async deleteIfExists(options) {
        calls.push(options);
        return { succeeded: true } as Awaited<
          ReturnType<import("@azure/storage-blob").BlobClient["deleteIfExists"]>
        >;
      },
    },
    '"generation-one"',
  );
  const missing = await deleteBlobClientIfMatch(
    {
      async deleteIfExists(options) {
        calls.push(options);
        return { succeeded: false } as Awaited<
          ReturnType<import("@azure/storage-blob").BlobClient["deleteIfExists"]>
        >;
      },
    },
    '"generation-two"',
  );

  assert.equal(deleted, "deleted");
  assert.equal(missing, "missing");
  assert.deepEqual(calls, [
    {
      conditions: { ifMatch: '"generation-one"' },
      deleteSnapshots: "include",
    },
    {
      conditions: { ifMatch: '"generation-two"' },
      deleteSnapshots: "include",
    },
  ]);
});

test("managed CORS updates preserve unrelated wildcard rules", () => {
  const wildcardRule = {
    allowedOrigins: "https://*.other.example",
    allowedMethods: "GET,OPTIONS",
    allowedHeaders: "*",
    exposedHeaders: "etag",
    maxAgeInSeconds: 600,
  };
  const oldManagedRule = {
    allowedOrigins: "https://old.example",
    allowedMethods: "PUT,OPTIONS",
    allowedHeaders:
      "content-type,if-none-match,x-ms-blob-content-type,x-ms-blob-type,x-ms-client-request-id,x-ms-version",
    exposedHeaders: "etag,x-ms-request-id,x-ms-version",
    maxAgeInSeconds: 3_600,
  };
  const desiredRule = { ...oldManagedRule, allowedOrigins: "https://new.example" };

  assert.deepEqual(
    mergeManagedCorsRules([wildcardRule, oldManagedRule], desiredRule),
    [wildcardRule, desiredRule],
  );
});
