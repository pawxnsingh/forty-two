import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import {
  beginDataSourceDeletion,
  closeDatabase,
  generateDataSourceId,
  getDataSource,
  initializeDatabase,
  migrateDatabase,
} from "../packages/db/dist/index.js";

import { createXlsxFixture } from "./lib/xlsx-fixture.mjs";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
} = require("../apps/web/node_modules/@azure/storage-blob");
const ExcelJS = require("../apps/web/node_modules/exceljs");

const CSV_MIME = "text/csv";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const webUrl = normalizeHttpUrl(
  process.env.WEB_URL?.trim() || "http://127.0.0.1:3000",
);
const databaseUrl = requiredEnvironment("DATABASE_URL");
const accountName = requiredEnvironment("AZURE_STORAGE_ACCOUNT_NAME");
const accountKey = requiredEnvironment("AZURE_STORAGE_ACCOUNT_KEY");
const containerName = requiredEnvironment("AZURE_STORAGE_CONTAINER");
const allowedOrigins = (
  process.env.AZURE_STORAGE_ALLOWED_ORIGINS || "http://localhost:3000"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .sort();
const maximumFileSize = Number(
  process.env.DATA_SOURCE_MAX_FILE_SIZE_BYTES || 25 * 1024 * 1024,
);
const API_TIMEOUT_MS = 30_000;
const uploadTimeoutMs = boundedIntegerEnvironment(
  "FILE_DATASOURCE_UPLOAD_TIMEOUT_MS",
  5 * 60_000,
  API_TIMEOUT_MS,
  10 * 60_000,
);
const nonce = `dummy42-${Date.now()}-${process.pid}`;
const credential = new StorageSharedKeyCredential(accountName, accountKey);
const serviceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  credential,
);
const containerClient = serviceClient.getContainerClient(containerName);
const cleanupRows = new Map();

try {
  initializeDatabase({ connectionString: databaseUrl, maxConnections: 2 });
  await migrateDatabase();
  await run();
  console.log(
    `File datasource E2E passed against live API, PostgreSQL, and Azure (${nonce}; cases=17; uploadTimeoutMs=${uploadTimeoutMs}).`,
  );
} catch (error) {
  process.exitCode = 1;
  console.error(`File datasource E2E failed: ${safeMessage(error)}`);
} finally {
  const cleanupErrors = await cleanup();
  await closeDatabase().catch(() => undefined);
  if (cleanupErrors.length > 0) {
    process.exitCode = 1;
    console.error(
      `File datasource cleanup was incomplete (${cleanupErrors.length} operation(s)).`,
    );
  }
}

