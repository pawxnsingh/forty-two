import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  MAX_PLAN_ITEMS,
  MAX_PLAN_ITEM_TEXT_LENGTH,
  MAX_PLAN_SUMMARY_LENGTH,
  MAX_PLAN_TITLE_LENGTH,
  MAX_CHAT_SESSION_TITLE_LENGTH,
  PlanItemStatusSchema,
  SessionPlanSchema,
  SessionPlanSnapshotSchema,
  type SessionPlan,
  type SessionPlanSnapshot,
} from "../../chat-session-types.js";
import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema } from "../../ids.js";
import { chatSessions } from "../../schema/chat-sessions.js";

export class ChatSessionPlanUnavailableError extends Error {
  constructor() {
    super("The chat session is not active or is unavailable.");
    this.name = "ChatSessionPlanUnavailableError";
  }
}

const PlanSetItemInputSchema = z.object({
  text: z.string().trim().min(1).max(MAX_PLAN_ITEM_TEXT_LENGTH),
  status: PlanItemStatusSchema.optional().default("pending"),
});

export const SetChatSessionPlanInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  title: z.string().trim().min(1).max(MAX_PLAN_TITLE_LENGTH),
  items: z.array(PlanSetItemInputSchema).min(1).max(MAX_PLAN_ITEMS),
});
export type SetChatSessionPlanInput = z.input<
  typeof SetChatSessionPlanInputSchema
>;

export const UpdateChatSessionPlanItemInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  itemIndex: z.number().int().nonnegative(),
  status: PlanItemStatusSchema,
  summary: z.string().trim().max(MAX_PLAN_SUMMARY_LENGTH).optional(),
});
export type UpdateChatSessionPlanItemInput = z.input<
  typeof UpdateChatSessionPlanItemInputSchema
>;

export const GetChatSessionPlanInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
});
export type GetChatSessionPlanInput = z.input<
  typeof GetChatSessionPlanInputSchema
>;

export const BeginChatSessionQuestionInputSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  questionKey: z.string().trim().min(1).max(255),
  sessionTitle: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CHAT_SESSION_TITLE_LENGTH)
    .optional(),
});
export type BeginChatSessionQuestionInput = z.input<
  typeof BeginChatSessionQuestionInputSchema
>;

export interface BeginChatSessionQuestionResult extends SessionPlanSnapshot {
  reset: boolean;
}

export async function getChatSessionPlan(
  input: GetChatSessionPlanInput,
): Promise<SessionPlanSnapshot | null> {
  const parsed = GetChatSessionPlanInputSchema.parse(input);
  const rows = await getDatabase()
    .select({
      plan: chatSessions.plan,
      revision: chatSessions.planRevision,
      updatedAt: chatSessions.planUpdatedAt,
    })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.status, "active"),
        isNull(chatSessions.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ? parseSnapshot(rows[0]) : null;
}

export async function setChatSessionPlan(
  input: SetChatSessionPlanInput,
): Promise<SessionPlanSnapshot> {
  const parsed = SetChatSessionPlanInputSchema.parse(input);
  const nextPlan = SessionPlanSchema.parse({
    title: parsed.title,
    items: parsed.items.map((item) => ({
      text: item.text,
      status: item.status,
    })),
  });

  return mutatePlan(parsed.chatSessionId, (current) => {
    if (plansEqual(current, nextPlan)) return current;
    return nextPlan;
  });
}

export async function updateChatSessionPlanItem(
  input: UpdateChatSessionPlanItemInput,
): Promise<SessionPlanSnapshot> {
  const parsed = UpdateChatSessionPlanItemInputSchema.parse(input);

  return mutatePlan(parsed.chatSessionId, (current) => {
    if (!current)
      throw new Error("A plan must be set before updating an item.");
    if (parsed.itemIndex >= current.items.length) {
      throw new Error(`Plan item index ${parsed.itemIndex} is out of range.`);
    }

    const existing = current.items[parsed.itemIndex]!;
    const updated = {
      ...existing,
      status: parsed.status,
      ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
    };
    if (
      existing.status === updated.status &&
      existing.summary === updated.summary
    ) {
      return current;
    }
    const items = current.items.slice();
    items[parsed.itemIndex] = updated;
    return SessionPlanSchema.parse({ ...current, items });
  });
}

