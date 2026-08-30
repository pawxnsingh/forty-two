import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import {
  ChatSessionIdSchema,
  SqlChangeSetIdSchema,
} from "../../ids.js";
import {
  sqlChangeExecutions,
  sqlChangeSets,
} from "../../schema/sql-change-sets.js";
import type {
  SqlChangeExecution,
  SqlChangeSet,
} from "../../sql-change-types.js";
import { parseSqlChangeExecution, parseSqlChangeSet } from "./shared.js";

export const GetSqlChangeSetInputSchema = z
  .object({
    changeSetId: SqlChangeSetIdSchema,
    chatSessionId: ChatSessionIdSchema,
  })
  .strict();

export async function getSqlChangeSet(
  input: z.input<typeof GetSqlChangeSetInputSchema>,
): Promise<{
  changeSet: SqlChangeSet;
  execution: SqlChangeExecution | null;
} | null> {
  const parsed = GetSqlChangeSetInputSchema.parse(input);
  const rows = await getDatabase()
    .select({ changeSet: sqlChangeSets, execution: sqlChangeExecutions })
    .from(sqlChangeSets)
    .leftJoin(
      sqlChangeExecutions,
      eq(sqlChangeExecutions.changeSetId, sqlChangeSets.id),
    )
    .where(
      and(
        eq(sqlChangeSets.id, parsed.changeSetId),
        eq(sqlChangeSets.chatSessionId, parsed.chatSessionId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row
    ? {
        changeSet: parseSqlChangeSet(row.changeSet),
        execution: row.execution
          ? parseSqlChangeExecution(row.execution)
          : null,
      }
    : null;
}
