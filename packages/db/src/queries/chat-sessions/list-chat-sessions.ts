import { and, desc, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  ChatSessionStatusSchema,
  type ChatSession,
} from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import { parseChatSession } from "./shared.js";

export const ListChatSessionsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(25),
  offset: z.number().int().nonnegative().optional().default(0),
  statuses: z.array(ChatSessionStatusSchema).max(4).optional(),
});

export type ListChatSessionsInput = z.input<typeof ListChatSessionsInputSchema>;

export async function listChatSessions(
  input: ListChatSessionsInput = {},
): Promise<ChatSession[]> {
  const parsed = ListChatSessionsInputSchema.parse(input);
  const rows = await getDatabase()
    .select()
    .from(chatSessions)
    .where(
      and(
        isNull(chatSessions.deletedAt),
        parsed.statuses
          ? inArray(chatSessions.status, parsed.statuses)
          : undefined,
      ),
    )
    .orderBy(desc(chatSessions.createdAt), desc(chatSessions.id))
    .limit(parsed.limit)
    .offset(parsed.offset);
  return rows.map(parseChatSession);
}
