import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { SqlBoundParameter } from "../sql-change-types.js";
import { chatSessions } from "./chat-sessions.js";
import { dataSources } from "./data-sources.js";

export const sqlChangeOperationEnum = pgEnum("sql_change_operation", [
  "insert",
  "update",
  "delete",
  "add_column",
  "rename_column",
  "add_and_backfill_column",
]);
export const sqlChangeStatusEnum = pgEnum("sql_change_status", [
  "prepared",
  "pending_approval",
  "applied",
  "denied",
  "expired",
  "stale",
  "partial",
  "failed",
]);

export const sqlChangeSets = pgTable(
  "sql_change_sets",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "restrict" }),
    dataSourceId: text("data_source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    connectorType: text("connector_type").notNull(),
    sqlDialect: text("sql_dialect").notNull(),
    operation: sqlChangeOperationEnum("operation").notNull(),
    targetCatalog: text("target_catalog"),
    targetSchema: text("target_schema"),
    targetTable: text("target_table").notNull(),
    canonicalSql: text("canonical_sql").notNull(),
    boundParameters: jsonb("bound_parameters")
      .$type<SqlBoundParameter[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    structuredOperation: jsonb("structured_operation").$type<Record<
      string,
      unknown
    > | null>(),
    statementHash: text("statement_hash").notNull(),
    preview: jsonb("preview").$type<Record<string, unknown>>().notNull(),
    preconditions: jsonb("preconditions")
      .$type<Record<string, unknown>>()
      .notNull(),
    executionStrategy: jsonb("execution_strategy")
      .$type<Record<string, unknown>>()
      .notNull(),
    resourceEstimate: jsonb("resource_estimate").$type<Record<
      string,
      unknown
    > | null>(),
    expectedAffectedRows: integer("expected_affected_rows").notNull(),
    credentialRevision: integer("credential_revision").notNull(),
    approvalTurnId: text("approval_turn_id"),
    approvalToolCallId: text("approval_tool_call_id"),
    approvalRecordedAt: timestamp("approval_recorded_at", {
      withTimezone: true,
      mode: "date",
    }),
    status: sqlChangeStatusEnum("status").default("prepared").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "sql_change_sets_id_format_check",
      sql`${table.id} ~ '^change_[0-9A-HJKMNP-TV-Z]{26}$'`,
    ),
    check(
      "sql_change_sets_connector_check",
      sql`${table.connectorType} IN ('postgresql','mysql','sqlserver','snowflake','bigquery','redshift')`,
    ),
    check(
      "sql_change_sets_dialect_check",
      sql`${table.sqlDialect} IN ('postgresql','mysql','transactsql','snowflake','bigquery','redshift')`,
    ),
    check(
      "sql_change_sets_text_check",
      sql`char_length(btrim(${table.targetTable})) BETWEEN 1 AND 255
        AND char_length(${table.canonicalSql}) BETWEEN 1 AND 100000`,
    ),
    check(
      "sql_change_sets_hash_check",
      sql`${table.statementHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "sql_change_sets_json_check",
      sql`jsonb_typeof(${table.boundParameters}) = 'array'
        AND (${table.structuredOperation} IS NULL OR jsonb_typeof(${table.structuredOperation}) = 'object')
        AND jsonb_typeof(${table.preview}) = 'object'
        AND jsonb_typeof(${table.preconditions}) = 'object'
        AND jsonb_typeof(${table.executionStrategy}) = 'object'
        AND (${table.resourceEstimate} IS NULL OR jsonb_typeof(${table.resourceEstimate}) = 'object')`,
    ),
    check(
      "sql_change_sets_row_bound_check",
      sql`${table.expectedAffectedRows} BETWEEN 0 AND 100`,
    ),
    check(
      "sql_change_sets_structured_operation_check",
      sql`(
        ${table.operation} IN ('insert','update','delete')
        AND ${table.structuredOperation} IS NULL
      ) OR (
        ${table.operation} IN ('add_column','rename_column','add_and_backfill_column')
        AND ${table.structuredOperation} IS NOT NULL
      )`,
    ),
    check(
      "sql_change_sets_revision_check",
      sql`${table.credentialRevision} > 0`,
    ),
    check(
      "sql_change_sets_approval_evidence_check",
      sql`(
        ${table.approvalTurnId} IS NULL
        AND ${table.approvalToolCallId} IS NULL
        AND ${table.approvalRecordedAt} IS NULL
      ) OR (
        char_length(btrim(${table.approvalTurnId})) BETWEEN 1 AND 255
        AND char_length(btrim(${table.approvalToolCallId})) BETWEEN 1 AND 255
        AND ${table.approvalRecordedAt} IS NOT NULL
      )`,
    ),
    check(
      "sql_change_sets_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
    check(
      "sql_change_sets_timestamp_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    index("sql_change_sets_session_created_idx").on(
      table.chatSessionId,
      table.createdAt,
    ),
    index("sql_change_sets_pending_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

export const sqlChangeExecutions = pgTable(
  "sql_change_executions",
  {
    id: text("id").primaryKey(),
    changeSetId: text("change_set_id")
      .notNull()
      .references(() => sqlChangeSets.id, { onDelete: "restrict" }),
    trueforgeTurnId: text("trueforge_turn_id").notNull(),
    trueforgeToolCallId: text("trueforge_tool_call_id").notNull(),
    providerExecutionId: text("provider_execution_id"),
    actualAffectedRows: integer("actual_affected_rows"),
    outcome: sqlChangeStatusEnum("outcome"),
    verification: jsonb("verification")
      .$type<Record<string, unknown>>()
      .notNull(),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    check(
      "sql_change_executions_id_format_check",
      sql`${table.id} ~ '^changeexec_[0-9A-HJKMNP-TV-Z]{26}$'`,
    ),
    check(
      "sql_change_executions_ids_check",
      sql`char_length(btrim(${table.trueforgeTurnId})) BETWEEN 1 AND 255
        AND char_length(btrim(${table.trueforgeToolCallId})) BETWEEN 1 AND 255`,
    ),
    check(
      "sql_change_executions_rows_check",
      sql`${table.actualAffectedRows} IS NULL OR ${table.actualAffectedRows} BETWEEN 0 AND 100`,
    ),
    check(
      "sql_change_executions_verification_check",
      sql`jsonb_typeof(${table.verification}) = 'object'`,
    ),
    check(
      "sql_change_executions_completion_check",
      sql`(${table.executedAt} IS NULL AND ${table.outcome} IS NULL AND ${table.actualAffectedRows} IS NULL AND ${table.providerExecutionId} IS NULL)
        OR (${table.executedAt} IS NOT NULL AND ${table.executedAt} >= ${table.startedAt}
          AND ${table.outcome} IS NOT NULL
          AND (${table.outcome} IN ('applied', 'stale', 'partial', 'failed')) IS TRUE)`,
    ),
    check(
      "sql_change_executions_partial_evidence_check",
      sql`CASE WHEN ${table.outcome} = 'partial' THEN
          ${table.providerExecutionId} IS NOT NULL
          AND char_length(btrim(${table.providerExecutionId})) BETWEEN 1 AND 1024
          AND ${table.actualAffectedRows} IS NULL
          AND ${table.errorCode} = 'SqlChangePartialCommitError'
          AND jsonb_typeof(${table.verification}->'phase') = 'string'
          AND char_length(btrim(${table.verification}->>'phase')) > 0
          AND ${table.verification} @> '{"phase":"partial_ddl_committed","ddlCommitted":true,"terminal":true,"freshApprovalRequired":true}'::jsonb
          AND NOT (${table.verification} ? 'resumable')
          AND NOT (${table.verification} ? 'requiresFreshApproval')
        ELSE ${table.errorCode} IS DISTINCT FROM 'SqlChangePartialCommitError' END`,
    ),
    uniqueIndex("sql_change_executions_change_set_unique_idx").on(
      table.changeSetId,
    ),
    uniqueIndex("sql_change_executions_trueforge_tool_unique_idx").on(
      table.trueforgeTurnId,
      table.trueforgeToolCallId,
    ),
  ],
);

export const sqlChangeSetsRelations = relations(sqlChangeSets, ({ one }) => ({
  chatSession: one(chatSessions, {
    fields: [sqlChangeSets.chatSessionId],
    references: [chatSessions.id],
  }),
  dataSource: one(dataSources, {
    fields: [sqlChangeSets.dataSourceId],
    references: [dataSources.id],
  }),
  execution: one(sqlChangeExecutions),
}));

export const sqlChangeExecutionsRelations = relations(
  sqlChangeExecutions,
  ({ one }) => ({
    changeSet: one(sqlChangeSets, {
      fields: [sqlChangeExecutions.changeSetId],
      references: [sqlChangeSets.id],
    }),
  }),
);

export type SqlChangeSetRow = typeof sqlChangeSets.$inferSelect;
export type NewSqlChangeSetRow = typeof sqlChangeSets.$inferInsert;
export type SqlChangeExecutionRow = typeof sqlChangeExecutions.$inferSelect;
export type NewSqlChangeExecutionRow = typeof sqlChangeExecutions.$inferInsert;
