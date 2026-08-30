import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import {
  SqlChangeExecutionIdSchema,
  SqlChangeSetIdSchema,
} from "../../ids.js";
import { sqlChangeExecutions } from "../../schema/sql-change-sets.js";
import { parseSqlChangeExecution, SqlChangeConflictError } from "./shared.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const RecordSqlChangeApplyProgressInputSchema = z
  .object({
    executionId: SqlChangeExecutionIdSchema,
    changeSetId: SqlChangeSetIdSchema,
    verification: JsonObjectSchema,
    errorCode: z.string().trim().min(1).max(255).nullable(),
  })
  .strict();

export async function recordSqlChangeApplyProgress(
  input: z.input<typeof RecordSqlChangeApplyProgressInputSchema>,
) {
  const parsed = RecordSqlChangeApplyProgressInputSchema.parse(input);
  const rows = await getDatabase()
    .update(sqlChangeExecutions)
    .set({ verification: parsed.verification, errorCode: parsed.errorCode })
    .where(
      and(
        eq(sqlChangeExecutions.id, parsed.executionId),
        eq(sqlChangeExecutions.changeSetId, parsed.changeSetId),
        isNull(sqlChangeExecutions.executedAt),
      ),
    )
    .returning();
  if (!rows[0]) {
    throw new SqlChangeConflictError("Execution audit is unavailable.");
  }
  return parseSqlChangeExecution(rows[0]);
}
