import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import { SqlChangeExecutionIdSchema, SqlChangeSetIdSchema } from "../../ids.js";
import {
  sqlChangeExecutions,
  sqlChangeSets,
} from "../../schema/sql-change-sets.js";
import {
  parseSqlChangeExecution,
  parseSqlChangeSet,
  SqlChangeConflictError,
} from "./shared.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());
const PartialVerificationSchema = z
  .object({
    phase: z.literal("partial_ddl_committed"),
    ddlCommitted: z.literal(true),
    terminal: z.literal(true),
    freshApprovalRequired: z.literal(true),
    resumable: z.never().optional(),
    requiresFreshApproval: z.never().optional(),
  })
  .loose();

export const CompleteSqlChangeApplyInputSchema = z
  .object({
    executionId: SqlChangeExecutionIdSchema,
    changeSetId: SqlChangeSetIdSchema,
    outcome: z.enum(["applied", "stale", "partial", "failed"]),
    providerExecutionId: z.string().trim().min(1).max(1024).nullable(),
    actualAffectedRows: z.number().int().min(0).max(100).nullable(),
    verification: JsonObjectSchema,
    errorCode: z.string().trim().min(1).max(255).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.outcome === "applied" &&
      (value.providerExecutionId === null || value.actualAffectedRows === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Applied executions require provider evidence.",
      });
    }
    if (
      value.outcome === "partial" &&
      (value.providerExecutionId === null ||
        value.actualAffectedRows !== null ||
        value.errorCode !== "SqlChangePartialCommitError" ||
        !PartialVerificationSchema.safeParse(value.verification).success)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Partial executions require terminal provider-evidenced fresh-approval state.",
      });
    }
    if (
      value.outcome !== "partial" &&
      value.errorCode === "SqlChangePartialCommitError"
    ) {
      context.addIssue({
        code: "custom",
        message: "Partial error evidence requires a partial outcome.",
      });
    }
  });

export async function completeSqlChangeApply(
  input: z.input<typeof CompleteSqlChangeApplyInputSchema>,
) {
  const parsed = CompleteSqlChangeApplyInputSchema.parse(input);
  return getDatabase().transaction(async (transaction) => {
    const rows = await transaction
      .select({ changeSet: sqlChangeSets, execution: sqlChangeExecutions })
      .from(sqlChangeExecutions)
      .innerJoin(
        sqlChangeSets,
        eq(sqlChangeSets.id, sqlChangeExecutions.changeSetId),
      )
      .where(
        and(
          eq(sqlChangeExecutions.id, parsed.executionId),
          eq(sqlChangeExecutions.changeSetId, parsed.changeSetId),
          isNull(sqlChangeExecutions.executedAt),
        ),
      )
      .limit(1)
      .for("update", { of: sqlChangeExecutions });
    const row = rows[0];
    if (!row)
      throw new SqlChangeConflictError("Execution audit is unavailable.");
    if (
      parsed.outcome === "applied" &&
      parsed.actualAffectedRows !== row.changeSet.expectedAffectedRows
    ) {
      throw new SqlChangeConflictError("Affected-row verification failed.");
    }
    const executionRows = await transaction
      .update(sqlChangeExecutions)
      .set({
        providerExecutionId: parsed.providerExecutionId,
        actualAffectedRows: parsed.actualAffectedRows,
        outcome: parsed.outcome,
        verification: parsed.verification,
        errorCode: parsed.errorCode,
        executedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(sqlChangeExecutions.id, parsed.executionId))
      .returning();
    const changeRows = await transaction
      .update(sqlChangeSets)
      .set({ status: parsed.outcome, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(sqlChangeSets.id, parsed.changeSetId))
      .returning();
    if (!executionRows[0] || !changeRows[0]) {
      throw new Error("SQL change completion returned no rows.");
    }
    return {
      changeSet: parseSqlChangeSet(changeRows[0]),
      execution: parseSqlChangeExecution(executionRows[0]),
    };
  });
}
