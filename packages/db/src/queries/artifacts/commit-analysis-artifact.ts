import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  ArtifactColumnsSchema,
  ArtifactContentSha256Schema,
  ArtifactPreviewSchema,
  ArtifactProvenanceSchema,
  type AnalysisArtifact,
} from "../../artifact-types.js";
import { getDatabase } from "../../database.js";
import { AnalysisArtifactIdSchema, ChatSessionIdSchema } from "../../ids.js";
import {
  analysisArtifactLineage,
  analysisArtifacts,
} from "../../schema/analysis-artifacts.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import {
  ArtifactCommitConflictError,
  parseAnalysisArtifact,
} from "./shared.js";

const CommonInputSchema = z.object({
  artifactId: AnalysisArtifactIdSchema,
  chatSessionId: ChatSessionIdSchema,
  title: z.string().trim().min(1).max(500).nullable().optional(),
  description: z.string().trim().min(1).max(2_000).nullable().optional(),
  contentSha256: ArtifactContentSha256Schema,
  byteSize: z.number().int().nonnegative().safe(),
  provenance: ArtifactProvenanceSchema,
  parentArtifactIds: z
    .array(AnalysisArtifactIdSchema)
    .max(50)
    .default([])
    .transform((ids) => [...new Set(ids)].sort()),
});

export const CommitTableArtifactInputSchema = CommonInputSchema.extend({
  azureBlobName: z.string().min(1).max(1_024),
  azureETag: z.string().min(1).max(1_024),
  rowCount: z.number().int().nonnegative().max(10_000),
  columns: ArtifactColumnsSchema,
  preview: ArtifactPreviewSchema,
  sourceLimited: z.boolean().default(false),
  sourceMaxRows: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .nullable()
    .default(null),
}).superRefine((value, context) => {
  if (value.sourceLimited !== (value.sourceMaxRows !== null)) {
    context.addIssue({
      code: "custom",
      path: ["sourceMaxRows"],
      message: "sourceMaxRows is required exactly when sourceLimited is true",
    });
  }
  if (value.preview.length > value.rowCount) {
    context.addIssue({
      code: "custom",
      path: ["preview"],
      message: "Preview cannot contain more rows than the table",
    });
  }
});

export const CommitChartArtifactInputSchema = CommonInputSchema.extend({
  chartConfig: z.record(z.string(), z.unknown()),
  inputArtifactId: AnalysisArtifactIdSchema,
});

export type CommitTableArtifactInput = z.input<
  typeof CommitTableArtifactInputSchema
>;
export type CommitChartArtifactInput = z.input<
  typeof CommitChartArtifactInputSchema
>;

