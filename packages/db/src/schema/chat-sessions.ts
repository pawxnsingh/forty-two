import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { dataSources } from "./data-sources.js";
import type { SessionPlan } from "../chat-session-types.js";

export const chatSessionStatusEnum = pgEnum("chat_session_status", [
  "creating",
  "active",
  "failed",
  "deleted",
]);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    trueforgeSessionId: text("trueforge_session_id").unique(),
    mcpServerName: text("mcp_server_name").unique(),
    capabilityId: text("capability_id").notNull().unique(),
    capabilityExpiresAt: timestamp("capability_expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    capabilityRevokedAt: timestamp("capability_revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    idempotencyKey: text("idempotency_key").unique(),
    idempotencyRequestHash: text("idempotency_request_hash"),
    status: chatSessionStatusEnum("status").default("creating").notNull(),
    failureMessage: text("failure_message"),
    plan: jsonb("plan").$type<SessionPlan>(),
    planRevision: integer("plan_revision").default(0).notNull(),
    planUpdatedAt: timestamp("plan_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    planQuestionKey: text("plan_question_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    check(
      "chat_sessions_id_format_check",
      sql`${table.id} ~ '^sess_[0-7][0-9A-HJKMNP-TV-Z]{25}$'`,
    ),
    check(
      "chat_sessions_active_identifiers_check",
      sql`${table.status} <> 'active' OR (
        ${table.trueforgeSessionId} IS NOT NULL
        AND char_length(btrim(${table.trueforgeSessionId})) > 0
      )`,
    ),
    check(
      "chat_sessions_failure_message_check",
      sql`(
        ${table.status} = 'failed'
        AND ${table.failureMessage} IS NOT NULL
        AND char_length(btrim(${table.failureMessage})) BETWEEN 1 AND 4000
      ) OR (
        ${table.status} IN ('creating', 'active')
        AND ${table.failureMessage} IS NULL
      ) OR (
        ${table.status} = 'deleted'
        AND (
          ${table.failureMessage} IS NULL
          OR char_length(btrim(${table.failureMessage})) BETWEEN 1 AND 4000
        )
      )`,
    ),
    check(
      "chat_sessions_capability_expiry_check",
      sql`${table.capabilityExpiresAt} > ${table.createdAt}`,
    ),
    check(
      "chat_sessions_idempotency_pair_check",
      sql`(${table.idempotencyKey} IS NULL) = (${table.idempotencyRequestHash} IS NULL)`,
    ),
    check(
      "chat_sessions_idempotency_hash_check",
      sql`${table.idempotencyRequestHash} IS NULL OR ${table.idempotencyRequestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "chat_sessions_deleted_state_check",
      sql`(${table.status} = 'deleted') = (${table.deletedAt} IS NOT NULL)`,
    ),
    check(
      "chat_sessions_timestamp_order_check",
      sql`${table.updatedAt} >= ${table.createdAt}
        AND (${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.createdAt})
        AND (${table.capabilityRevokedAt} IS NULL OR ${table.capabilityRevokedAt} >= ${table.createdAt})`,
    ),
    check("chat_sessions_plan_revision_check", sql`${table.planRevision} >= 0`),
    check(
      "chat_sessions_plan_shape_check",
      sql`${table.plan} IS NULL OR jsonb_typeof(${table.plan}) = 'object'`,
    ),
    check(
      "chat_sessions_plan_timestamp_check",
      sql`(${table.plan} IS NULL OR ${table.planUpdatedAt} IS NOT NULL)
        AND (${table.planUpdatedAt} IS NULL OR ${table.planUpdatedAt} >= ${table.createdAt})`,
    ),
    index("chat_sessions_status_created_at_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const chatSessionDataSources = pgTable(
  "chat_session_data_sources",
  {
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    dataSourceId: text("data_source_id")
      .notNull()
      .references(() => dataSources.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
  },
  (table) => [
    primaryKey({
      name: "chat_session_data_sources_pk",
      columns: [table.chatSessionId, table.dataSourceId],
    }),
    index("chat_session_data_sources_data_source_id_idx").on(
      table.dataSourceId,
    ),
  ],
);

export const chatSessionsRelations = relations(chatSessions, ({ many }) => ({
  dataSourceBindings: many(chatSessionDataSources),
}));

export const chatSessionDataSourcesRelations = relations(
  chatSessionDataSources,
  ({ one }) => ({
    chatSession: one(chatSessions, {
      fields: [chatSessionDataSources.chatSessionId],
      references: [chatSessions.id],
    }),
    dataSource: one(dataSources, {
      fields: [chatSessionDataSources.dataSourceId],
      references: [dataSources.id],
    }),
  }),
);

export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type NewChatSessionRow = typeof chatSessions.$inferInsert;
export type ChatSessionDataSourceRow =
  typeof chatSessionDataSources.$inferSelect;
export type NewChatSessionDataSourceRow =
  typeof chatSessionDataSources.$inferInsert;
