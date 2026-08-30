import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type {
  ArtifactColumn,
  ArtifactProvenance,
} from "../artifact-types.js";
import { chatSessions } from "./chat-sessions.js";

export const analysisArtifactKindEnum = pgEnum("analysis_artifact_kind", [
  "table",
  "chart",
]);
export const analysisArtifactStatusEnum = pgEnum("analysis_artifact_status", [
  "ready",
  "deleted",
]);

export const analysisArtifacts = pgTable(
  "analysis_artifacts",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    kind: analysisArtifactKindEnum("kind").notNull(),
    schemaVersion: text("schema_version").notNull(),
    title: text("title"),
    description: text("description"),
    status: analysisArtifactStatusEnum("status").default("ready").notNull(),
    azureBlobName: text("azure_blob_name"),
    azureETag: text("azure_etag"),
    contentSha256: text("content_sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    rowCount: integer("row_count"),
    columnCount: integer("column_count"),
    columns: jsonb("columns").$type<ArtifactColumn[]>(),
    preview: jsonb("preview").$type<Record<string, unknown>[]>(),
    sourceLimited: boolean("source_limited").default(false).notNull(),
    sourceMaxRows: integer("source_max_rows"),
    chartConfig: jsonb("chart_config").$type<Record<string, unknown>>(),
    provenance: jsonb("provenance").$type<ArtifactProvenance>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    retentionExpiresAt: timestamp("retention_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    cleanupCompletedAt: timestamp("cleanup_completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check(
      "analysis_artifacts_id_format_check",
      sql`${table.id} ~ '^art_[0-9A-HJKMNP-TV-Z]{26}$'`,
    ),
    check(
      "analysis_artifacts_hash_check",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "analysis_artifacts_size_check",
      sql`${table.byteSize} >= 0 AND ${table.byteSize} <= 9007199254740991`,
    ),
    check(
      "analysis_artifacts_title_description_check",
      sql`(${table.title} IS NULL OR char_length(${table.title}) BETWEEN 1 AND 500)
        AND (${table.description} IS NULL OR char_length(${table.description}) BETWEEN 1 AND 2000)`,
    ),
    check(
      "analysis_artifacts_kind_payload_check",
      sql`(
        ${table.kind} = 'table'
        AND ${table.schemaVersion} = 'table.v1'
        AND ${table.azureBlobName} IS NOT NULL
        AND ${table.azureETag} IS NOT NULL
        AND ${table.rowCount} BETWEEN 0 AND 10000
        AND ${table.columnCount} BETWEEN 1 AND 100
        AND jsonb_typeof(${table.columns}) = 'array'
        AND jsonb_array_length(${table.columns}) = ${table.columnCount}
        AND jsonb_typeof(${table.preview}) = 'array'
        AND jsonb_array_length(${table.preview}) <= 30
        AND ${table.chartConfig} IS NULL
      ) OR (
        ${table.kind} = 'chart'
        AND ${table.schemaVersion} = 'chart.v1'
        AND ${table.azureBlobName} IS NULL
        AND ${table.azureETag} IS NULL
        AND ${table.rowCount} IS NULL
        AND ${table.columnCount} IS NULL
        AND ${table.columns} IS NULL
        AND ${table.preview} IS NULL
        AND ${table.sourceLimited} = false
        AND ${table.sourceMaxRows} IS NULL
        AND jsonb_typeof(${table.chartConfig}) = 'object'
      )`,
    ),
    check(
      "analysis_artifacts_limit_check",
      sql`(${table.sourceLimited} AND ${table.sourceMaxRows} IS NOT NULL AND ${table.sourceMaxRows} > 0)
        OR (NOT ${table.sourceLimited} AND ${table.sourceMaxRows} IS NULL)`,
    ),
    check(
      "analysis_artifacts_provenance_check",
      sql`jsonb_typeof(${table.provenance}) = 'object'`,
    ),
    check(
      "analysis_artifacts_deleted_state_check",
      sql`(${table.status} = 'deleted') = (${table.deletedAt} IS NOT NULL)
        AND (${table.deletedAt} IS NULL) = (${table.retentionExpiresAt} IS NULL)`,
    ),
    uniqueIndex("analysis_artifacts_session_id_unique_idx").on(
      table.chatSessionId,
      table.id,
    ),
    uniqueIndex("analysis_artifacts_session_operation_kind_unique_idx").on(
      table.chatSessionId,
      sql`(${table.provenance}->>'operationKey')`,
      table.kind,
    ),
    index("analysis_artifacts_session_list_idx").on(
      table.chatSessionId,
      table.createdAt,
      table.id,
    ),
    index("analysis_artifacts_retention_idx").on(
      table.status,
      table.retentionExpiresAt,
    ),
  ],
);

export const analysisArtifactLineage = pgTable(
  "analysis_artifact_lineage",
  {
    chatSessionId: text("chat_session_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    parentArtifactId: text("parent_artifact_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "analysis_artifact_lineage_pk",
      columns: [table.artifactId, table.parentArtifactId],
    }),
    foreignKey({
      name: "analysis_artifact_lineage_child_session_fk",
      columns: [table.chatSessionId, table.artifactId],
      foreignColumns: [analysisArtifacts.chatSessionId, analysisArtifacts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "analysis_artifact_lineage_parent_session_fk",
      columns: [table.chatSessionId, table.parentArtifactId],
      foreignColumns: [analysisArtifacts.chatSessionId, analysisArtifacts.id],
    }).onDelete("restrict"),
    check(
      "analysis_artifact_lineage_no_self_check",
      sql`${table.artifactId} <> ${table.parentArtifactId}`,
    ),
    index("analysis_artifact_lineage_parent_idx").on(
      table.chatSessionId,
      table.parentArtifactId,
    ),
  ],
);

export const analysisArtifactsRelations = relations(
  analysisArtifacts,
  ({ one, many }) => ({
    chatSession: one(chatSessions, {
      fields: [analysisArtifacts.chatSessionId],
      references: [chatSessions.id],
    }),
    parents: many(analysisArtifactLineage, { relationName: "artifactParents" }),
    children: many(analysisArtifactLineage, { relationName: "artifactChildren" }),
  }),
);

export type AnalysisArtifactRow = typeof analysisArtifacts.$inferSelect;
export type NewAnalysisArtifactRow = typeof analysisArtifacts.$inferInsert;
