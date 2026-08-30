import { relations, sql } from "drizzle-orm";
import {
  bigint,
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

export const dataSourceTypeEnum = pgEnum("data_source_type", [
  "csv",
  "xlsx",
  "postgresql",
  "mysql",
  "sqlserver",
  "snowflake",
  "bigquery",
  "redshift",
]);

export const dataSourceStatusEnum = pgEnum("data_source_status", [
  "awaiting_upload",
  "testing",
  "ready",
  "failed",
  "deleted",
]);

export const dataSourceBlobCleanupStatusEnum = pgEnum(
  "data_source_blob_cleanup_status",
  ["pending", "deleted", "missing", "superseded"],
);

export const dataSources = pgTable(
  "data_sources",
  {
    id: text("id").primaryKey(),
    connectorType: dataSourceTypeEnum("connector_type").notNull(),
    name: text("name").notNull(),
    status: dataSourceStatusEnum("status").notNull(),
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    azureBlobName: text("azure_blob_name"),
    azureETag: text("azure_etag"),
    azureCleanupStatus: dataSourceBlobCleanupStatusEnum("azure_cleanup_status"),
    azureCleanupETag: text("azure_cleanup_etag"),
    azureCleanupAttempts: integer("azure_cleanup_attempts")
      .default(0)
      .notNull(),
    azureCleanupCompletedAt: timestamp("azure_cleanup_completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    azureCleanupErrorCode: text("azure_cleanup_error_code"),
    processingMessage: text("processing_message"),
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
      "data_sources_id_format_check",
      sql`${table.id} ~ '^ds_[0-9A-HJKMNP-TV-Z]{26}$'`,
    ),
    check(
      "data_sources_name_nonempty_check",
      sql`char_length(btrim(${table.name})) > 0`,
    ),
    check(
      "data_sources_config_object_check",
      sql`jsonb_typeof(${table.config}) = 'object'`,
    ),
    check(
      "data_sources_file_size_check",
      sql`${table.fileSizeBytes} IS NULL OR (${table.fileSizeBytes} >= 0 AND ${table.fileSizeBytes} <= 9007199254740991)`,
    ),
    check(
      "data_sources_connector_metadata_check",
      sql`(
        ${table.connectorType} IN ('postgresql', 'mysql', 'sqlserver', 'snowflake', 'bigquery', 'redshift')
        AND ${table.originalFilename} IS NULL
        AND ${table.mimeType} IS NULL
        AND ${table.fileSizeBytes} IS NULL
        AND ${table.azureBlobName} IS NULL
        AND ${table.azureETag} IS NULL
      ) OR (
        ${table.connectorType} IN ('csv', 'xlsx')
        AND ${table.originalFilename} IS NOT NULL
        AND ${table.mimeType} IS NOT NULL
        AND ${table.fileSizeBytes} IS NOT NULL
        AND ${table.azureBlobName} IS NOT NULL
      )`,
    ),
    check(
      "data_sources_connector_status_check",
      sql`(
        ${table.connectorType} IN ('csv', 'xlsx')
        AND ${table.status} <> 'testing'
      ) OR (
        ${table.connectorType} IN ('postgresql', 'mysql', 'sqlserver', 'snowflake', 'bigquery', 'redshift')
        AND ${table.status} <> 'awaiting_upload'
      )`,
    ),
    check(
      "data_sources_ready_file_etag_check",
      sql`${table.connectorType} NOT IN ('csv', 'xlsx')
        OR ${table.status} <> 'ready'
        OR (${table.azureETag} IS NOT NULL AND char_length(btrim(${table.azureETag})) > 0)`,
    ),
    check(
      "data_sources_deleted_state_check",
      sql`(${table.status} = 'deleted') = (${table.deletedAt} IS NOT NULL)`,
    ),
    check(
      "data_sources_azure_cleanup_attempts_check",
      sql`${table.azureCleanupAttempts} >= 0`,
    ),
    check(
      "data_sources_azure_cleanup_state_check",
      sql`(
        ${table.connectorType} IN ('csv', 'xlsx')
        AND ${table.status} = 'deleted'
        AND ${table.azureCleanupStatus} IS NOT NULL
        AND (${table.azureCleanupETag} IS NULL OR char_length(btrim(${table.azureCleanupETag})) BETWEEN 1 AND 1024)
        AND (${table.azureCleanupErrorCode} IS NULL OR char_length(btrim(${table.azureCleanupErrorCode})) BETWEEN 1 AND 255)
        AND (
          (${table.azureCleanupStatus} = 'pending' AND ${table.azureCleanupCompletedAt} IS NULL)
          OR (${table.azureCleanupStatus} = 'deleted' AND ${table.azureCleanupETag} IS NOT NULL AND ${table.azureCleanupAttempts} > 0 AND ${table.azureCleanupCompletedAt} IS NOT NULL AND ${table.azureCleanupErrorCode} IS NULL)
          OR (${table.azureCleanupStatus} = 'missing' AND ${table.azureCleanupAttempts} > 0 AND ${table.azureCleanupCompletedAt} IS NOT NULL AND ${table.azureCleanupErrorCode} IS NULL)
          OR (${table.azureCleanupStatus} = 'superseded' AND ${table.azureCleanupETag} IS NOT NULL AND ${table.azureCleanupAttempts} > 0 AND ${table.azureCleanupCompletedAt} IS NOT NULL AND ${table.azureCleanupErrorCode} IS NULL)
        )
      ) OR (
        NOT (${table.connectorType} IN ('csv', 'xlsx') AND ${table.status} = 'deleted')
        AND ${table.azureCleanupStatus} IS NULL
        AND ${table.azureCleanupETag} IS NULL
        AND ${table.azureCleanupAttempts} = 0
        AND ${table.azureCleanupCompletedAt} IS NULL
        AND ${table.azureCleanupErrorCode} IS NULL
      )`,
    ),
    index("data_sources_status_type_idx").on(table.status, table.connectorType),
    index("data_sources_deleted_at_idx").on(table.deletedAt),
    index("data_sources_ready_created_at_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'ready' AND ${table.deletedAt} IS NULL`),
    uniqueIndex("data_sources_azure_blob_name_unique_idx")
      .on(table.azureBlobName)
      .where(sql`${table.azureBlobName} IS NOT NULL`),
  ],
);

export const dataSourceCredentials = pgTable(
  "data_source_credentials",
  {
    dataSourceId: text("data_source_id")
      .primaryKey()
      .references(() => dataSources.id, { onDelete: "cascade" }),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    encryptionVersion: integer("encryption_version").notNull(),
    revision: integer("revision").default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "data_source_credentials_ciphertext_nonempty_check",
      sql`char_length(${table.ciphertext}) > 0`,
    ),
    check(
      "data_source_credentials_iv_nonempty_check",
      sql`char_length(${table.iv}) > 0`,
    ),
    check(
      "data_source_credentials_auth_tag_nonempty_check",
      sql`char_length(${table.authTag}) > 0`,
    ),
    check(
      "data_source_credentials_encryption_version_check",
      sql`${table.encryptionVersion} > 0`,
    ),
    check("data_source_credentials_revision_check", sql`${table.revision} > 0`),
  ],
);

export const dataSourcesRelations = relations(dataSources, ({ one }) => ({
  credentials: one(dataSourceCredentials),
}));

export const dataSourceCredentialsRelations = relations(
  dataSourceCredentials,
  ({ one }) => ({
    dataSource: one(dataSources, {
      fields: [dataSourceCredentials.dataSourceId],
      references: [dataSources.id],
    }),
  }),
);

export type DataSourceRow = typeof dataSources.$inferSelect;
export type NewDataSourceRow = typeof dataSources.$inferInsert;
export type DataSourceCredentialRow = typeof dataSourceCredentials.$inferSelect;
export type NewDataSourceCredentialRow =
  typeof dataSourceCredentials.$inferInsert;