async function assertActiveSessionAndParents(
  transaction: Parameters<
    Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
  >[0],
  chatSessionId: string,
  artifactId: string,
  parentArtifactIds: readonly string[],
): Promise<void> {
  // The MCP control role intentionally has column-level SELECT, not UPDATE, on
  // chat_sessions. A transaction advisory lock gives commit and deletion the
  // same serialization point without widening that role's table privileges.
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`forty-two:chat-session:${chatSessionId}`}, 0))`,
  );
  const sessions = await transaction
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, chatSessionId),
        eq(chatSessions.status, "active"),
        isNull(chatSessions.deletedAt),
      ),
    )
    .limit(1);
  if (!sessions[0]) throw new Error("Application session is not active.");
  if (parentArtifactIds.includes(artifactId)) {
    throw new Error("An artifact cannot be its own parent.");
  }
  if (parentArtifactIds.length === 0) return;

  const parents = await transaction
    .select({ id: analysisArtifacts.id })
    .from(analysisArtifacts)
    .where(
      and(
        eq(analysisArtifacts.chatSessionId, chatSessionId),
        inArray(analysisArtifacts.id, [...parentArtifactIds]),
        eq(analysisArtifacts.status, "ready"),
        isNull(analysisArtifacts.deletedAt),
      ),
    );
  if (parents.length !== parentArtifactIds.length) {
    throw new Error("One or more parent artifacts are unavailable.");
  }
}

async function insertOrReturnMatching(
  transaction: Parameters<
    Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
  >[0],
  values: typeof analysisArtifacts.$inferInsert,
  parentArtifactIds: readonly string[],
): Promise<AnalysisArtifact> {
  const inserted = await transaction
    .insert(analysisArtifacts)
    .values(values)
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    if (parentArtifactIds.length > 0) {
      await transaction.insert(analysisArtifactLineage).values(
        parentArtifactIds.map((parentArtifactId) => ({
          chatSessionId: values.chatSessionId,
          artifactId: values.id,
          parentArtifactId,
        })),
      );
    }
    return parseAnalysisArtifact(inserted[0]);
  }

  const existing = await transaction
    .select()
    .from(analysisArtifacts)
    .where(
      and(
        eq(analysisArtifacts.chatSessionId, values.chatSessionId),
        eq(analysisArtifacts.kind, values.kind),
        sql`(
          ${analysisArtifacts.id} = ${values.id}
          OR ${analysisArtifacts.provenance}->>'operationKey' = ${values.provenance.operationKey}
        )`,
      ),
    )
    .limit(1);
  const row = existing[0];
  const retryProvenance = values.provenance;
  if (
    !row ||
    row.id !== values.id ||
    row.contentSha256 !== values.contentSha256 ||
    row.schemaVersion !== values.schemaVersion ||
    row.byteSize !== values.byteSize ||
    row.title !== (values.title ?? null) ||
    row.description !== (values.description ?? null) ||
    row.azureBlobName !== (values.azureBlobName ?? null) ||
    row.azureETag !== (values.azureETag ?? null) ||
    row.rowCount !== (values.rowCount ?? null) ||
    row.columnCount !== (values.columnCount ?? null) ||
    row.sourceLimited !== (values.sourceLimited ?? false) ||
    row.sourceMaxRows !== (values.sourceMaxRows ?? null) ||
    JSON.stringify(row.columns) !== JSON.stringify(values.columns ?? null) ||
    JSON.stringify(row.preview) !== JSON.stringify(values.preview ?? null) ||
    JSON.stringify(row.chartConfig) !==
      JSON.stringify(values.chartConfig ?? null) ||
    row.provenance.operationKey !== retryProvenance.operationKey ||
    row.provenance.tool !== retryProvenance.tool ||
    row.provenance.sqlSha256 !== retryProvenance.sqlSha256 ||
    JSON.stringify(row.provenance.dataSourceIds) !==
      JSON.stringify(retryProvenance.dataSourceIds) ||
    JSON.stringify(row.provenance.sourceReferences) !==
      JSON.stringify(retryProvenance.sourceReferences)
  ) {
    throw new ArtifactCommitConflictError();
  }

  const lineage = await transaction
    .select({ parentArtifactId: analysisArtifactLineage.parentArtifactId })
    .from(analysisArtifactLineage)
    .where(eq(analysisArtifactLineage.artifactId, row.id));
  const existingParents = lineage.map((entry) => entry.parentArtifactId).sort();
  if (
    JSON.stringify(existingParents) !==
    JSON.stringify([...parentArtifactIds].sort())
  ) {
    throw new ArtifactCommitConflictError(
      "Artifact retry changed its lineage.",
    );
  }
  return parseAnalysisArtifact(row);
}

export async function commitTableArtifact(
  input: CommitTableArtifactInput,
  hooks: {
    afterSessionLock?: () => Promise<void>;
    beforeTransactionCommit?: () => Promise<void>;
  } = {},
): Promise<AnalysisArtifact> {
  const parsed = CommitTableArtifactInputSchema.parse(input);
  return getDatabase().transaction(async (transaction) => {
    await assertActiveSessionAndParents(
      transaction,
      parsed.chatSessionId,
      parsed.artifactId,
      parsed.parentArtifactIds,
    );
    await hooks.afterSessionLock?.();
    const artifact = await insertOrReturnMatching(
      transaction,
      {
        id: parsed.artifactId,
        chatSessionId: parsed.chatSessionId,
        kind: "table",
        schemaVersion: "table.v1",
        title: parsed.title ?? null,
        description: parsed.description ?? null,
        azureBlobName: parsed.azureBlobName,
        azureETag: parsed.azureETag,
        contentSha256: parsed.contentSha256,
        byteSize: parsed.byteSize,
        rowCount: parsed.rowCount,
        columnCount: parsed.columns.length,
        columns: parsed.columns,
        preview: parsed.preview,
        sourceLimited: parsed.sourceLimited,
        sourceMaxRows: parsed.sourceMaxRows,
        chartConfig: null,
        provenance: parsed.provenance,
      },
      parsed.parentArtifactIds,
    );
    // External resource owners can revalidate their lock after all possibly
    // blocking SQL work. Throwing here rolls back the artifact write before
    // PostgreSQL commits it.
    await hooks.beforeTransactionCommit?.();
    return artifact;
  });
}

export async function commitChartArtifact(
  input: CommitChartArtifactInput,
  hooks: { afterSessionLock?: () => Promise<void> } = {},
): Promise<AnalysisArtifact> {
  const parsed = CommitChartArtifactInputSchema.parse(input);
  const parentArtifactIds = [
    ...new Set([...parsed.parentArtifactIds, parsed.inputArtifactId]),
  ].sort();
  return getDatabase().transaction(async (transaction) => {
    await assertActiveSessionAndParents(
      transaction,
      parsed.chatSessionId,
      parsed.artifactId,
      parentArtifactIds,
    );
    await hooks.afterSessionLock?.();
    return insertOrReturnMatching(
      transaction,
      {
        id: parsed.artifactId,
        chatSessionId: parsed.chatSessionId,
        kind: "chart",
        schemaVersion: "chart.v1",
        title: parsed.title ?? null,
        description: parsed.description ?? null,
        contentSha256: parsed.contentSha256,
        byteSize: parsed.byteSize,
        chartConfig: parsed.chartConfig,
        provenance: parsed.provenance,
      },
      parentArtifactIds,
    );
  });
}
