import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { ChatSession } from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema } from "../../ids.js";
import { chatSessions } from "../../schema/chat-sessions.js";
import { parseChatSession } from "./shared.js";

const CapabilityIdSchema = z.string().trim().min(1).max(255);

export const AuthorizeChatSessionCapabilityInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  capabilityId: CapabilityIdSchema,
});

export type AuthorizeChatSessionCapabilityInput = z.input<
  typeof AuthorizeChatSessionCapabilityInputSchema
>;

export async function authorizeChatSessionCapability(
  input: AuthorizeChatSessionCapabilityInput,
): Promise<ChatSession | null> {
  const parsed = AuthorizeChatSessionCapabilityInputSchema.parse(input);
  const rows = await getDatabase()
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.capabilityId, parsed.capabilityId),
        eq(chatSessions.status, "active"),
        gt(chatSessions.capabilityExpiresAt, sql`CURRENT_TIMESTAMP`),
        isNull(chatSessions.capabilityRevokedAt),
        isNull(chatSessions.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ? parseChatSession(rows[0]) : null;
}

export const RevokeChatSessionCapabilityInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  capabilityId: CapabilityIdSchema,
});

export type RevokeChatSessionCapabilityInput = z.input<
  typeof RevokeChatSessionCapabilityInputSchema
>;

export async function revokeChatSessionCapability(
  input: RevokeChatSessionCapabilityInput,
): Promise<ChatSession | null> {
  const parsed = RevokeChatSessionCapabilityInputSchema.parse(input);
  const rows = await getDatabase()
    .update(chatSessions)
    .set({
      capabilityRevokedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.capabilityId, parsed.capabilityId),
        isNull(chatSessions.capabilityRevokedAt),
        isNull(chatSessions.deletedAt),
      ),
    )
    .returning();

  return rows[0] ? parseChatSession(rows[0]) : null;
}

export const RotateChatSessionCapabilityInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  capabilityId: CapabilityIdSchema,
  capabilityExpiresAt: z.date(),
});

export type RotateChatSessionCapabilityInput = z.input<
  typeof RotateChatSessionCapabilityInputSchema
>;

export async function rotateChatSessionCapability(
  input: RotateChatSessionCapabilityInput,
): Promise<ChatSession | null> {
  const parsed = RotateChatSessionCapabilityInputSchema.parse(input);
  const rows = await getDatabase()
    .update(chatSessions)
    .set({
      capabilityId: parsed.capabilityId,
      capabilityExpiresAt: parsed.capabilityExpiresAt,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.status, "active"),
        isNull(chatSessions.capabilityRevokedAt),
        isNull(chatSessions.deletedAt),
      ),
    )
    .returning();

  return rows[0] ? parseChatSession(rows[0]) : null;
}
