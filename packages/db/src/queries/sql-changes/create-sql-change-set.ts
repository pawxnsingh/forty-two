import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import {
  ChatSessionIdSchema,
  DataSourceIdSchema,
  SqlChangeSetIdSchema,
} from "../../ids.js";
import {
  chatSessionDataSources,
  chatSessions,
} from "../../schema/chat-sessions.js";
import {
  dataSourceCredentials,
  dataSources,
} from "../../schema/data-sources.js";
import { sqlChangeSets } from "../../schema/sql-change-sets.js";
import {
  SqlBoundParameterSchema,
  SqlChangeOperationSchema,
  SqlDialectSchema,
  type SqlDialect,
  type SqlChangeSet,
} from "../../sql-change-types.js";
import {
  DatabaseConnectorTypeSchema,
  resolveDatabaseMutationTarget,
  type DatabaseConnectorType,
} from "../../types.js";
import { parseSqlChangeSet, SqlChangeConflictError } from "./shared.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());
const SQL_DIALECT_BY_CONNECTOR = {
  postgresql: "postgresql",
  mysql: "mysql",
  sqlserver: "transactsql",
  snowflake: "snowflake",
  bigquery: "bigquery",
  redshift: "redshift",
} as const satisfies Record<DatabaseConnectorType, SqlDialect>;

export const CreateSqlChangeSetInputSchema = z
  .object({
    id: SqlChangeSetIdSchema,
    chatSessionId: ChatSessionIdSchema,
    dataSourceId: DataSourceIdSchema,
    connectorType: DatabaseConnectorTypeSchema,
    sqlDialect: SqlDialectSchema,
    operation: SqlChangeOperationSchema,
    targetCatalog: z.string().trim().min(1).max(255).nullable(),
    targetSchema: z.string().trim().min(1).max(255).nullable(),
    targetTable: z.string().trim().min(1).max(255),
    canonicalSql: z.string().trim().min(1).max(100_000),
    boundParameters: z.array(SqlBoundParameterSchema).max(1_000),
    structuredOperation: JsonObjectSchema.nullable(),
    statementHash: z.string().regex(/^[0-9a-f]{64}$/),
    preview: JsonObjectSchema,
    preconditions: JsonObjectSchema,
    executionStrategy: JsonObjectSchema,
    resourceEstimate: JsonObjectSchema.nullable(),
    expectedAffectedRows: z.number().int().min(0).max(100),
    credentialRevision: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (SQL_DIALECT_BY_CONNECTOR[value.connectorType] !== value.sqlDialect) {
      context.addIssue({
        code: "custom",
        path: ["sqlDialect"],
        message: "SQL dialect does not match the datasource connector.",
      });
    }
  });

export type CreateSqlChangeSetInput = z.input<
  typeof CreateSqlChangeSetInputSchema
>;

export async function createSqlChangeSet(
  input: CreateSqlChangeSetInput,
): Promise<SqlChangeSet> {
  const parsed = CreateSqlChangeSetInputSchema.parse(input);
  return getDatabase().transaction(async (transaction) => {
    const sourceRows = await transaction
      .select({
        connectorType: dataSources.connectorType,
        config: dataSources.config,
        credentialRevision: dataSourceCredentials.revision,
      })
      .from(chatSessions)
      .innerJoin(
        chatSessionDataSources,
        and(
          eq(chatSessionDataSources.chatSessionId, chatSessions.id),
          eq(chatSessionDataSources.dataSourceId, parsed.dataSourceId),
        ),
      )
      .innerJoin(dataSources, eq(dataSources.id, parsed.dataSourceId))
      .innerJoin(
        dataSourceCredentials,
        eq(dataSourceCredentials.dataSourceId, dataSources.id),
      )
      .where(
        and(
          eq(chatSessions.id, parsed.chatSessionId),
          eq(chatSessions.status, "active"),
          isNull(chatSessions.deletedAt),
          eq(dataSources.status, "ready"),
          isNull(dataSources.deletedAt),
        ),
      )
      .limit(1);
    const source = sourceRows[0];
    if (!source)
      throw new SqlChangeConflictError("Session or datasource is unavailable.");
    if (
      source.connectorType !== parsed.connectorType ||
      source.credentialRevision !== parsed.credentialRevision ||
      !resolveDatabaseMutationTarget({
        connectorType: parsed.connectorType,
        config: source.config,
        target: {
          catalog: parsed.targetCatalog,
          schema: parsed.targetSchema,
          table: parsed.targetTable,
        },
      })
    ) {
      throw new SqlChangeConflictError();
    }

    const inserted = await transaction
      .insert(sqlChangeSets)
      .values({
        ...parsed,
        status: "pending_approval",
        expiresAt: sql`CURRENT_TIMESTAMP + interval '10 minutes'`,
      })
      .returning();
    if (!inserted[0]) throw new Error("SQL change-set insert returned no row.");
    return parseSqlChangeSet(inserted[0]);
  });
}
