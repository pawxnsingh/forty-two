import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { ChatSession } from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema } from "../../ids.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import { parseChatSession } from "./shared.js";

export const ActivateChatSessionInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  trueforgeSessionId: z.string().trim().min(1).max(255),
});

export type ActivateChatSessionInput = z.input<
  typeof ActivateChatSessionInputSchema
>;

export async function activateChatSession(
  input: ActivateChatSessionInput,
): Promise<ChatSession | null> {
  const parsed = ActivateChatSessionInputSchema.parse(input);
  const rows = await getDatabase()
    .update(chatSessions)
    .set({
      status: "active",
      trueforgeSessionId: parsed.trueforgeSessionId,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.status, "creating"),
        isNull(chatSessions.deletedAt),
      ),
    )
    .returning();

  return rows[0] ? parseChatSession(rows[0]) : null;
}

export const FailChatSessionInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  failureMessage: z.string().trim().min(1).max(4000),
});

export type FailChatSessionInput = z.input<typeof FailChatSessionInputSchema>;

export async function failChatSession(
  input: FailChatSessionInput,
): Promise<ChatSession | null> {
  const parsed = FailChatSessionInputSchema.parse(input);
  const rows = await getDatabase()
    .update(chatSessions)
    .set({
      status: "failed",
      failureMessage: parsed.failureMessage,
      capabilityRevokedAt: sql`coalesce(${chatSessions.capabilityRevokedAt}, CURRENT_TIMESTAMP)`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.status, "creating"),
        isNull(chatSessions.deletedAt),
      ),
    )
    .returning();

  return rows[0] ? parseChatSession(rows[0]) : null;
}
