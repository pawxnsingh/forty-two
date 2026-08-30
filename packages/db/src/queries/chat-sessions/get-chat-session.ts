import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { ChatSession } from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema } from "../../ids.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import { parseChatSession } from "./shared.js";

export const GetChatSessionInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
});

export type GetChatSessionInput = z.input<typeof GetChatSessionInputSchema>;

export async function getChatSession(
  input: GetChatSessionInput,
): Promise<ChatSession | null> {
  const parsed = GetChatSessionInputSchema.parse(input);
  const rows = await getDatabase()
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        isNull(chatSessions.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ? parseChatSession(rows[0]) : null;
}
