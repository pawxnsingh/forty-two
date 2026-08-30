import assert from "node:assert/strict";
import test from "node:test";

import { readFileDataSourceServerConfig } from "./config";

const baseEnvironment = {
  NODE_ENV: "test",
  AZURE_STORAGE_ACCOUNT_NAME: "dummy42account",
  AZURE_STORAGE_ACCOUNT_KEY: "not-a-real-secret",
  AZURE_STORAGE_CONTAINER: "dummy42",
} satisfies NodeJS.ProcessEnv;

test("server config applies bounded safe defaults", () => {
  const config = readFileDataSourceServerConfig(baseEnvironment);
  assert.deepEqual(config.allowedOrigins, ["http://localhost:3000"]);
  assert.equal(config.maxFileSizeBytes, 25 * 1024 * 1024);
  assert.equal(config.uploadSasTtlSeconds, 300);
});

test("server config accepts only exact non-wildcard HTTP origins", () => {
  assert.throws(
    () =>
      readFileDataSourceServerConfig({
        ...baseEnvironment,
        AZURE_STORAGE_ALLOWED_ORIGINS: "https://example.test,*",
      }),
    /cannot contain wildcards/,
  );
  assert.throws(
    () =>
      readFileDataSourceServerConfig({
        ...baseEnvironment,
        AZURE_STORAGE_ALLOWED_ORIGINS: "https://example.test/upload",
      }),
    /exact origins/,
  );
  assert.throws(
    () =>
      readFileDataSourceServerConfig({
        ...baseEnvironment,
        AZURE_STORAGE_ALLOWED_ORIGINS: "file:///tmp/upload",
      }),
    /HTTP or HTTPS/,
  );
});

test("server config bounds max file size and SAS duration", () => {
  assert.throws(
    () =>
      readFileDataSourceServerConfig({
        ...baseEnvironment,
        DATA_SOURCE_MAX_FILE_SIZE_BYTES: String(Number.MAX_SAFE_INTEGER + 1),
      }),
    /must be an integer/,
  );
  assert.throws(
    () =>
      readFileDataSourceServerConfig({
        ...baseEnvironment,
        AZURE_STORAGE_UPLOAD_SAS_TTL_SECONDS: "901",
      }),
    /60 to 900/,
  );
});

test("configuration failures never include the account key", () => {
  const accountKey = "sensitive-account-key-value";
  assert.throws(
    () =>
      readFileDataSourceServerConfig({
        ...baseEnvironment,
        AZURE_STORAGE_ACCOUNT_NAME: "INVALID",
        AZURE_STORAGE_ACCOUNT_KEY: accountKey,
      }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes(accountKey),
  );
});
