import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { ChatSession } from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema } from "../../ids.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import { parseChatSession } from "./shared.js";

export const GetChatSessionForCleanupInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
});

export type GetChatSessionForCleanupInput = z.input<
  typeof GetChatSessionForCleanupInputSchema
>;

export async function getChatSessionForCleanup(
  input: GetChatSessionForCleanupInput,
): Promise<ChatSession | null> {
  const parsed = GetChatSessionForCleanupInputSchema.parse(input);
  const rows = await getDatabase()
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        inArray(chatSessions.status, ["active", "deleted"]),
      ),
    )
    .limit(1);

  return rows[0] ? parseChatSession(rows[0]) : null;
}
