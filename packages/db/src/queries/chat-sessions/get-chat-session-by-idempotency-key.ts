import { eq } from "drizzle-orm";
import { z } from "zod";

import type { ChatSession } from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import { parseChatSession } from "./shared.js";

export const GetChatSessionByIdempotencyKeyInputSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(255),
});

export type GetChatSessionByIdempotencyKeyInput = z.input<
  typeof GetChatSessionByIdempotencyKeyInputSchema
>;

export async function getChatSessionByIdempotencyKey(
  input: GetChatSessionByIdempotencyKeyInput,
): Promise<ChatSession | null> {
  const parsed = GetChatSessionByIdempotencyKeyInputSchema.parse(input);
  const rows = await getDatabase()
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.idempotencyKey, parsed.idempotencyKey))
    .limit(1);

  return rows[0] ? parseChatSession(rows[0]) : null;
}
