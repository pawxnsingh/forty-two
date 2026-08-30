import type { QueryParameter } from "../types/query.js";

export type SqlChangeOperation = "insert" | "update" | "delete";
export type SqlChangeDialect =
  | "postgresql"
  | "mysql"
  | "transactsql"
  | "snowflake"
  | "bigquery"
  | "redshift";

export type SqlChangeTarget = {
  catalog: string | null;
  schema: string | null;
  table: string;
  sql: string;
};

export type ParsedSqlChange = {
  dialect: SqlChangeDialect;
  operation: SqlChangeOperation;
  target: SqlChangeTarget;
  canonicalSql: string;
  boundParameters: Array<{
    position: number;
    type: "null" | "boolean" | "number" | "string";
    value: null | boolean | number | string;
  }>;
  whereSql: string | null;
  assignments: Record<string, QueryParameter>;
  insertValues: Record<string, QueryParameter> | null;
};

export type PreparedSqlChange = ParsedSqlChange & {
  expectedAffectedRows: number;
  preview: {
    before: Record<string, unknown>[];
    after: Record<string, unknown>[];
    identityColumns: string[];
    identities: Record<string, unknown>[];
  };
  preconditions: {
    selectSql: string;
    params: QueryParameter[];
    rowHashes: string[];
    identityColumns: string[];
    providerPrecondition?: {
      kind: "bigquery_row_json";
      values: string[];
      verificationValues?: string[];
    };
  };
  executionStrategy: {
    connector: string;
    atomicUnit: string;
    locking: string;
  };
  resourceEstimate: Record<string, unknown> | null;
};

export type ApplyControlledMutationInput = {
  targetSql: string;
  canonicalSql: string;
  params: QueryParameter[];
  operation: SqlChangeOperation;
  preconditionSql: string;
  preconditionParams: QueryParameter[];
  expectedAffectedRows: number;
  expectedRowHashes: string[];
  maximumRows: number;
  executionToken: string;
  maximumBytesBilled?: string;
  providerPrecondition?: {
    kind: "bigquery_row_json";
    values: string[];
  };
  timeout?: number;
};

export type ApplyControlledMutationResult = {
  rowCount: number;
  providerExecutionId: string;
  verification: Record<string, unknown>;
};

export type SqlChangePartialCommitVerification = {
  phase: "partial_ddl_committed";
  ddlCommitted: true;
  terminal: true;
  freshApprovalRequired: true;
  [key: string]: unknown;
};

export class SqlChangePartialCommitError extends Error {
  override readonly name = "SqlChangePartialCommitError";

  constructor(
    message: string,
    readonly providerExecutionId: string,
    readonly verification: SqlChangePartialCommitVerification,
  ) {
    super(message);
  }
}

export function isSqlChangePartialCommitError(
  error: unknown,
): error is SqlChangePartialCommitError {
  return error instanceof SqlChangePartialCommitError;
}
