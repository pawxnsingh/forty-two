import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema } from "../../ids.js";
import {
  chatSessions,
  chatTurnRequests,
  type ChatTurnRequestRow,
} from "../../schema/chat-sessions.js";

const TurnRequestIdentitySchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  idempotencyKey: z.string().trim().min(1).max(255),
});

const ReserveChatTurnRequestInputSchema = TurnRequestIdentitySchema.extend({
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const CompleteChatTurnRequestInputSchema =
  ReserveChatTurnRequestInputSchema.extend({
    trueforgeTurnId: z.string().trim().min(1).max(192),
  });

export type ChatTurnRequest = ChatTurnRequestRow;

export interface ReserveChatTurnRequestResult {
  request: ChatTurnRequest;
  reserved: boolean;
}

export class ChatTurnRequestConflictError extends Error {
  constructor() {
    super("The idempotency key was already used for a different turn request.");
    this.name = "ChatTurnRequestConflictError";
  }
}

export class ChatTurnRequestUnavailableError extends Error {
  constructor() {
    super("The chat session is not active or is unavailable.");
    this.name = "ChatTurnRequestUnavailableError";
  }
}

export async function reserveChatTurnRequest(
  input: z.input<typeof ReserveChatTurnRequestInputSchema>,
): Promise<ReserveChatTurnRequestResult> {
  const parsed = ReserveChatTurnRequestInputSchema.parse(input);
  return getDatabase().transaction(async (transaction) => {
    const sessions = await transaction
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.id, parsed.chatSessionId))
      .for("update")
      .limit(1);
    if (!sessions[0]) throw new ChatTurnRequestUnavailableError();

    const active = await transaction
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, parsed.chatSessionId),
          eq(chatSessions.status, "active"),
          isNull(chatSessions.deletedAt),
        ),
      )
      .limit(1);
    if (!active[0]) throw new ChatTurnRequestUnavailableError();

    const inserted = await transaction
      .insert(chatTurnRequests)
      .values({
        chatSessionId: parsed.chatSessionId,
        idempotencyKey: parsed.idempotencyKey,
        requestHash: parsed.requestHash,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { request: inserted[0], reserved: true };

    const existing = await transaction
      .select()
      .from(chatTurnRequests)
      .where(
        and(
          eq(chatTurnRequests.chatSessionId, parsed.chatSessionId),
          eq(chatTurnRequests.idempotencyKey, parsed.idempotencyKey),
        ),
      )
      .limit(1);
    const request = existing[0];
    if (!request) {
      throw new Error("Turn request reservation was not readable.");
    }
    if (request.requestHash !== parsed.requestHash) {
      throw new ChatTurnRequestConflictError();
    }
    return { request, reserved: false };
  });
}

export async function getChatTurnRequest(
  input: z.input<typeof TurnRequestIdentitySchema>,
): Promise<ChatTurnRequest | null> {
  const parsed = TurnRequestIdentitySchema.parse(input);
  const rows = await getDatabase()
    .select()
    .from(chatTurnRequests)
    .where(
      and(
        eq(chatTurnRequests.chatSessionId, parsed.chatSessionId),
        eq(chatTurnRequests.idempotencyKey, parsed.idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function completeChatTurnRequest(
  input: z.input<typeof CompleteChatTurnRequestInputSchema>,
): Promise<ChatTurnRequest> {
  const parsed = CompleteChatTurnRequestInputSchema.parse(input);
  const rows = await getDatabase()
    .update(chatTurnRequests)
    .set({
      state: "created",
      trueforgeTurnId: parsed.trueforgeTurnId,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(chatTurnRequests.chatSessionId, parsed.chatSessionId),
        eq(chatTurnRequests.idempotencyKey, parsed.idempotencyKey),
        eq(chatTurnRequests.requestHash, parsed.requestHash),
        eq(chatTurnRequests.state, "creating"),
      ),
    )
    .returning();
  const completed = rows[0];
  if (completed) return completed;

  const existing = await getChatTurnRequest(parsed);
  if (
    existing?.state === "created" &&
    existing.requestHash === parsed.requestHash &&
    existing.trueforgeTurnId === parsed.trueforgeTurnId
  ) {
    return existing;
  }
  throw new Error("Turn request could not be completed from creating state.");
}

export async function markChatTurnRequestIndeterminate(
  input: z.input<typeof ReserveChatTurnRequestInputSchema>,
): Promise<ChatTurnRequest> {
  const parsed = ReserveChatTurnRequestInputSchema.parse(input);
  const rows = await getDatabase()
    .update(chatTurnRequests)
    .set({ state: "indeterminate", updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(chatTurnRequests.chatSessionId, parsed.chatSessionId),
        eq(chatTurnRequests.idempotencyKey, parsed.idempotencyKey),
        eq(chatTurnRequests.requestHash, parsed.requestHash),
        eq(chatTurnRequests.state, "creating"),
      ),
    )
    .returning();
  if (rows[0]) return rows[0];

  const existing = await getChatTurnRequest(parsed);
  if (existing && existing.requestHash === parsed.requestHash) return existing;
  throw new Error("Turn request could not be marked indeterminate.");
}
