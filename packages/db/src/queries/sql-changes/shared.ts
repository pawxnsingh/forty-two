import {
  SqlChangeExecutionSchema,
  SqlChangeSetSchema,
  type SqlChangeExecution,
  type SqlChangeSet,
} from "../../sql-change-types.js";
import type {
  SqlChangeExecutionRow,
  SqlChangeSetRow,
} from "../../schema/sql-change-sets.js";

export class SqlChangeConflictError extends Error {
  constructor(message = "The SQL change set is no longer applicable.") {
    super(message);
    this.name = "SqlChangeConflictError";
  }
}

export class SqlChangeReplayError extends Error {
  constructor() {
    super("The SQL change set has already been consumed.");
    this.name = "SqlChangeReplayError";
  }
}

export function parseSqlChangeSet(row: SqlChangeSetRow): SqlChangeSet {
  return SqlChangeSetSchema.parse(row);
}

export function parseSqlChangeExecution(
  row: SqlChangeExecutionRow,
): SqlChangeExecution {
  return SqlChangeExecutionSchema.parse(row);
}
