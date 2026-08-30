import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import { DataSourceIdSchema } from "../../ids.js";
import { dataSources } from "../../schema/index.js";
import {
  DataSourceBlobCleanupStatusSchema,
  type DataSource,
} from "../../types.js";
import { parseDataSource } from "./shared.js";

const BlobNameSchema = z.string().trim().min(1).max(2048);
const ETagSchema = z.string().trim().min(1).max(1024);
const ErrorCodeSchema = z.string().trim().min(1).max(255);
const CleanupBatchSizeSchema = z.number().int().min(1).max(100);

export type PendingDataSourceBlobCleanup = {
  dataSourceId: string;
  azureBlobName: string;
  azureCleanupETag: string | null;
};

export type DataSourceBlobCleanupWorkerResult = {
  outcome: "pending" | "deleted" | "missing" | "superseded";
  azureETag: string | null;
  errorCode?: string | null;
};

export type DataSourceBlobCleanupSweepSummary = {
  selected: number;
  processed: number;
  skippedLockedOrChanged: number;
  pendingRemaining: number;
  outcomes: Record<DataSourceBlobCleanupWorkerResult["outcome"], number>;
};

export async function beginDataSourceDeletion(input: {
  dataSourceId: string;
}): Promise<DataSource | null> {
  const parsed = z.object({ dataSourceId: DataSourceIdSchema }).parse(input);

  return getDatabase().transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(dataSources)
      .where(eq(dataSources.id, parsed.dataSourceId))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return null;
    if (row.status === "deleted") return parseDataSource(row);

    const now = new Date();
    const isFile = row.connectorType === "csv" || row.connectorType === "xlsx";
    const updated = await transaction
      .update(dataSources)
      .set({
        status: "deleted",
        deletedAt: now,
        updatedAt: now,
        processingMessage: null,
        azureCleanupStatus: isFile ? "pending" : null,
        azureCleanupETag: isFile ? row.azureETag : null,
        azureCleanupAttempts: 0,
        azureCleanupCompletedAt: null,
        azureCleanupErrorCode: null,
      })
      .where(eq(dataSources.id, parsed.dataSourceId))
      .returning();

    return updated[0] ? parseDataSource(updated[0]) : null;
  });
}

export async function pinDataSourceBlobCleanupETag(input: {
  dataSourceId: string;
  azureBlobName: string;
  azureETag: string;
}): Promise<DataSource | null> {
  const parsed = z
    .object({
      dataSourceId: DataSourceIdSchema,
      azureBlobName: BlobNameSchema,
      azureETag: ETagSchema,
    })
    .parse(input);
  const rows = await getDatabase()
    .update(dataSources)
    .set({
      azureCleanupETag: parsed.azureETag,
      azureCleanupErrorCode: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dataSources.id, parsed.dataSourceId),
        eq(dataSources.status, "deleted"),
        eq(dataSources.azureCleanupStatus, "pending"),
        eq(dataSources.azureBlobName, parsed.azureBlobName),
        isNull(dataSources.azureCleanupETag),
      ),
    )
    .returning();
  return rows[0] ? parseDataSource(rows[0]) : null;
}

const RecordDataSourceBlobCleanupAttemptInputSchema = z
  .object({
    dataSourceId: DataSourceIdSchema,
    azureBlobName: BlobNameSchema,
    expectedAzureETag: ETagSchema.nullable(),
    outcome: DataSourceBlobCleanupStatusSchema,
    errorCode: ErrorCodeSchema.nullable().optional().default(null),
  })
  .superRefine((value, context) => {
    if (value.outcome === "pending" && value.errorCode === null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "A pending cleanup attempt requires an error code.",
      });
    }
    if (value.outcome !== "pending" && value.errorCode !== null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "A terminal cleanup attempt cannot retain an error code.",
      });
    }
    if (
      (value.outcome === "deleted" || value.outcome === "superseded") &&
      value.expectedAzureETag === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedAzureETag"],
        message: `${value.outcome} cleanup requires a pinned ETag.`,
      });
    }
  });

export async function recordDataSourceBlobCleanupAttempt(input: {
  dataSourceId: string;
  azureBlobName: string;
  expectedAzureETag: string | null;
  outcome: "pending" | "deleted" | "missing" | "superseded";
  errorCode?: string | null;
}): Promise<DataSource | null> {
  const parsed = RecordDataSourceBlobCleanupAttemptInputSchema.parse(input);
  const terminal = parsed.outcome !== "pending";
  const rows = await getDatabase()
    .update(dataSources)
    .set({
      azureCleanupStatus: parsed.outcome,
      azureCleanupAttempts: sql`${dataSources.azureCleanupAttempts} + 1`,
      azureCleanupCompletedAt: terminal ? new Date() : null,
      azureCleanupErrorCode: parsed.errorCode,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dataSources.id, parsed.dataSourceId),
        eq(dataSources.status, "deleted"),
        eq(dataSources.azureCleanupStatus, "pending"),
        eq(dataSources.azureBlobName, parsed.azureBlobName),
        parsed.expectedAzureETag === null
          ? isNull(dataSources.azureCleanupETag)
          : eq(dataSources.azureCleanupETag, parsed.expectedAzureETag),
      ),
    )
    .returning();
  return rows[0] ? parseDataSource(rows[0]) : null;
}

