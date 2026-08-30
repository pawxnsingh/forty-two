import { z } from "zod";

import { ChatSessionIdSchema, DataSourceIdSchema } from "./ids.js";

export const CHAT_SESSION_STATUSES = [
  "creating",
  "active",
  "failed",
  "deleted",
] as const;

export const ChatSessionStatusSchema = z.enum(CHAT_SESSION_STATUSES);
export type ChatSessionStatus = z.infer<typeof ChatSessionStatusSchema>;

export const PLAN_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
] as const;

export const MAX_PLAN_ITEMS = 15;
export const MAX_PLAN_TITLE_LENGTH = 200;
export const MAX_PLAN_ITEM_TEXT_LENGTH = 500;
export const MAX_PLAN_SUMMARY_LENGTH = 1_000;
export const MAX_CHAT_SESSION_TITLE_LENGTH = 200;

export const PlanItemStatusSchema = z.enum(PLAN_ITEM_STATUSES);
export type PlanItemStatus = z.infer<typeof PlanItemStatusSchema>;

export const PlanItemSchema = z.object({
  text: z.string().trim().min(1).max(MAX_PLAN_ITEM_TEXT_LENGTH),
  status: PlanItemStatusSchema,
  summary: z.string().trim().max(MAX_PLAN_SUMMARY_LENGTH).optional(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const SessionPlanSchema = z.object({
  title: z.string().trim().min(1).max(MAX_PLAN_TITLE_LENGTH),
  items: z.array(PlanItemSchema).min(1).max(MAX_PLAN_ITEMS),
});
export type SessionPlan = z.infer<typeof SessionPlanSchema>;

export const SessionPlanSnapshotSchema = z.object({
  plan: SessionPlanSchema.nullable(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.date().nullable(),
});
export type SessionPlanSnapshot = z.infer<typeof SessionPlanSnapshotSchema>;

export const ChatSessionSchema = z.object({
  id: ChatSessionIdSchema,
  trueforgeSessionId: z.string().nullable(),
  mcpServerName: z.string().nullable(),
  capabilityId: z.string().min(1),
  capabilityExpiresAt: z.date(),
  capabilityRevokedAt: z.date().nullable(),
  idempotencyKey: z.string().nullable(),
  idempotencyRequestHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  title: z.string().trim().min(1).max(MAX_CHAT_SESSION_TITLE_LENGTH).nullable(),
  status: ChatSessionStatusSchema,
  failureMessage: z.string().min(1).max(4000).nullable(),
  plan: SessionPlanSchema.nullable(),
  planRevision: z.number().int().nonnegative(),
  planUpdatedAt: z.date().nullable(),
  planQuestionKey: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
});

export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ChatSessionDataSourceBindingSchema = z.object({
  chatSessionId: ChatSessionIdSchema,
  dataSourceId: DataSourceIdSchema,
});

export type ChatSessionDataSourceBinding = z.infer<
  typeof ChatSessionDataSourceBindingSchema
>;
