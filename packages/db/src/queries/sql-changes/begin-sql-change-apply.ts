import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import {
  ChatSessionIdSchema,
  DataSourceIdSchema,
  SqlChangeExecutionIdSchema,
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
import {
  sqlChangeExecutions,
  sqlChangeSets,
} from "../../schema/sql-change-sets.js";
import {
  SqlChangeOperationSchema,
  type SqlChangeSet,
} from "../../sql-change-types.js";
import {
  DatabaseConnectorTypeSchema,
  resolveDatabaseMutationTarget,
} from "../../types.js";
import {
  parseSqlChangeSet,
  SqlChangeConflictError,
  SqlChangeReplayError,
} from "./shared.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const BeginSqlChangeApplyInputSchema = z
  .object({
    executionId: SqlChangeExecutionIdSchema,
    changeSetId: SqlChangeSetIdSchema,
    chatSessionId: ChatSessionIdSchema,
    dataSourceId: DataSourceIdSchema,
    connectorType: DatabaseConnectorTypeSchema,
    operation: SqlChangeOperationSchema,
    targetCatalog: z.string().nullable(),
    targetSchema: z.string().nullable(),
    targetTable: z.string(),
    canonicalSql: z.string(),
    statementHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedAffectedRows: z.number().int().min(0).max(100),
    resourceEstimate: JsonObjectSchema.nullable(),
  })
  .strict();

export type BeginSqlChangeApplyInput = z.input<
  typeof BeginSqlChangeApplyInputSchema
>;

export type BeginSqlChangeApplyResult = {
  changeSet: SqlChangeSet;
  executionId: z.output<typeof SqlChangeExecutionIdSchema>;
  resumed: boolean;
};

type BeginResult =
  BeginSqlChangeApplyResult | { error: "expired" | "conflict" | "replay" };

export async function beginSqlChangeApply(
  input: BeginSqlChangeApplyInput,
): Promise<BeginSqlChangeApplyResult> {
  const parsed = BeginSqlChangeApplyInputSchema.parse(input);
  const result = await getDatabase().transaction<BeginResult>(
    async (transaction) => {
      const rows = await transaction
        .select({
          changeSet: sqlChangeSets,
          sourceStatus: dataSources.status,
          sourceDeletedAt: dataSources.deletedAt,
          sourceConfig: dataSources.config,
          credentialRevision: dataSourceCredentials.revision,
          sessionStatus: chatSessions.status,
          sessionDeletedAt: chatSessions.deletedAt,
          bindingDataSourceId: chatSessionDataSources.dataSourceId,
          executionId: sqlChangeExecutions.id,
          executionExecutedAt: sqlChangeExecutions.executedAt,
        })
        .from(sqlChangeSets)
        .innerJoin(
          chatSessions,
          eq(chatSessions.id, sqlChangeSets.chatSessionId),
        )
        .innerJoin(dataSources, eq(dataSources.id, sqlChangeSets.dataSourceId))
        .innerJoin(
          dataSourceCredentials,
          eq(dataSourceCredentials.dataSourceId, dataSources.id),
        )
        .leftJoin(
          chatSessionDataSources,
          and(
            eq(
              chatSessionDataSources.chatSessionId,
              sqlChangeSets.chatSessionId,
            ),
            eq(chatSessionDataSources.dataSourceId, sqlChangeSets.dataSourceId),
          ),
        )
        .leftJoin(
          sqlChangeExecutions,
          eq(sqlChangeExecutions.changeSetId, sqlChangeSets.id),
        )
        .where(
          and(
            eq(sqlChangeSets.id, parsed.changeSetId),
            eq(sqlChangeSets.chatSessionId, parsed.chatSessionId),
            eq(sqlChangeSets.dataSourceId, parsed.dataSourceId),
          ),
        )
        .limit(1)
        .for("update", { of: sqlChangeSets });
      const row = rows[0];
      if (!row || !approvalDisplayMatches(row.changeSet, parsed)) {
        return { error: "conflict" };
      }
      if (row.changeSet.status !== "pending_approval") {
        return { error: "replay" };
      }
      if (row.changeSet.expiresAt.getTime() <= Date.now()) {
        await transaction
          .update(sqlChangeSets)
          .set({ status: "expired", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(sqlChangeSets.id, parsed.changeSetId));
        return { error: "expired" };
      }
      if (
        row.sessionStatus !== "active" ||
        row.sessionDeletedAt ||
        row.sourceStatus !== "ready" ||
        row.sourceDeletedAt ||
        !row.bindingDataSourceId ||
        !resolveDatabaseMutationTarget({
          connectorType: DatabaseConnectorTypeSchema.parse(
            row.changeSet.connectorType,
          ),
          config: row.sourceConfig,
          target: {
            catalog: row.changeSet.targetCatalog,
            schema: row.changeSet.targetSchema,
            table: row.changeSet.targetTable,
          },
        }) ||
        row.credentialRevision !== row.changeSet.credentialRevision
      ) {
        await transaction
          .update(sqlChangeSets)
          .set({ status: "stale", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(sqlChangeSets.id, parsed.changeSetId));
        return { error: "conflict" };
      }
      if (row.executionId) {
        if (row.executionExecutedAt === null) {
          return {
            changeSet: parseSqlChangeSet(row.changeSet),
            executionId: SqlChangeExecutionIdSchema.parse(row.executionId),
            resumed: true,
          };
        }
        return { error: "replay" };
      }
      if (
        !row.changeSet.approvalTurnId ||
        !row.changeSet.approvalToolCallId ||
        !row.changeSet.approvalRecordedAt
      ) {
        return { error: "conflict" };
      }
      await transaction.insert(sqlChangeExecutions).values({
        id: parsed.executionId,
        changeSetId: parsed.changeSetId,
        trueforgeTurnId: row.changeSet.approvalTurnId,
        trueforgeToolCallId: row.changeSet.approvalToolCallId,
        verification: { phase: "started" },
      });
      return {
        changeSet: parseSqlChangeSet(row.changeSet),
        executionId: parsed.executionId,
        resumed: false,
      };
    },
  );
  if ("changeSet" in result) return result;
  if (result.error === "replay") throw new SqlChangeReplayError();
  if (result.error === "expired") {
    throw new SqlChangeConflictError("The SQL change set has expired.");
  }
  throw new SqlChangeConflictError();
}

function approvalDisplayMatches(
  stored: typeof sqlChangeSets.$inferSelect,
  input: z.output<typeof BeginSqlChangeApplyInputSchema>,
): boolean {
  return (
    stored.connectorType === input.connectorType &&
    stored.operation === input.operation &&
    stored.targetCatalog === input.targetCatalog &&
    stored.targetSchema === input.targetSchema &&
    stored.targetTable === input.targetTable &&
    stored.canonicalSql === input.canonicalSql &&
    stored.statementHash === input.statementHash &&
    stored.expectedAffectedRows === input.expectedAffectedRows &&
    stableJson(stored.resourceEstimate) === stableJson(input.resourceEstimate)
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
