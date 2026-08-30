import { z } from "zod";

import {
  ChatSessionIdSchema,
  DataSourceIdSchema,
  SqlChangeExecutionIdSchema,
  SqlChangeSetIdSchema,
} from "./ids.js";
import { DatabaseConnectorTypeSchema } from "./types.js";

export const SQL_CHANGE_OPERATIONS = [
  "insert",
  "update",
  "delete",
  "add_column",
  "rename_column",
  "add_and_backfill_column",
] as const;
export const SQL_CHANGE_STATUSES = [
  "prepared",
  "pending_approval",
  "applied",
  "denied",
  "expired",
  "stale",
  "partial",
  "failed",
] as const;
export const SQL_DIALECTS = [
  "postgresql",
  "mysql",
  "transactsql",
  "snowflake",
  "bigquery",
  "redshift",
] as const;

export const SqlChangeOperationSchema = z.enum(SQL_CHANGE_OPERATIONS);
export const SqlChangeStatusSchema = z.enum(SQL_CHANGE_STATUSES);
export const SqlDialectSchema = z.enum(SQL_DIALECTS);
export type SqlChangeOperation = z.infer<typeof SqlChangeOperationSchema>;
export type SqlChangeStatus = z.infer<typeof SqlChangeStatusSchema>;
export type SqlDialect = z.infer<typeof SqlDialectSchema>;

const JsonObjectSchema = z.record(z.string(), z.unknown());
export const SqlBoundParameterSchema = z
  .object({
    position: z.number().int().positive(),
    type: z.enum(["null", "boolean", "number", "string"]),
    value: z.union([z.null(), z.boolean(), z.number(), z.string()]),
  })
  .strict();
export type SqlBoundParameter = z.infer<typeof SqlBoundParameterSchema>;

export const SqlChangeSetSchema = z
  .object({
    id: SqlChangeSetIdSchema,
    chatSessionId: ChatSessionIdSchema,
    dataSourceId: DataSourceIdSchema,
    connectorType: DatabaseConnectorTypeSchema,
    sqlDialect: SqlDialectSchema,
    operation: SqlChangeOperationSchema,
    targetCatalog: z.string().nullable(),
    targetSchema: z.string().nullable(),
    targetTable: z.string(),
    canonicalSql: z.string(),
    boundParameters: z.array(SqlBoundParameterSchema),
    structuredOperation: JsonObjectSchema.nullable(),
    statementHash: z.string().regex(/^[0-9a-f]{64}$/),
    preview: JsonObjectSchema,
    preconditions: JsonObjectSchema,
    executionStrategy: JsonObjectSchema,
    resourceEstimate: JsonObjectSchema.nullable(),
    expectedAffectedRows: z.number().int().nonnegative(),
    credentialRevision: z.number().int().positive(),
    approvalTurnId: z.string().nullable(),
    approvalToolCallId: z.string().nullable(),
    approvalRecordedAt: z.date().nullable(),
    status: SqlChangeStatusSchema,
    expiresAt: z.date(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export type SqlChangeSet = z.infer<typeof SqlChangeSetSchema>;

export const SqlChangeExecutionSchema = z
  .object({
    id: SqlChangeExecutionIdSchema,
    changeSetId: SqlChangeSetIdSchema,
    trueforgeTurnId: z.string(),
    trueforgeToolCallId: z.string(),
    providerExecutionId: z.string().nullable(),
    actualAffectedRows: z.number().int().nonnegative().nullable(),
    outcome: SqlChangeStatusSchema.nullable(),
    verification: JsonObjectSchema,
    errorCode: z.string().nullable(),
    startedAt: z.date(),
    executedAt: z.date().nullable(),
  })
  .strict();

export type SqlChangeExecution = z.infer<typeof SqlChangeExecutionSchema>;

export type SqlChangeApprovalDisplay = Pick<
  SqlChangeSet,
  | "id"
  | "connectorType"
  | "operation"
  | "targetCatalog"
  | "targetSchema"
  | "targetTable"
  | "canonicalSql"
  | "statementHash"
  | "expectedAffectedRows"
  | "resourceEstimate"
>;
