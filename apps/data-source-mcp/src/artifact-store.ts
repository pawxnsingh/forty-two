import { createHash } from "node:crypto";

import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_COLUMNS,
  MAX_ARTIFACT_ROWS,
  MAX_ARTIFACT_STRING_BYTES,
  TableColumnsV1Schema,
  parseCanonicalTableV1,
  serializeQueryResultTableV1,
  type SourceColumnMetadata,
  type CanonicalTableV1,
  type TableColumnV1,
} from "@forty-two/artifacts";
import {
  analysisArtifactBlobBindingExists,
  analysisArtifactBlobExists,
  commitChartArtifact,
  commitTableArtifact,
  deriveAnalysisArtifactId,
  getAnalysisArtifact,
  getReadyAnalysisArtifacts,
  listAnalysisArtifactsDueForCleanup,
  listAnalysisArtifactParents,
  markAnalysisArtifactCleanupCompleted,
  markAnalysisArtifactLeaseLost,
  type AnalysisArtifact,
  type ArtifactProvenance,
} from "@forty-two/db";
import { validateChartConfigV1 } from "@repo/charting/server";
import {
  type BlobLeaseClient,
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { z } from "zod";

import type { FileDownloadConfig } from "./config.js";

const ARTIFACT_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
const UPLOAD_TTL_MS = 60_000;
const DOWNLOAD_TTL_MS = 60_000;
const LEASE_SECONDS = 30;
const LEASE_RENEWAL_INTERVAL_MS = 10_000;
const STALE_FINALIZATION_MS = 60 * 60_000;
const FINALIZATION_STARTED_METADATA_KEY = "fortytwoFinalizationStartedAt";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ArtifactIdSchema = z.string().regex(/^art_[0-9A-HJKMNP-TV-Z]{26}$/);
const ParentIdsSchema = z
  .array(ArtifactIdSchema)
  .max(50)
  .default([])
  .transform((ids) => [...new Set(ids)].sort());

const defaultRepositories = {
  analysisArtifactBlobBindingExists,
  analysisArtifactBlobExists,
  commitChartArtifact,
  commitTableArtifact,
  getAnalysisArtifact,
  getReadyAnalysisArtifacts,
  listAnalysisArtifactsDueForCleanup,
  listAnalysisArtifactParents,
  markAnalysisArtifactCleanupCompleted,
  markAnalysisArtifactLeaseLost,
};

export const BeginTableArtifactUploadInputSchema = z
  .object({
    contentSha256: Sha256Schema,
    byteSize: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
    rowCount: z.number().int().nonnegative().max(MAX_ARTIFACT_ROWS),
    columns: TableColumnsV1Schema,
    parentArtifactIds: ParentIdsSchema,
    sourceReferences: z
      .array(z.string().min(1).max(1_024))
      .max(50)
      .default([])
      .transform((references) => [...new Set(references)].sort()),
  })
  .strict();

export const FinalizeTableArtifactInputSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    contentSha256: Sha256Schema,
    title: z.string().trim().min(1).max(500).nullable().optional(),
    parentArtifactIds: ParentIdsSchema,
    sourceReferences: z
      .array(z.string().min(1).max(1_024))
      .max(50)
      .default([])
      .transform((references) => [...new Set(references)].sort()),
  })
  .strict();

export const FinalizeChartArtifactInputSchema = z
  .object({
    schemaVersion: z.literal("chart.receipt.v1"),
    inputArtifactId: ArtifactIdSchema,
    sourceContentSha256: Sha256Schema,
    rowCount: z.number().int().nonnegative().max(MAX_ARTIFACT_ROWS),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(2_000).nullable().optional(),
    config: z.record(z.string(), z.unknown()),
    receiptSha256: Sha256Schema,
    warnings: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  })
  .strict();

export type BeginTableArtifactUploadInput = z.input<
  typeof BeginTableArtifactUploadInputSchema
>;
export type FinalizeTableArtifactInput = z.input<
  typeof FinalizeTableArtifactInputSchema
>;
export type FinalizeChartArtifactInput = z.input<
  typeof FinalizeChartArtifactInputSchema
>;