const CleanupWorkerResultSchema = z
  .object({
    outcome: DataSourceBlobCleanupStatusSchema,
    azureETag: ETagSchema.nullable(),
    errorCode: ErrorCodeSchema.nullable().optional().default(null),
  })
  .superRefine((value, context) => {
    if (value.outcome === "pending" && value.errorCode === null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "A pending cleanup attempt requires an error code.",
      });
    }
    if (value.outcome !== "pending" && value.errorCode !== null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "A terminal cleanup attempt cannot retain an error code.",
      });
    }
    if (
      (value.outcome === "deleted" || value.outcome === "superseded") &&
      value.azureETag === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["azureETag"],
        message: `${value.outcome} cleanup requires a pinned ETag.`,
      });
    }
  });

/**
 * Claims pending rows with PostgreSQL row locks and runs exactly one worker
 * attempt for each claimed row. The lock is held until the attempt result and
 * its accounting are committed, so concurrent sweepers cannot mutate the same
 * blob generation. If the process exits mid-attempt, the transaction rolls
 * back and a later pass safely retries the still-pending row.
 */
export async function sweepPendingDataSourceBlobCleanups(input: {
  limit: number;
  dataSourceIds?: string[];
  worker: (
    cleanup: PendingDataSourceBlobCleanup,
  ) => Promise<DataSourceBlobCleanupWorkerResult>;
}): Promise<DataSourceBlobCleanupSweepSummary> {
  const limit = CleanupBatchSizeSchema.parse(input.limit);
  const dataSourceIds = input.dataSourceIds
    ? z.array(DataSourceIdSchema).min(1).max(100).parse(input.dataSourceIds)
    : undefined;
  const candidateRows = await getDatabase()
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.status, "deleted"),
        eq(dataSources.azureCleanupStatus, "pending"),
        dataSourceIds ? inArray(dataSources.id, dataSourceIds) : undefined,
      ),
    )
    .orderBy(asc(dataSources.deletedAt), asc(dataSources.id))
    .limit(limit);
  const outcomes: DataSourceBlobCleanupSweepSummary["outcomes"] = {
    pending: 0,
    deleted: 0,
    missing: 0,
    superseded: 0,
  };
  let processed = 0;

  for (const candidate of candidateRows) {
    const outcome = await getDatabase().transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(dataSources)
        .where(
          and(
            eq(dataSources.id, candidate.id),
            eq(dataSources.status, "deleted"),
            eq(dataSources.azureCleanupStatus, "pending"),
          ),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      const row = rows[0];
      if (!row) return null;
      const dataSource = parseDataSource(row);
      if (
        (dataSource.connectorType !== "csv" &&
          dataSource.connectorType !== "xlsx") ||
        !dataSource.azureBlobName
      ) {
        throw new Error(
          `Pending Azure cleanup row ${dataSource.id} has invalid file metadata.`,
        );
      }

      const result = CleanupWorkerResultSchema.parse(
        await input.worker({
          dataSourceId: dataSource.id,
          azureBlobName: dataSource.azureBlobName,
          azureCleanupETag: dataSource.azureCleanupETag,
        }),
      );
      if (
        dataSource.azureCleanupETag !== null &&
        result.azureETag !== dataSource.azureCleanupETag
      ) {
        throw new Error(
          `Pending Azure cleanup row ${dataSource.id} cannot change its pinned ETag.`,
        );
      }
      const terminal = result.outcome !== "pending";
      const updated = await transaction
        .update(dataSources)
        .set({
          azureCleanupStatus: result.outcome,
          azureCleanupETag: result.azureETag,
          azureCleanupAttempts: sql`${dataSources.azureCleanupAttempts} + 1`,
          azureCleanupCompletedAt: terminal ? new Date() : null,
          azureCleanupErrorCode: result.errorCode,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dataSources.id, dataSource.id),
            eq(dataSources.status, "deleted"),
            eq(dataSources.azureCleanupStatus, "pending"),
          ),
        )
        .returning({ outcome: dataSources.azureCleanupStatus });
      if (!updated[0]) {
        throw new Error(
          `Pending Azure cleanup row ${dataSource.id} changed while locked.`,
        );
      }
      return result.outcome;
    });
    if (outcome) {
      processed += 1;
      outcomes[outcome] += 1;
    }
  }

  const pendingRows = await getDatabase()
    .select({ count: sql<number>`count(*)::int` })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.status, "deleted"),
        eq(dataSources.azureCleanupStatus, "pending"),
        dataSourceIds ? inArray(dataSources.id, dataSourceIds) : undefined,
      ),
    );
  return {
    selected: candidateRows.length,
    processed,
    skippedLockedOrChanged: candidateRows.length - processed,
    pendingRemaining: pendingRows[0]?.count ?? 0,
    outcomes,
  };
}
