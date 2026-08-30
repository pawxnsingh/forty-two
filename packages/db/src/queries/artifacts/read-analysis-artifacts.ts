import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
} from "drizzle-orm";
import { z } from "zod";

import {
  ArtifactKindSchema,
  type AnalysisArtifact,
} from "../../artifact-types.js";
import { getDatabase } from "../../database.js";
import {
  AnalysisArtifactIdSchema,
  ChatSessionIdSchema,
} from "../../ids.js";
import {
  analysisArtifactLineage,
  analysisArtifacts,
} from "../../schema/analysis-artifacts.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import { parseAnalysisArtifact } from "./shared.js";

const PageTokenSchema = z
  .string()
  .transform((value, context) => {
    try {
      const decoded = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      ) as unknown;
      return z
        .object({ createdAt: z.string().datetime(), id: AnalysisArtifactIdSchema })
        .strict()
        .parse(decoded);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid artifact page token" });
      return z.NEVER;
    }
  });

export async function getAnalysisArtifact(input: {
  chatSessionId: string;
  artifactId: string;
}): Promise<AnalysisArtifact | null> {
  const parsed = z
    .object({
      chatSessionId: ChatSessionIdSchema,
      artifactId: AnalysisArtifactIdSchema,
    })
    .parse(input);
  const rows = await getDatabase()
    .select({ artifact: analysisArtifacts })
    .from(analysisArtifacts)
    .innerJoin(
      chatSessions,
      and(
        eq(chatSessions.id, analysisArtifacts.chatSessionId),
        eq(chatSessions.status, "active"),
        isNull(chatSessions.deletedAt),
      ),
    )
    .where(
      and(
        eq(analysisArtifacts.id, parsed.artifactId),
        eq(analysisArtifacts.chatSessionId, parsed.chatSessionId),
        eq(analysisArtifacts.status, "ready"),
        isNull(analysisArtifacts.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? parseAnalysisArtifact(rows[0].artifact) : null;
}

export async function listAnalysisArtifactParents(input: {
  chatSessionId: string;
  artifactId: string;
}): Promise<string[]> {
  const artifact = await getAnalysisArtifact(input);
  if (!artifact) return [];
  const rows = await getDatabase()
    .select({ id: analysisArtifactLineage.parentArtifactId })
    .from(analysisArtifactLineage)
    .where(
      and(
        eq(analysisArtifactLineage.chatSessionId, artifact.chatSessionId),
        eq(analysisArtifactLineage.artifactId, artifact.id),
      ),
    );
  return rows.map((row) => row.id).sort();
}

export async function listAnalysisArtifacts(input: {
  chatSessionId: string;
  kind?: "table" | "chart";
  limit?: number;
  pageToken?: string;
}): Promise<{ artifacts: AnalysisArtifact[]; nextPageToken: string | null }> {
  const parsed = z
    .object({
      chatSessionId: ChatSessionIdSchema,
      kind: ArtifactKindSchema.optional(),
      limit: z.number().int().min(1).max(100).default(25),
      pageToken: PageTokenSchema.optional(),
    })
    .parse(input);
  const cursor = parsed.pageToken;
  const rows = await getDatabase()
    .select({ artifact: analysisArtifacts })
    .from(analysisArtifacts)
    .innerJoin(
      chatSessions,
      and(
        eq(chatSessions.id, analysisArtifacts.chatSessionId),
        eq(chatSessions.status, "active"),
        isNull(chatSessions.deletedAt),
      ),
    )
    .where(
      and(
        eq(analysisArtifacts.chatSessionId, parsed.chatSessionId),
        eq(analysisArtifacts.status, "ready"),
        isNull(analysisArtifacts.deletedAt),
        parsed.kind ? eq(analysisArtifacts.kind, parsed.kind) : undefined,
        cursor
          ? or(
              lt(analysisArtifacts.createdAt, new Date(cursor.createdAt)),
              and(
                eq(analysisArtifacts.createdAt, new Date(cursor.createdAt)),
                lt(analysisArtifacts.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(analysisArtifacts.createdAt), desc(analysisArtifacts.id))
    .limit(parsed.limit + 1);
  const page = rows.slice(0, parsed.limit).map((row) =>
    parseAnalysisArtifact(row.artifact),
  );
  const last = page.at(-1);
  return {
    artifacts: page,
    nextPageToken:
      rows.length > parsed.limit && last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
            "utf8",
          ).toString("base64url")
        : null,
  };
}

export async function getReadyAnalysisArtifacts(input: {
  chatSessionId: string;
  artifactIds: string[];
}): Promise<AnalysisArtifact[]> {
  const parsed = z
    .object({
      chatSessionId: ChatSessionIdSchema,
      artifactIds: z.array(AnalysisArtifactIdSchema).max(50),
    })
    .parse(input);
  if (parsed.artifactIds.length === 0) return [];
  const rows = await getDatabase()
    .select()
    .from(analysisArtifacts)
    .where(
      and(
        eq(analysisArtifacts.chatSessionId, parsed.chatSessionId),
        inArray(analysisArtifacts.id, parsed.artifactIds),
        eq(analysisArtifacts.status, "ready"),
        isNull(analysisArtifacts.deletedAt),
      ),
    );
  return rows.map(parseAnalysisArtifact);
}