export type TableArtifactUploadDescriptor = {
  artifactId: string;
  upload: {
    url: string;
    method: "PUT";
    expiresAt: string;
    maximumSizeBytes: number;
    headers: Record<string, string>;
  };
};

export type TableArtifactDownloadDescriptor = {
  artifactId: string;
  schemaVersion: "table.v1";
  url: string;
  expiresAt: string;
  expectedETag: string;
  contentSha256: string;
  sizeBytes: number;
  rowCount: number;
  columns: TableColumnV1[];
  sourceLimited: boolean;
  sourceMaxRows: number | null;
  requestHeaders: { "If-Match": string };
};

function canonicalIdentity(input: {
  chatSessionId: string;
  contentSha256: string;
  parentArtifactIds: readonly string[];
}): string {
  return JSON.stringify({
    chatSessionId: input.chatSessionId,
    schemaVersion: "table.v1",
    contentSha256: input.contentSha256,
    parentArtifactIds: [...input.parentArtifactIds].sort(),
  });
}

function artifactIdFor(input: {
  chatSessionId: string;
  contentSha256: string;
  parentArtifactIds: readonly string[];
}): string {
  return deriveAnalysisArtifactId(canonicalIdentity(input));
}

function blobName(chatSessionId: string, artifactId: string): string {
  return `artifacts/${chatSessionId}/${artifactId}/table.v1.jsonl`;
}

function artifactIdFromBlobName(name: string): string | null {
  const segments = name.split("/");
  if (
    segments.length !== 4 ||
    segments[0] !== "artifacts" ||
    segments[3] !== "table.v1.jsonl"
  ) {
    return null;
  }
  const parsed = ArtifactIdSchema.safeParse(segments[2]);
  return parsed.success ? parsed.data : null;
}

function encodedBlobUrl(
  config: FileDownloadConfig,
  name: string,
  query: string,
): string {
  const path = name.split("/").map(encodeURIComponent).join("/");
  return `https://${config.accountName}.blob.core.windows.net/${encodeURIComponent(config.container)}/${path}?${query}`;
}

function isAzureStatus(error: unknown, ...statuses: number[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    statuses.includes(error.statusCode)
  );
}

