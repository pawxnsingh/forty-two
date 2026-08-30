import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { ChatSession } from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema } from "../../ids.js";
import { analysisArtifacts } from "../../schema/analysis-artifacts.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import { parseChatSession } from "./shared.js";

export const SoftDeleteChatSessionInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
});

export type SoftDeleteChatSessionInput = z.input<
  typeof SoftDeleteChatSessionInputSchema
>;

export async function softDeleteChatSession(
  input: SoftDeleteChatSessionInput,
  hooks: { afterSessionLock?: () => Promise<void> } = {},
): Promise<ChatSession | null> {
  const parsed = SoftDeleteChatSessionInputSchema.parse(input);
  return getDatabase().transaction(async (transaction) => {
    // Artifact commits use the same transaction advisory lock. This preserves
    // commit/delete ordering without requiring the MCP role to UPDATE the
    // application-owned chat_sessions table merely to acquire a row lock.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`forty-two:chat-session:${parsed.chatSessionId}`}, 0))`,
    );
    const locked = await transaction
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, parsed.chatSessionId),
          isNull(chatSessions.deletedAt),
        ),
      )
      .limit(1);
    if (!locked[0]) return null;
    await hooks.afterSessionLock?.();
    const rows = await transaction
      .update(chatSessions)
      .set({
        status: "deleted",
        deletedAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
        capabilityRevokedAt: sql`coalesce(${chatSessions.capabilityRevokedAt}, CURRENT_TIMESTAMP)`,
      })
      .where(
        and(
          eq(chatSessions.id, parsed.chatSessionId),
          isNull(chatSessions.deletedAt),
        ),
      )
      .returning();

    if (!rows[0]) return null;
    await transaction
      .update(analysisArtifacts)
      .set({
        status: "deleted",
        deletedAt: sql`CURRENT_TIMESTAMP`,
        retentionExpiresAt: sql`CURRENT_TIMESTAMP + interval '7 days'`,
      })
      .where(
        and(
          eq(analysisArtifacts.chatSessionId, parsed.chatSessionId),
          eq(analysisArtifacts.status, "ready"),
          isNull(analysisArtifacts.deletedAt),
        ),
      );
    return parseChatSession(rows[0]);
  });
}
