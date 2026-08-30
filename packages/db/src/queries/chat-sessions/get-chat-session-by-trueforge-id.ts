import { eq } from "drizzle-orm";
import { z } from "zod";

import type { ChatSession } from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import { parseChatSession } from "./shared.js";

export const GetChatSessionByTrueforgeIdInputSchema = z.object({
  trueforgeSessionId: z.string().trim().min(1).max(255),
});

export type GetChatSessionByTrueforgeIdInput = z.input<
  typeof GetChatSessionByTrueforgeIdInputSchema
>;

export async function getChatSessionByTrueforgeId(
  input: GetChatSessionByTrueforgeIdInput,
): Promise<ChatSession | null> {
  const parsed = GetChatSessionByTrueforgeIdInputSchema.parse(input);
  const rows = await getDatabase()
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.trueforgeSessionId, parsed.trueforgeSessionId))
    .limit(1);

  return rows[0] ? parseChatSession(rows[0]) : null;
}