function finalizationStartedAt(properties: {
  metadata?: Record<string, string>;
}): Date | null {
  const entry = Object.entries(properties.metadata ?? {}).find(
    ([key]) =>
      key.toLowerCase() === FINALIZATION_STARTED_METADATA_KEY.toLowerCase(),
  );
  if (!entry) return null;
  const timestamp = new Date(entry[1]);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function hasRecentFinalizationMarker(
  properties: { metadata?: Record<string, string> },
  staleBefore: Date,
): boolean {
  const startedAt = finalizationStartedAt(properties);
  return startedAt !== null && startedAt > staleBefore;
}

function hasStaleInfiniteFinalizationLease(
  properties: {
    metadata?: Record<string, string>;
    leaseDuration?: string;
    leaseStatus?: string;
  },
  staleBefore: Date,
): boolean {
  const startedAt = finalizationStartedAt(properties);
  return (
    properties.leaseDuration === "infinite" &&
    properties.leaseStatus === "locked" &&
    startedAt !== null &&
    startedAt <= staleBefore
  );
}

class ArtifactLeaseLostError extends Error {
  override readonly name = "ArtifactLeaseLostError";

  constructor(cause: unknown) {
    super("Azure artifact lease was lost; the operation was aborted.", {
      cause,
    });
  }
}

/**
 * Keeps a finite Azure lease alive while retaining Azure's automatic crash
 * recovery. A failed renewal is sticky: subsequent ownership checks abort
 * instead of allowing metadata commit or blob deletion to continue.
 */
class RenewingBlobLease {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private renewal: Promise<void> | undefined;
  private loss: ArtifactLeaseLostError | undefined;
  private acquired = false;
  private stopped = false;

  constructor(private readonly lease: BlobLeaseClient) {}

  get leaseId(): string {
    return this.lease.leaseId;
  }

  async acquire(): Promise<void> {
    await this.lease.acquireLease(LEASE_SECONDS);
    this.acquired = true;
    this.scheduleRenewal();
  }

  async renewNow(): Promise<void> {
    this.clearTimer();
    await this.performRenewal();
    this.scheduleRenewal();
  }

  async release(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    if (this.renewal) await this.renewal.catch(() => undefined);
    if (!this.acquired || this.loss) return;
    try {
      await this.lease.releaseLease();
    } catch (error) {
      if (!isAzureStatus(error, 409, 412)) throw error;
    } finally {
      this.acquired = false;
    }
  }

  completeAfterDelete(): void {
    this.stopped = true;
    this.acquired = false;
    this.clearTimer();
  }

  private scheduleRenewal(): void {
    if (this.stopped || this.loss || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.performRenewal()
        .catch(() => undefined)
        .finally(() => this.scheduleRenewal());
    }, LEASE_RENEWAL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async performRenewal(): Promise<void> {
    if (this.loss) throw this.loss;
    if (!this.acquired || this.stopped) {
      throw new ArtifactLeaseLostError(
        new Error("Azure artifact lease is not active."),
      );
    }
    if (!this.renewal) {
      const renewing = (async () => {
        try {
          await this.lease.renewLease();
        } catch (error) {
          this.loss = new ArtifactLeaseLostError(error);
          this.stopped = true;
          this.clearTimer();
          throw this.loss;
        }
      })();
      this.renewal = renewing;
      void renewing.then(
        () => {
          if (this.renewal === renewing) this.renewal = undefined;
        },
        () => {
          if (this.renewal === renewing) this.renewal = undefined;
        },
      );
    }
    await this.renewal;
    if (this.loss) throw this.loss;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function receipt(artifact: AnalysisArtifact) {
  return {
    artifactId: artifact.id,
    schemaVersion: artifact.schemaVersion,
    contentSha256: artifact.contentSha256,
    byteSize: artifact.byteSize,
    rowCount: artifact.rowCount,
    columns: artifact.columns,
    preview: artifact.preview,
    sourceLimited: artifact.sourceLimited,
    sourceMaxRows: artifact.sourceMaxRows,
    warnings: artifact.sourceLimited
      ? [
          `This artifact contains only the first ${artifact.sourceMaxRows} rows. Do not use it for totals, joins, averages, or completeness claims.`,
        ]
      : [],
  };
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableJsonValue(record[key])]),
    );
  }
  return value;
}

function validatedInputShape(input: unknown, parsed: unknown): unknown {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    return parsed.map((value, index) =>
      validatedInputShape(input[index], value),
    );
  }
  if (
    input &&
    typeof input === "object" &&
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    const inputRecord = input as Record<string, unknown>;
    const parsedRecord = parsed as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(inputRecord)
        .filter(
          (key) =>
            Object.hasOwn(parsedRecord, key) && parsedRecord[key] !== undefined,
        )
        .map((key) => [
          key,
          validatedInputShape(inputRecord[key], parsedRecord[key]),
        ]),
    );
  }
  return parsed;
}

export class ArtifactStore {
  private orphanCleanupContinuationToken: string | undefined;
  private readonly credential: StorageSharedKeyCredential;
  private readonly service: BlobServiceClient;
  private readonly repositories: typeof defaultRepositories;

  constructor(
    private readonly config: FileDownloadConfig,
    service?: BlobServiceClient,
    repositories: Partial<typeof defaultRepositories> = {},
  ) {
    this.credential = new StorageSharedKeyCredential(
      config.accountName,
      config.accountKey,
    );
    this.service =
      service ??
      new BlobServiceClient(
        `https://${config.accountName}.blob.core.windows.net`,
        this.credential,
      );
    this.repositories = { ...defaultRepositories, ...repositories };
  }

  private container() {
    return this.service.getContainerClient(this.config.container);
  }

