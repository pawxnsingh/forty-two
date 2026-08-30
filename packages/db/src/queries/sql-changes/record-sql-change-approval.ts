import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import { ChatSessionIdSchema, SqlChangeSetIdSchema } from "../../ids.js";
import {
  sqlChangeExecutions,
  sqlChangeSets,
} from "../../schema/sql-change-sets.js";
import { parseSqlChangeSet, SqlChangeConflictError } from "./shared.js";

export const RecordSqlChangeApprovalInputSchema = z
  .object({
    changeSetId: SqlChangeSetIdSchema,
    chatSessionId: ChatSessionIdSchema,
    trueforgeTurnId: z.string().trim().min(1).max(255),
    trueforgeToolCallId: z.string().trim().min(1).max(255),
    decision: z.enum(["allow", "deny"]),
  })
  .strict();

export async function recordSqlChangeApproval(
  input: z.input<typeof RecordSqlChangeApprovalInputSchema>,
) {
  const parsed = RecordSqlChangeApprovalInputSchema.parse(input);
  const rows = await getDatabase()
    .update(sqlChangeSets)
    .set({
      status: parsed.decision === "deny" ? "denied" : "pending_approval",
      approvalTurnId: parsed.trueforgeTurnId,
      approvalToolCallId: parsed.trueforgeToolCallId,
      approvalRecordedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(sqlChangeSets.id, parsed.changeSetId),
        eq(sqlChangeSets.chatSessionId, parsed.chatSessionId),
        eq(sqlChangeSets.status, "pending_approval"),
        isNull(sqlChangeSets.approvalRecordedAt),
        sql`${sqlChangeSets.expiresAt} > CURRENT_TIMESTAMP`,
        notExists(
          getDatabase()
            .select({ value: sqlChangeExecutions.id })
            .from(sqlChangeExecutions)
            .where(eq(sqlChangeExecutions.changeSetId, sqlChangeSets.id)),
        ),
      ),
    )
    .returning();
  if (rows[0]) return parseSqlChangeSet(rows[0]);
  const existingRows = await getDatabase()
    .select()
    .from(sqlChangeSets)
    .where(
      and(
        eq(sqlChangeSets.id, parsed.changeSetId),
        eq(sqlChangeSets.chatSessionId, parsed.chatSessionId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (
    existing &&
    existing.approvalTurnId === parsed.trueforgeTurnId &&
    existing.approvalToolCallId === parsed.trueforgeToolCallId &&
    existing.approvalRecordedAt &&
    ((parsed.decision === "allow" && existing.status === "pending_approval") ||
      (parsed.decision === "deny" && existing.status === "denied"))
  ) {
    return parseSqlChangeSet(existing);
  }
  throw new SqlChangeConflictError("Approval state is unavailable.");
}
