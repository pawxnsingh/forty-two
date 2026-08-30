import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import { AnalysisArtifactIdSchema } from "../../ids.js";
import { analysisArtifacts } from "../../schema/analysis-artifacts.js";
import { parseAnalysisArtifact } from "./shared.js";

export async function listAnalysisArtifactsDueForCleanup(input: {
  now?: Date;
  limit?: number;
}) {
  const parsed = z
    .object({
      now: z.date().default(() => new Date()),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .parse(input);
  const rows = await getDatabase()
    .select()
    .from(analysisArtifacts)
    .where(
      and(
        eq(analysisArtifacts.status, "deleted"),
        lte(analysisArtifacts.retentionExpiresAt, parsed.now),
        isNull(analysisArtifacts.cleanupCompletedAt),
      ),
    )
    .limit(parsed.limit);
  return rows.map(parseAnalysisArtifact);
}

export async function markAnalysisArtifactCleanupCompleted(input: {
  artifactId: string;
  completedAt?: Date;
}): Promise<boolean> {
  const parsed = z
    .object({
      artifactId: AnalysisArtifactIdSchema,
      completedAt: z.date().default(() => new Date()),
    })
    .parse(input);
  const rows = await getDatabase()
    .update(analysisArtifacts)
    .set({ cleanupCompletedAt: parsed.completedAt })
    .where(
      and(
        eq(analysisArtifacts.id, parsed.artifactId),
        eq(analysisArtifacts.status, "deleted"),
        isNull(analysisArtifacts.cleanupCompletedAt),
      ),
    )
    .returning({ id: analysisArtifacts.id });
  return rows.length === 1;
}

export async function analysisArtifactBlobExists(
  azureBlobName: string,
): Promise<boolean> {
  const parsed = z.string().min(1).max(1_024).parse(azureBlobName);
  const rows = await getDatabase()
    .select({ id: analysisArtifacts.id })
    .from(analysisArtifacts)
    .where(eq(analysisArtifacts.azureBlobName, parsed))
    .limit(1);
  return rows.length === 1;
}

export async function analysisArtifactBlobBindingExists(input: {
  artifactId: string;
  azureBlobName: string;
  azureETag: string;
}): Promise<boolean> {
  const parsed = z
    .object({
      artifactId: AnalysisArtifactIdSchema,
      azureBlobName: z.string().min(1).max(1_024),
      azureETag: z.string().min(1).max(1_024),
    })
    .parse(input);
  const rows = await getDatabase()
    .select({ id: analysisArtifacts.id })
    .from(analysisArtifacts)
    .where(
      and(
        eq(analysisArtifacts.id, parsed.artifactId),
        eq(analysisArtifacts.azureBlobName, parsed.azureBlobName),
        eq(analysisArtifacts.azureETag, parsed.azureETag),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

export async function markAnalysisArtifactLeaseLost(input: {
  artifactId: string;
  azureBlobName: string;
  azureETag: string;
}): Promise<boolean> {
  const parsed = z
    .object({
      artifactId: AnalysisArtifactIdSchema,
      azureBlobName: z.string().min(1).max(1_024),
      azureETag: z.string().min(1).max(1_024),
    })
    .parse(input);
  const rows = await getDatabase()
    .update(analysisArtifacts)
    .set({
      status: "deleted",
      deletedAt: sql`CURRENT_TIMESTAMP`,
      retentionExpiresAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(analysisArtifacts.id, parsed.artifactId),
        eq(analysisArtifacts.azureBlobName, parsed.azureBlobName),
        eq(analysisArtifacts.azureETag, parsed.azureETag),
        eq(analysisArtifacts.status, "ready"),
        isNull(analysisArtifacts.deletedAt),
      ),
    )
    .returning({ id: analysisArtifacts.id });
  return rows.length === 1;
}

export async function softDeleteSessionAnalysisArtifacts(input: {
  chatSessionId: string;
  retentionDays?: number;
}): Promise<number> {
  const parsed = z
    .object({
      chatSessionId: z.string(),
      retentionDays: z.number().int().min(1).max(30).default(7),
    })
    .parse(input);
  const rows = await getDatabase()
    .update(analysisArtifacts)
    .set({
      status: "deleted",
      deletedAt: sql`CURRENT_TIMESTAMP`,
      retentionExpiresAt: sql`CURRENT_TIMESTAMP + (${parsed.retentionDays} * interval '1 day')`,
    })
    .where(
      and(
        eq(analysisArtifacts.chatSessionId, parsed.chatSessionId),
        eq(analysisArtifacts.status, "ready"),
        isNull(analysisArtifacts.deletedAt),
      ),
    )
    .returning({ id: analysisArtifacts.id });
  return rows.length;
}