  async beginTableUpload(input: {
    chatSessionId: string;
    request: BeginTableArtifactUploadInput;
    now?: Date;
  }): Promise<TableArtifactUploadDescriptor> {
    const request = BeginTableArtifactUploadInputSchema.parse(input.request);
    const parents = await this.repositories.getReadyAnalysisArtifacts({
      chatSessionId: input.chatSessionId,
      artifactIds: request.parentArtifactIds,
    });
    if (parents.length !== request.parentArtifactIds.length) {
      throw new Error("One or more parent artifacts are unavailable.");
    }
    if (parents.some((parent) => parent.sourceLimited)) {
      throw new Error(
        "Limited database artifacts cannot be parents of a derived table. Aggregate or narrow the source query first.",
      );
    }

    const artifactId = artifactIdFor({
      chatSessionId: input.chatSessionId,
      contentSha256: request.contentSha256,
      parentArtifactIds: request.parentArtifactIds,
    });
    const name = blobName(input.chatSessionId, artifactId);
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS);
    const query = generateBlobSASQueryParameters(
      {
        containerName: this.config.container,
        blobName: name,
        permissions: BlobSASPermissions.parse("c"),
        protocol: SASProtocol.Https,
        startsOn: new Date(now.getTime() - 30_000),
        expiresOn: expiresAt,
        contentType: ARTIFACT_CONTENT_TYPE,
      },
      this.credential,
    ).toString();
    return {
      artifactId,
      upload: {
        url: encodedBlobUrl(this.config, name, query),
        method: "PUT",
        expiresAt: expiresAt.toISOString(),
        maximumSizeBytes: MAX_ARTIFACT_BYTES,
        headers: {
          "Content-Type": ARTIFACT_CONTENT_TYPE,
          "If-None-Match": "*",
          "x-ms-blob-content-type": ARTIFACT_CONTENT_TYPE,
          "x-ms-blob-type": "BlockBlob",
        },
      },
    };
  }

  async getTableDownloadDescriptor(input: {
    chatSessionId: string;
    artifactId: string;
    now?: Date;
  }): Promise<TableArtifactDownloadDescriptor> {
    const artifactId = ArtifactIdSchema.parse(input.artifactId);
    const artifact = await this.repositories.getAnalysisArtifact({
      chatSessionId: input.chatSessionId,
      artifactId,
    });
    if (
      !artifact ||
      artifact.kind !== "table" ||
      !artifact.azureBlobName ||
      !artifact.azureETag ||
      artifact.rowCount === null ||
      !artifact.columns
    ) {
      throw new Error("Artifact not found.");
    }
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + DOWNLOAD_TTL_MS);
    const query = generateBlobSASQueryParameters(
      {
        containerName: this.config.container,
        blobName: artifact.azureBlobName,
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.Https,
        startsOn: new Date(now.getTime() - 30_000),
        expiresOn: expiresAt,
      },
      this.credential,
    ).toString();
    return {
      artifactId: artifact.id,
      schemaVersion: "table.v1",
      url: encodedBlobUrl(this.config, artifact.azureBlobName, query),
      expiresAt: expiresAt.toISOString(),
      expectedETag: artifact.azureETag,
      contentSha256: artifact.contentSha256,
      sizeBytes: artifact.byteSize,
      rowCount: artifact.rowCount,
      columns: artifact.columns,
      sourceLimited: artifact.sourceLimited,
      sourceMaxRows: artifact.sourceMaxRows,
      requestHeaders: { "If-Match": artifact.azureETag },
    };
  }

  private async downloadCanonicalTable(input: {
    name: string;
    etag: string;
    leaseId?: string;
    expected?: Parameters<typeof parseCanonicalTableV1>[1];
  }): Promise<CanonicalTableV1> {
    const response = await this.container()
      .getBlobClient(input.name)
      .download(0, undefined, {
        conditions: {
          ifMatch: input.etag,
          ...(input.leaseId ? { leaseId: input.leaseId } : {}),
        },
      });
    const stream = response.readableStreamBody;
    if (!stream) throw new Error("Azure returned an empty artifact stream.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_ARTIFACT_BYTES) {
        throw new Error("Canonical table exceeds the 5 MiB artifact limit.");
      }
      chunks.push(bytes);
    }
    return parseCanonicalTableV1(Buffer.concat(chunks, size), input.expected);
  }

  async finalizeTable(input: {
    chatSessionId: string;
    request: FinalizeTableArtifactInput;
    now?: Date;
  }) {
    const request = FinalizeTableArtifactInputSchema.parse(input.request);
    const expectedId = artifactIdFor({
      chatSessionId: input.chatSessionId,
      contentSha256: request.contentSha256,
      parentArtifactIds: request.parentArtifactIds,
    });
    if (request.artifactId !== expectedId) {
      throw new Error("Artifact id does not match its content identity.");
    }
    const existing = await this.repositories.getAnalysisArtifact({
      chatSessionId: input.chatSessionId,
      artifactId: request.artifactId,
    });
    if (existing) {
      const existingParents =
        await this.repositories.listAnalysisArtifactParents({
          chatSessionId: input.chatSessionId,
          artifactId: existing.id,
        });
      if (
        existing.kind !== "table" ||
        existing.contentSha256 !== request.contentSha256 ||
        existing.title !== (request.title ?? null) ||
        JSON.stringify(existingParents) !==
          JSON.stringify(request.parentArtifactIds) ||
        JSON.stringify(existing.provenance.sourceReferences) !==
          JSON.stringify(request.sourceReferences)
      ) {
        throw new Error(
          "Artifact retry conflicts with the committed artifact.",
        );
      }
      return receipt(existing);
    }

    const name = blobName(input.chatSessionId, request.artifactId);
    const blob = this.container().getBlobClient(name);
    const markerAt = input.now ?? new Date();
    const beforeMarker = await blob.getProperties();
    if (!beforeMarker.etag)
      throw new Error("Uploaded artifact did not have an ETag.");
    await blob.setMetadata(
      {
        ...beforeMarker.metadata,
        [FINALIZATION_STARTED_METADATA_KEY]: markerAt.toISOString(),
      },
      { conditions: { ifMatch: beforeMarker.etag } },
    );
    const lease = blob.getBlobLeaseClient();
    let acquired = false;
    let committed: AnalysisArtifact | undefined;
    let committedETag: string | undefined;
    try {
      await lease.acquireLease(-1);
      acquired = true;
      const leaseId = lease.leaseId;
      const properties = await blob.getProperties({ conditions: { leaseId } });
      if (!properties.etag)
        throw new Error("Uploaded artifact did not have an ETag.");
      committedETag = properties.etag;
      if (
        properties.contentLength === undefined ||
        properties.contentLength > MAX_ARTIFACT_BYTES
      ) {
        throw new Error("Uploaded artifact exceeds the 5 MiB limit.");
      }
      if (properties.contentType !== ARTIFACT_CONTENT_TYPE) {
        throw new Error("Uploaded artifact content type is invalid.");
      }
      const table = await this.downloadCanonicalTable({
        name,
        etag: properties.etag,
        leaseId,
        expected: {
          contentSha256: request.contentSha256,
          byteSize: properties.contentLength,
        },
      });
      committed = await this.repositories.commitTableArtifact(
        {
          artifactId: request.artifactId,
          chatSessionId: input.chatSessionId,
          title: request.title ?? null,
          azureBlobName: name,
          azureETag: properties.etag,
          contentSha256: table.contentSha256,
          byteSize: table.byteSize,
          rowCount: table.rowCount,
          columns: table.columns,
          preview: table.preview,
          sourceLimited: false,
          sourceMaxRows: null,
          parentArtifactIds: request.parentArtifactIds,
          provenance: {
            tool: "finalize_table_artifact",
            operationKey: `emit:${request.artifactId}`,
            sourceReferences: request.sourceReferences,
            dataSourceIds: [],
            completedAt: new Date().toISOString(),
          },
        },
        {
          beforeTransactionCommit: async () => {
            await blob.getProperties({
              conditions: { ifMatch: properties.etag, leaseId },
            });
          },
        },
      );
      const response = receipt(committed);
      await blob.getProperties({
        conditions: { ifMatch: properties.etag, leaseId },
      });
      await lease.releaseLease();
      acquired = false;
      return response;
    } catch (error) {
      if (committed && committedETag) {
        await this.repositories.markAnalysisArtifactLeaseLost({
          artifactId: committed.id,
          azureBlobName: name,
          azureETag: committedETag,
        });
        throw new ArtifactLeaseLostError(error);
      }
      throw error;
    } finally {
      if (acquired) {
        try {
          await lease.releaseLease();
        } catch {
          // Preserve the operation failure; stale infinite leases are recovered by cleanup.
        }
      }
    }
  }

  async persistQueryResult(input: {
    chatSessionId: string;
    dataSourceId: string;
    sql: string;
    maxRows: number;
    requestId: string;
    columns: SourceColumnMetadata[];
    rows: Record<string, unknown>[];
    sourceLimited: boolean;
    sourceTotalRowCount?: number;
    startedAt?: Date;
  }) {
    if (input.rows.length === 0) return null;
    const table = serializeQueryResultTableV1({
      columns: input.columns,
      rows: input.rows,
    });
    const artifactId = deriveAnalysisArtifactId(
      JSON.stringify({
        chatSessionId: input.chatSessionId,
        schemaVersion: "table.v1",
        operationKey: `query:${input.requestId}`,
      }),
    );
    const name = blobName(input.chatSessionId, artifactId);
    const blockBlob = this.container().getBlockBlobClient(name);
    let etag: string | undefined;
    try {
      const response = await blockBlob.uploadData(table.bytes, {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: ARTIFACT_CONTENT_TYPE },
      });
      etag = response.etag;
    } catch (error) {
      if (!isAzureStatus(error, 409, 412)) throw error;
      const properties = await blockBlob.getProperties();
      etag = properties.etag;
      if (!etag)
        throw new Error("Existing artifact blob did not have an ETag.");
      await this.downloadCanonicalTable({
        name,
        etag,
        expected: {
          contentSha256: table.contentSha256,
          byteSize: table.byteSize,
          rowCount: table.rowCount,
          columns: table.columns,
        },
      });
    }
    if (!etag) throw new Error("Azure did not return an artifact ETag.");
    const sqlSha256 = createHash("sha256")
      .update(input.sql, "utf8")
      .digest("hex");
    const operationKey = `query:${input.requestId}`;
    const provenance: ArtifactProvenance = {
      tool: "create_query_table_artifact",
      operationKey,
      dataSourceIds: [input.dataSourceId],
      sourceReferences: [
        `datasource:${input.dataSourceId}`,
        ...(input.sourceTotalRowCount === undefined
          ? []
          : [`sourceTotalRowCount:${input.sourceTotalRowCount}`]),
      ],
      sqlSha256,
      ...(input.startedAt ? { startedAt: input.startedAt.toISOString() } : {}),
      completedAt: new Date().toISOString(),
    };
    const artifact = await this.repositories.commitTableArtifact({
      artifactId,
      chatSessionId: input.chatSessionId,
      title: `Query result from ${input.dataSourceId}`,
      azureBlobName: name,
      azureETag: etag,
      contentSha256: table.contentSha256,
      byteSize: table.byteSize,
      rowCount: table.rowCount,
      columns: table.columns,
      preview: table.preview,
      sourceLimited: input.sourceLimited,
      sourceMaxRows: input.sourceLimited ? input.maxRows : null,
      parentArtifactIds: [],
      provenance,
    });
    return receipt(artifact);
  }

  async finalizeChartArtifact(input: {
    chatSessionId: string;
    request: FinalizeChartArtifactInput;
  }) {
    const request = FinalizeChartArtifactInputSchema.parse(input.request);
    const source = await this.repositories.getAnalysisArtifact({
      chatSessionId: input.chatSessionId,
      artifactId: request.inputArtifactId,
    });
    if (
      !source ||
      source.kind !== "table" ||
      source.rowCount === null ||
      !source.columns
    ) {
      throw new Error("Input artifact not found.");
    }
    if (
      request.sourceContentSha256 !== source.contentSha256 ||
      request.rowCount !== source.rowCount
    ) {
      throw new Error(
        "Chart receipt does not match the committed source table.",
      );
    }
    const config = validateChartConfigV1({
      config: request.config,
      columns: source.columns,
      rowCount: source.rowCount,
    });
    const receiptConfig = validatedInputShape(request.config, config);
    const receiptPayload = stableJsonValue({
      sessionId: input.chatSessionId,
      schemaVersion: request.schemaVersion,
      inputArtifactId: source.id,
      sourceContentSha256: source.contentSha256,
      rowCount: source.rowCount,
      title: request.title,
      description: request.description ?? null,
      config: receiptConfig,
      warnings: request.warnings,
    });
    const expectedReceiptSha256 = createHash("sha256")
      .update(JSON.stringify(receiptPayload), "utf8")
      .digest("hex");
    if (request.receiptSha256 !== expectedReceiptSha256) {
      throw new Error("Chart receipt hash is invalid.");
    }
    const identityPayload = stableJsonValue({
      schemaVersion: "chart.v1",
      sourceArtifactId: source.id,
      sourceContentSha256: source.contentSha256,
      title: request.title,
      description: request.description ?? null,
      config,
    });
    const serialized = JSON.stringify(identityPayload);
    const contentSha256 = createHash("sha256")
      .update(serialized, "utf8")
      .digest("hex");
    const artifactId = deriveAnalysisArtifactId(
      JSON.stringify({
        chatSessionId: input.chatSessionId,
        schemaVersion: "chart.v1",
        contentSha256,
      }),
    );
    const chartConfig = {
      sourceArtifactId: source.id,
      sourceContentSha256: source.contentSha256,
      config,
    };
    const artifact = await this.repositories.commitChartArtifact({
      artifactId,
      chatSessionId: input.chatSessionId,
      inputArtifactId: source.id,
      title: request.title,
      description: request.description ?? null,
      contentSha256,
      byteSize: Buffer.byteLength(serialized, "utf8"),
      chartConfig,
      parentArtifactIds: [],
      provenance: {
        tool: "finalize_chart_artifact",
        operationKey: `finalize-chart:${artifactId}`,
        dataSourceIds: source.provenance.dataSourceIds,
        sourceReferences: [`artifact:${source.id}`],
        completedAt: new Date().toISOString(),
      },
    });
    return {
      artifactId: artifact.id,
      schemaVersion: "chart.v1" as const,
      sourceArtifactId: source.id,
      sourceContentSha256: source.contentSha256,
      config,
      warnings: [
        ...request.warnings,
        ...(source.sourceLimited
          ? [
              `The source table is limited to ${source.sourceMaxRows} rows; this chart is a partial preview and must not be presented as complete.`,
            ]
          : []),
      ],
    };
  }

  async downloadCommittedTable(input: {
    chatSessionId: string;
    artifactId: string;
  }): Promise<{ artifact: AnalysisArtifact; table: CanonicalTableV1 }> {
    const artifact = await this.repositories.getAnalysisArtifact(input);
    if (
      !artifact ||
      artifact.kind !== "table" ||
      !artifact.azureBlobName ||
      !artifact.azureETag ||
      artifact.rowCount === null ||
      !artifact.columns
    ) {
      throw new Error("Artifact not found.");
    }
    return {
      artifact,
      table: await this.downloadCanonicalTable({
        name: artifact.azureBlobName,
        etag: artifact.azureETag,
        expected: {
          contentSha256: artifact.contentSha256,
          byteSize: artifact.byteSize,
          rowCount: artifact.rowCount,
          columns: artifact.columns,
        },
      }),
    };
  }

  async cleanupRetainedArtifacts(limit = 100): Promise<number> {
    const due = await this.repositories.listAnalysisArtifactsDueForCleanup({
      limit,
    });
    let completed = 0;
    for (const artifact of due) {
      if (artifact.azureBlobName && artifact.azureETag) {
        try {
          await this.container()
            .getBlobClient(artifact.azureBlobName)
            .delete({
              deleteSnapshots: "include",
              conditions: { ifMatch: artifact.azureETag },
            });
        } catch (error) {
          // A later orphan pass releases exact stale committed leases. Keep
          // scanning so this item cannot starve retained or orphan cleanup.
          if (isAzureStatus(error, 409, 412)) continue;
          if (!isAzureStatus(error, 404)) throw error;
        }
      }
      if (
        await this.repositories.markAnalysisArtifactCleanupCompleted({
          artifactId: artifact.id,
        })
      ) {
        completed += 1;
      }
    }
    return completed;
  }

  async cleanupOrphanUploads(
    input: {
      olderThan?: Date;
      limit?: number;
      staleFinalizationBefore?: Date;
    } = {},
  ): Promise<number> {
    const olderThan =
      input.olderThan ?? new Date(Date.now() - 24 * 60 * 60_000);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .parse(input.limit);
    const staleFinalizationBefore =
      input.staleFinalizationBefore ??
      new Date(Date.now() - STALE_FINALIZATION_MS);
    let deleted = 0;
    const pages = this.container()
      .listBlobsFlat({ prefix: "artifacts/" })
      .byPage({
        continuationToken: this.orphanCleanupContinuationToken,
        maxPageSize: Math.min(limit, 100),
      });
    const page = await pages[Symbol.asyncIterator]().next();
    if (page.done) {
      this.orphanCleanupContinuationToken = undefined;
      return deleted;
    }
    this.orphanCleanupContinuationToken =
      page.value.continuationToken || undefined;
    for (const listed of page.value.segment.blobItems.slice(0, limit)) {
      if (
        !listed.properties.lastModified ||
        listed.properties.lastModified >= olderThan
      ) {
        continue;
      }
      const blob = this.container().getBlobClient(listed.name);
      let lease = new RenewingBlobLease(blob.getBlobLeaseClient());
      let deletedBlob = false;
      let staleLeaseETag: string | undefined;
      let recoveredStaleLease = false;
      try {
        await lease.acquire();
      } catch (error) {
        if (!isAzureStatus(error, 409, 412)) throw error;
        let properties;
        try {
          properties = await blob.getProperties();
        } catch (propertiesError) {
          if (isAzureStatus(propertiesError, 404)) continue;
          throw propertiesError;
        }
        if (
          !hasStaleInfiniteFinalizationLease(
            properties,
            staleFinalizationBefore,
          ) ||
          properties.etag === undefined
        ) {
          continue;
        }
        staleLeaseETag = properties.etag;
        const artifactId = artifactIdFromBlobName(listed.name);
        const exactCommittedBinding =
          artifactId !== null &&
          (await this.repositories.analysisArtifactBlobBindingExists({
            artifactId,
            azureBlobName: listed.name,
            azureETag: staleLeaseETag,
          }));
        if (
          !exactCommittedBinding &&
          (await this.repositories.analysisArtifactBlobExists(listed.name))
        ) {
          continue;
        }
        try {
          await blob.getBlobLeaseClient().breakLease(0, {
            conditions: { ifMatch: staleLeaseETag },
          });
        } catch (breakError) {
          if (isAzureStatus(breakError, 409, 412)) continue;
          throw breakError;
        }
        lease = new RenewingBlobLease(blob.getBlobLeaseClient());
        try {
          await lease.acquire();
          recoveredStaleLease = true;
        } catch (reacquireError) {
          if (isAzureStatus(reacquireError, 409, 412)) continue;
          throw reacquireError;
        }
      }
      try {
        const properties = await blob.getProperties({
          conditions: {
            leaseId: lease.leaseId,
            ...(staleLeaseETag ? { ifMatch: staleLeaseETag } : {}),
          },
        });
        if (hasRecentFinalizationMarker(properties, staleFinalizationBefore)) {
          continue;
        }
        if (recoveredStaleLease) {
          const artifactId = artifactIdFromBlobName(listed.name);
          const exactCommittedBinding =
            artifactId !== null &&
            properties.etag !== undefined &&
            (await this.repositories.analysisArtifactBlobBindingExists({
              artifactId,
              azureBlobName: listed.name,
              azureETag: properties.etag,
            }));
          // Releasing the cleanup lease in finally restores ordinary reads;
          // committed bytes are retained until the next retention pass.
          if (exactCommittedBinding) continue;
          if (await this.repositories.analysisArtifactBlobExists(listed.name))
            continue;
        } else if (
          await this.repositories.analysisArtifactBlobExists(listed.name)
        ) {
          continue;
        }
        await lease.renewNow();
        await blob.delete({
          deleteSnapshots: "include",
          conditions: { leaseId: lease.leaseId },
        });
        deletedBlob = true;
        lease.completeAfterDelete();
        deleted += 1;
      } finally {
        if (!deletedBlob) await lease.release();
      }
    }
    return deleted;
  }
}

export const artifactLimits = {
  maxRows: MAX_ARTIFACT_ROWS,
  maxColumns: MAX_ARTIFACT_COLUMNS,
  maxBytes: MAX_ARTIFACT_BYTES,
  maxStringCellBytes: MAX_ARTIFACT_STRING_BYTES,
} as const;