async function run() {
  assert.ok(Number.isSafeInteger(maximumFileSize) && maximumFileSize >= 1024);

  const csvBuffer = Buffer.from(
    `name,value,nonce\ndummy42,42,${nonce}\n`,
    "utf8",
  );
  const xlsxBuffer = createXlsxFixture([
    ["name", "value", "nonce"],
    ["dummy42", 42, nonce],
  ]);

  const csv = await readyFile({
    name: `${nonce} CSV`,
    filename: `${nonce}.csv`,
    mimeType: CSV_MIME,
    buffer: csvBuffer,
  });
  const xlsx = await readyFile({
    name: `${nonce} XLSX`,
    filename: `${nonce}.xlsx`,
    mimeType: XLSX_MIME,
    buffer: xlsxBuffer,
  });
  await assertCorsConfiguration();

  const repeated = await api(`/api/data-sources/${csv.data.id}/complete`, {
    method: "POST",
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.data.azureETag, csv.data.azureETag);

  const fetched = await api(`/api/data-sources/${csv.data.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.status, "ready");
  const listed = await api(
    `/api/data-sources?type=csv,xlsx&status=ready&limit=100`,
  );
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.some((row) => row.id === csv.data.id));
  assert.ok(listed.body.data.some((row) => row.id === xlsx.data.id));

  for (const ready of [csv, xlsx]) {
    const persisted = await getDataSource({ dataSourceId: ready.data.id });
    assert.equal(persisted?.status, "ready");
    assert.equal(persisted?.azureETag, ready.data.azureETag);
    assert.equal(persisted?.fileSizeBytes, ready.buffer.length);

    const downloaded = await containerClient
      .getBlobClient(ready.data.azureBlobName)
      .downloadToBuffer(0, ready.buffer.length, {
        conditions: { ifMatch: ready.data.azureETag },
      });
    assert.equal(downloaded.equals(ready.buffer), true);
    await assertDownloadedNonce(ready.data.connectorType, downloaded);
  }

  await missingUploadCase(csvBuffer.length);
  await sizeMismatchCase(csvBuffer);
  await unsupportedInitiationCases();
  await invalidContentCase({
    name: "malformed CSV headers",
    filename: `${nonce}-duplicate.csv`,
    mimeType: CSV_MIME,
    buffer: Buffer.from("name,NAME\ndummy42,42\n"),
  });
  await invalidContentCase({
    name: "fake XLSX",
    filename: `${nonce}-fake.xlsx`,
    mimeType: XLSX_MIME,
    buffer: Buffer.from("PK\u0003\u0004not-a-real-workbook"),
  });
  await oversizedCases();
  await unknownAndDeletedCases(csvBuffer, xlsx);
  await retryDeletedCleanupCase(csvBuffer, xlsx);
  await overwriteProtectionCases(csv, csvBuffer);
}

async function assertDownloadedNonce(connectorType, downloaded) {
  if (connectorType === "csv") {
    assert.equal(downloaded.includes(Buffer.from(nonce)), true);
    return;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(downloaded);
  let nonceFound = false;
  workbook.eachSheet((worksheet) => {
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        nonceFound ||= String(cell.value).includes(nonce);
      });
    });
  });
  assert.equal(nonceFound, true);
}

async function assertCorsConfiguration() {
  const properties = await serviceClient.getProperties();
  assert.equal(
    properties.cors?.some((rule) => rule.allowedOrigins.includes("*")) ?? false,
    false,
    "Azure Blob Storage retained an unsafe wildcard CORS rule",
  );
  const matchingRule = properties.cors?.find(
    (rule) =>
      rule.allowedMethods === "PUT,OPTIONS" &&
      rule.allowedOrigins
        .split(",")
        .map((value) => value.trim())
        .sort()
        .join(",") === allowedOrigins.join(","),
  );
  assert.ok(
    matchingRule,
    "Azure CORS did not include the configured exact origins",
  );
  assert.equal(matchingRule.allowedOrigins.includes("*"), false);
}

async function readyFile(input) {
  const initiated = await initiate(input);
  await assertBrowserPreflight(initiated.upload);
  const upload = await directUpload(initiated.upload, input.buffer);
  assert.equal(upload.status, 201);
  const completed = await api(
    `/api/data-sources/${initiated.data.id}/complete`,
    { method: "POST" },
  );
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.status, "ready");
  assert.equal(completed.body.data.azureETag, upload.etag);
  return {
    data: completed.body.data,
    upload: initiated.upload,
    buffer: input.buffer,
  };
}

async function assertBrowserPreflight(upload) {
  const origin = allowedOrigins[0];
  assert.ok(origin);
  const response = await fetchWithDeadline(
    upload.url,
    {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": Object.keys(upload.headers).join(","),
      },
    },
    {
      operation: "Azure upload CORS preflight",
      timeoutMs: API_TIMEOUT_MS,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
}

async function initiate(input, declaredSize = input.buffer.length) {
  const response = await api("/api/data-sources/files/initiate", {
    method: "POST",
    body: {
      name: input.name,
      filename: input.filename,
      mimeType: input.mimeType,
      fileSizeBytes: declaredSize,
    },
  });
  assert.equal(response.status, 201);
  const sas = new URL(response.body.upload.url);
  assert.equal(sas.protocol, "https:");
  assert.equal(sas.searchParams.get("spr"), "https");
  assert.equal(sas.searchParams.get("sp"), "c");
  assert.equal(sas.searchParams.get("sr"), "b");
  assert.equal(sas.searchParams.get("sp").includes("r"), false);
  assert.equal(sas.searchParams.get("sp").includes("l"), false);
  registerCleanup(response.body.data);
  return response.body;
}

async function directUpload(upload, buffer) {
  const response = await fetchWithDeadline(
    upload.url,
    {
      method: "PUT",
      headers: upload.headers,
      body: buffer,
    },
    {
      operation: "Azure direct blob upload",
      timeoutMs: uploadTimeoutMs,
      payloadBytes: buffer.length,
      configurationName: "FILE_DATASOURCE_UPLOAD_TIMEOUT_MS",
    },
  );
  return { status: response.status, etag: response.headers.get("etag") };
}

async function missingUploadCase(declaredSize) {
  const initiated = await initiate(
    {
      name: "missing upload",
      filename: `${nonce}-missing.csv`,
      mimeType: CSV_MIME,
      buffer: Buffer.alloc(declaredSize),
    },
    declaredSize,
  );
  const response = await api(
    `/api/data-sources/${initiated.data.id}/complete`,
    { method: "POST" },
  );
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "UPLOAD_BLOB_MISSING");
}

async function sizeMismatchCase(buffer) {
  const initiated = await initiate(
    {
      name: "size mismatch",
      filename: `${nonce}-size.csv`,
      mimeType: CSV_MIME,
      buffer,
    },
    buffer.length + 1,
  );
  assert.equal((await directUpload(initiated.upload, buffer)).status, 201);
  const response = await api(
    `/api/data-sources/${initiated.data.id}/complete`,
    { method: "POST" },
  );
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "UPLOAD_METADATA_MISMATCH");
}

async function unsupportedInitiationCases() {
  for (const body of [
    {
      name: "unsupported extension",
      filename: `${nonce}.txt`,
      mimeType: "text/plain",
      fileSizeBytes: 12,
    },
    {
      name: "MIME mismatch",
      filename: `${nonce}.csv`,
      mimeType: XLSX_MIME,
      fileSizeBytes: 12,
    },
  ]) {
    const response = await api("/api/data-sources/files/initiate", {
      method: "POST",
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_FILE_UPLOAD");
  }
}

async function invalidContentCase(input) {
  const initiated = await initiate(input);
  assert.equal(
    (await directUpload(initiated.upload, input.buffer)).status,
    201,
  );
  const response = await api(
    `/api/data-sources/${initiated.data.id}/complete`,
    { method: "POST" },
  );
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "INVALID_FILE_CONTENT");
}

async function oversizedCases() {
  const declaration = await api("/api/data-sources/files/initiate", {
    method: "POST",
    body: {
      name: "oversized declaration",
      filename: `${nonce}-large.csv`,
      mimeType: CSV_MIME,
      fileSizeBytes: maximumFileSize + 1,
    },
  });
  assert.equal(declaration.status, 400);

  const oversizedBuffer = Buffer.alloc(maximumFileSize + 1, 0x61);
  const initiated = await initiate(
    {
      name: "oversized actual upload",
      filename: `${nonce}-actual-large.csv`,
      mimeType: CSV_MIME,
      buffer: oversizedBuffer,
    },
    maximumFileSize,
  );
  assert.equal(
    (await directUpload(initiated.upload, oversizedBuffer)).status,
    201,
  );
  const completion = await api(
    `/api/data-sources/${initiated.data.id}/complete`,
    { method: "POST" },
  );
  assert.equal(completion.status, 422);
  assert.equal(completion.body.error.code, "UPLOAD_METADATA_MISMATCH");
}

async function unknownAndDeletedCases(buffer, preserved) {
  const unknownId = generateDataSourceId();
  for (const [path, method] of [
    [`/api/data-sources/${unknownId}`, "GET"],
    [`/api/data-sources/${unknownId}/complete`, "POST"],
    [`/api/data-sources/${unknownId}`, "DELETE"],
  ]) {
    assert.equal((await api(path, { method })).status, 404);
  }

  const ready = await readyFile({
    name: "deleted file",
    filename: `${nonce}-deleted.csv`,
    mimeType: CSV_MIME,
    buffer,
  });
  assert.equal(
    (await api(`/api/data-sources/${ready.data.id}`, { method: "DELETE" }))
      .status,
    204,
  );
  cleanupRows.get(ready.data.id).deleted = true;
  assert.equal(
    await containerClient.getBlobClient(ready.data.azureBlobName).exists(),
    false,
  );
  assert.equal(
    await containerClient.getBlobClient(preserved.data.azureBlobName).exists(),
    true,
  );
  const deleted = await getDataSource({
    dataSourceId: ready.data.id,
    includeDeleted: true,
  });
  assert.equal(deleted?.azureCleanupStatus, "deleted");
  assert.equal(deleted?.azureCleanupETag, ready.data.azureETag);
  assert.equal(deleted?.azureCleanupAttempts, 1);
  assert.ok(deleted?.azureCleanupCompletedAt instanceof Date);
  assert.equal(deleted?.azureCleanupErrorCode, null);
  assert.equal(
    (await api(`/api/data-sources/${ready.data.id}`, { method: "DELETE" }))
      .status,
    204,
  );
  assert.equal((await api(`/api/data-sources/${ready.data.id}`)).status, 404);
  assert.equal(
    (
      await api(`/api/data-sources/${ready.data.id}/complete`, {
        method: "POST",
      })
    ).status,
    404,
  );
  const listed = await api("/api/data-sources?limit=100");
  assert.equal(
    listed.body.data.some((row) => row.id === ready.data.id),
    false,
  );
}

async function retryDeletedCleanupCase(buffer, preserved) {
  const ready = await readyFile({
    name: "retry deleted cleanup",
    filename: `${nonce}-retry-delete.csv`,
    mimeType: CSV_MIME,
    buffer,
  });
  const locallyDeleted = await beginDataSourceDeletion({
    dataSourceId: ready.data.id,
  });
  assert.equal(locallyDeleted?.azureCleanupStatus, "pending");
  assert.equal(
    await containerClient.getBlobClient(ready.data.azureBlobName).exists(),
    true,
  );
  assert.equal((await api(`/api/data-sources/${ready.data.id}`)).status, 404);

  const firstSweep = await runExactBlobCleanupSweep(ready.data.id);
  assert.equal(firstSweep.selected, 1);
  assert.equal(firstSweep.processed, 1);
  assert.equal(firstSweep.outcomes.deleted, 1);
  assert.equal(firstSweep.pendingRemaining, 0);
  cleanupRows.get(ready.data.id).deleted = true;
  assert.equal(
    await containerClient.getBlobClient(ready.data.azureBlobName).exists(),
    false,
  );
  assert.equal(
    await containerClient.getBlobClient(preserved.data.azureBlobName).exists(),
    true,
  );
  const cleaned = await getDataSource({
    dataSourceId: ready.data.id,
    includeDeleted: true,
  });
  assert.equal(cleaned?.azureCleanupStatus, "deleted");
  assert.equal(cleaned?.azureCleanupAttempts, 1);
  const terminalRetry = await runExactBlobCleanupSweep(ready.data.id);
  assert.equal(terminalRetry.selected, 0);
  assert.equal(terminalRetry.processed, 0);
  assert.equal(terminalRetry.pendingRemaining, 0);
}

async function overwriteProtectionCases(ready, replacement) {
  const secondSasWrite = await directUpload(ready.upload, replacement);
  assert.notEqual(secondSasWrite.status, 201);
  assert.ok(secondSasWrite.status === 403 || secondSasWrite.status === 409);

  const privileged = containerClient.getBlockBlobClient(
    ready.data.azureBlobName,
  );
  await privileged.uploadData(
    Buffer.from(`name,value,nonce\noverwritten,99,${nonce}\n`),
    { blobHTTPHeaders: { blobContentType: CSV_MIME } },
  );
  const changed = await api(`/api/data-sources/${ready.data.id}/complete`, {
    method: "POST",
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, "UPLOAD_CHANGED");
  assert.equal(
    (await getDataSource({ dataSourceId: ready.data.id }))?.status,
    "failed",
  );
  const overwrittenProperties = await privileged.getProperties();
  assert.ok(overwrittenProperties.etag);
  const locallyDeleted = await beginDataSourceDeletion({
    dataSourceId: ready.data.id,
  });
  assert.equal(locallyDeleted?.azureCleanupStatus, "pending");
  const sweep = await runExactBlobCleanupSweep(ready.data.id);
  assert.equal(sweep.outcomes.superseded, 1);
  assert.equal(sweep.pendingRemaining, 0);
  cleanupRows.get(ready.data.id).deleted = true;
  const superseded = await getDataSource({
    dataSourceId: ready.data.id,
    includeDeleted: true,
  });
  assert.equal(superseded?.azureCleanupStatus, "superseded");
  assert.equal(superseded?.azureCleanupETag, ready.data.azureETag);
  assert.equal(superseded?.azureCleanupAttempts, 1);
  assert.equal(
    (
      await privileged.getProperties({
        conditions: { ifMatch: overwrittenProperties.etag },
      })
    ).etag,
    overwrittenProperties.etag,
  );
  assert.equal(
    (await api(`/api/data-sources/${ready.data.id}`, { method: "DELETE" }))
      .status,
    204,
  );
}

async function runExactBlobCleanupSweep(dataSourceId) {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["--filter", "web", "sweep:file-datasource-blobs"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        FILE_DATASOURCE_CLEANUP_BATCH_SIZE: "1",
        FILE_DATASOURCE_CLEANUP_DATA_SOURCE_IDS: dataSourceId,
      },
      maxBuffer: 1024 * 1024,
      timeout: API_TIMEOUT_MS,
    },
  );
  const summaryLine = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!summaryLine) {
    throw new Error("Blob cleanup worker did not emit a JSON summary.");
  }
  return JSON.parse(summaryLine);
}

function registerCleanup(data) {
  cleanupRows.set(data.id, {
    id: data.id,
    blobName: data.azureBlobName,
    deleted: false,
  });
}

async function cleanup() {
  const errors = [];
  for (const row of cleanupRows.values()) {
    let retryDelete = false;
    if (!row.deleted) {
      try {
        const response = await api(`/api/data-sources/${row.id}`, {
          method: "DELETE",
        });
        retryDelete = response.status !== 204 && response.status !== 404;
      } catch {
        retryDelete = true;
      }
    }
    if (row.blobName) {
      try {
        await containerClient.getBlobClient(row.blobName).deleteIfExists({
          deleteSnapshots: "include",
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (retryDelete) {
      try {
        const response = await api(`/api/data-sources/${row.id}`, {
          method: "DELETE",
        });
        if (response.status !== 204 && response.status !== 404) {
          errors.push(
            new Error(`Datasource cleanup returned ${response.status}.`),
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
  }
  return errors;
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetchWithDeadline(
    `${webUrl}${path}`,
    {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {
      operation: `API ${method} ${path}`,
      timeoutMs: API_TIMEOUT_MS,
    },
  );
  const responseBody = await response.json().catch(() => undefined);
  return { status: response.status, body: responseBody };
}

async function fetchWithDeadline(url, options, deadline) {
  const startedAt = Date.now();
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(deadline.timeoutMs),
    });
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    const payload =
      deadline.payloadBytes === undefined
        ? ""
        : `, payloadBytes=${deadline.payloadBytes}`;
    const configurationHint = deadline.configurationName
      ? ` Increase ${deadline.configurationName} only for slower live Azure links.`
      : "";
    throw new Error(
      `${deadline.operation} timed out after ${deadline.timeoutMs} ms (elapsedMs=${Date.now() - startedAt}${payload}).${configurationHint}`,
      { cause: error },
    );
  }
}

function isTimeoutError(error) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function boundedIntegerEnvironment(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeHttpUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WEB_URL must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([?&]sig=)[^&\s]+/gi, "$1[redacted]")
    .replaceAll(databaseUrl, "[redacted]")
    .replaceAll(accountKey, "[redacted]");
}