export async function beginChatSessionQuestion(
  input: BeginChatSessionQuestionInput,
): Promise<BeginChatSessionQuestionResult> {
  const parsed = BeginChatSessionQuestionInputSchema.parse(input);
  return getDatabase().transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, parsed.chatSessionId))
      .for("update")
      .limit(1);
    const row = requireActive(rows[0]);
    const snapshot = parseSnapshot({
      plan: row.plan,
      revision: row.planRevision,
      updatedAt: row.planUpdatedAt,
    });
    if (row.planQuestionKey === parsed.questionKey) {
      return { ...snapshot, reset: false };
    }

    const reset = snapshot.plan !== null;
    const returned = await transaction
      .update(chatSessions)
      .set({
        planQuestionKey: parsed.questionKey,
        ...(row.title === null && parsed.sessionTitle
          ? { title: parsed.sessionTitle }
          : {}),
        ...(reset
          ? {
              plan: null,
              planRevision: sql`${chatSessions.planRevision} + 1`,
              planUpdatedAt: sql`CURRENT_TIMESTAMP`,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            }
          : {}),
      })
      .where(eq(chatSessions.id, parsed.chatSessionId))
      .returning({
        plan: chatSessions.plan,
        revision: chatSessions.planRevision,
        updatedAt: chatSessions.planUpdatedAt,
      });

    return { ...parseSnapshot(returned[0]!), reset };
  });
}

export async function setChatSessionTitleIfEmpty(input: {
  chatSessionId: string;
  title: string;
}): Promise<string | null> {
  const parsed = z
    .object({
      chatSessionId: ChatSessionIdSchema,
      title: z.string().trim().min(1).max(MAX_CHAT_SESSION_TITLE_LENGTH),
    })
    .parse(input);
  const rows = await getDatabase()
    .update(chatSessions)
    .set({ title: parsed.title })
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.status, "active"),
        isNull(chatSessions.deletedAt),
        isNull(chatSessions.title),
      ),
    )
    .returning({ title: chatSessions.title });
  if (rows[0]?.title) return rows[0].title;

  const existing = await getDatabase()
    .select({ title: chatSessions.title })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, parsed.chatSessionId),
        eq(chatSessions.status, "active"),
        isNull(chatSessions.deletedAt),
      ),
    )
    .limit(1);
  return existing[0]?.title ?? null;
}

async function mutatePlan(
  chatSessionId: string,
  mutate: (current: SessionPlan | null) => SessionPlan | null,
): Promise<SessionPlanSnapshot> {
  return getDatabase().transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, chatSessionId))
      .for("update")
      .limit(1);
    const row = requireActive(rows[0]);
    const current =
      row.plan === null ? null : SessionPlanSchema.parse(row.plan);
    const next = mutate(current);
    if (plansEqual(current, next)) {
      return parseSnapshot({
        plan: row.plan,
        revision: row.planRevision,
        updatedAt: row.planUpdatedAt,
      });
    }

    const returned = await transaction
      .update(chatSessions)
      .set({
        plan: next,
        planRevision: sql`${chatSessions.planRevision} + 1`,
        planUpdatedAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(chatSessions.id, chatSessionId))
      .returning({
        plan: chatSessions.plan,
        revision: chatSessions.planRevision,
        updatedAt: chatSessions.planUpdatedAt,
      });
    return parseSnapshot(returned[0]!);
  });
}

function requireActive(
  row: typeof chatSessions.$inferSelect | undefined,
): typeof chatSessions.$inferSelect {
  if (!row || row.status !== "active" || row.deletedAt !== null) {
    throw new ChatSessionPlanUnavailableError();
  }
  return row;
}

function parseSnapshot(value: {
  plan: unknown;
  revision: number;
  updatedAt: Date | null;
}): SessionPlanSnapshot {
  return SessionPlanSnapshotSchema.parse({
    plan: value.plan,
    revision: value.revision,
    updatedAt: value.updatedAt,
  });
}

function plansEqual(
  left: SessionPlan | null,
  right: SessionPlan | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
