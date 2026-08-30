import {
  BoundedBackfillExpressionSchema,
  buildBigQueryBackfillScript,
  buildBigQueryRowMutationScript,
  isSqlChangePartialCommitError,
  normalizeSqlChangeTarget,
  parseSqlChange,
  StructuredColumnChangeSchema,
  StructuredColumnTypeSchema,
  sqlChangeStatementHash,
  splitStructuredCanonicalSql,
  type SqlChangeDialect,
  type StructuredColumnChange,
} from "@forty-two/data-source";
import {
  beginSqlChangeApply,
  completeSqlChangeApply,
  createSqlChangeSet,
  generateSqlChangeExecutionId,
  generateSqlChangeSetId,
  recordSqlChangeApplyProgress,
  SqlChangeOperationSchema,
  ChatSessionIdSchema,
  type ActiveChatSessionScope,
  type DatabaseConnectorType,
  type SqlChangeSet,
} from "@forty-two/db";
import { z } from "zod";

import type { ConnectionRegistry } from "./connection-registry.js";

const DataSourceIdSchema = z.string().regex(/^ds_[0-9A-HJKMNP-TV-Z]{26}$/);
const SqlIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
const StructuredTargetSchema = z
  .object({
    catalog: SqlIdentifierSchema.nullable().optional(),
    schema: SqlIdentifierSchema.nullable().optional(),
    table: SqlIdentifierSchema,
  })
  .strict();

const RowPrepareSchema = z
  .object({
    sessionId: ChatSessionIdSchema,
    dataSourceId: DataSourceIdSchema,
    operation: z.enum(["insert", "update", "delete"]),
    sql: z.string().trim().min(1).max(100_000),
    target: StructuredTargetSchema.optional(),
  })
  .strict();

const AddColumnPrepareSchema = z
  .object({
    sessionId: ChatSessionIdSchema,
    dataSourceId: DataSourceIdSchema,
    operation: z.literal("add_column"),
    target: StructuredTargetSchema,
    columnName: SqlIdentifierSchema,
    columnType: StructuredColumnTypeSchema,
  })
  .strict();
const RenameColumnPrepareSchema = z
  .object({
    sessionId: ChatSessionIdSchema,
    dataSourceId: DataSourceIdSchema,
    operation: z.literal("rename_column"),
    target: StructuredTargetSchema,
    sourceColumn: SqlIdentifierSchema,
    destinationColumn: SqlIdentifierSchema,
  })
  .strict();
const AddBackfillPrepareSchema = z
  .object({
    sessionId: ChatSessionIdSchema,
    dataSourceId: DataSourceIdSchema,
    operation: z.literal("add_and_backfill_column"),
    target: StructuredTargetSchema,
    columnName: SqlIdentifierSchema,
    columnType: StructuredColumnTypeSchema,
    expression: BoundedBackfillExpressionSchema,
  })
  .strict();

export const PrepareSqlChangeInputSchema = z.union([
  RowPrepareSchema,
  AddColumnPrepareSchema,
  RenameColumnPrepareSchema,
  AddBackfillPrepareSchema,
]);

// The MCP SDK can only publish an object-shaped input schema. Keep branch
// correlation authoritative in PrepareSqlChangeInputSchema and expose the
// complete strict field set here so clients receive a useful JSON Schema.
export const PrepareSqlChangeToolInputSchema = z
  .object({
    sessionId: ChatSessionIdSchema,
    dataSourceId: DataSourceIdSchema,
    operation: SqlChangeOperationSchema,
    sql: z.string().trim().min(1).max(100_000).optional(),
    target: StructuredTargetSchema.optional(),
    columnName: SqlIdentifierSchema.optional(),
    columnType: StructuredColumnTypeSchema.optional(),
    sourceColumn: SqlIdentifierSchema.optional(),
    destinationColumn: SqlIdentifierSchema.optional(),
    expression: BoundedBackfillExpressionSchema.optional(),
  })
  .strict();

const ResourceEstimateSchema = z.record(z.string(), z.unknown()).nullable();
const TargetDisplaySchema = z
  .object({
    catalog: z.string().nullable(),
    schema: z.string().nullable(),
    table: z.string(),
  })
  .strict();

export const ApplySqlChangeInputSchema = z
  .object({
    changeSetId: z.string().regex(/^change_[0-9A-HJKMNP-TV-Z]{26}$/),
    sessionId: ChatSessionIdSchema,
    dataSourceId: DataSourceIdSchema,
    connector: z.enum([
      "postgresql",
      "mysql",
      "sqlserver",
      "snowflake",
      "bigquery",
      "redshift",
    ]),
    operation: SqlChangeOperationSchema,
    target: TargetDisplaySchema,
    canonicalSql: z.string().min(1).max(100_000),
    statementHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedAffectedRows: z.number().int().min(0).max(100),
    resourceEstimate: ResourceEstimateSchema,
  })
  .strict();

export type PrepareSqlChangeInput = z.input<typeof PrepareSqlChangeInputSchema>;
export type ApplySqlChangeInput = z.input<typeof ApplySqlChangeInputSchema>;

export class SqlChangeService {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly scope: ActiveChatSessionScope,
  ) {}

  async prepare(input: unknown) {
    const parsed = PrepareSqlChangeInputSchema.parse(input);
    this.requireSession(parsed.sessionId);
    this.requireBound(parsed.dataSourceId);
    const connection = await this.registry.get(parsed.dataSourceId);
    const mutation = connection.mutation;
    if (!mutation || mutation.mode !== "controlled") {
      throw new Error("Controlled mutations are disabled for this datasource.");
    }
    const dialect = dialectFor(mutation.connectorType);
    const requestedTarget = isRowPrepare(parsed)
      ? normalizeSqlChangeTarget(
          parseSqlChange(parsed.sql, dialect).target,
          dialect,
        )
      : StructuredColumnChangeSchema.parse(stripScope(parsed)).target;
    const allowedRequestedTarget = requireAllowedTarget(
      requestedTarget,
      mutation,
    );
    if (isRowPrepare(parsed) && parsed.target) {
      const allowedDeclaredTarget = requireAllowedTarget(
        {
          catalog: parsed.target.catalog ?? null,
          schema: parsed.target.schema ?? null,
          table: parsed.target.table,
        },
        mutation,
      );
      requireMatchingMutationTarget(
        allowedRequestedTarget,
        allowedDeclaredTarget,
      );
    }
    const rowLimit = maximumRows();
    const preparationMaximumBytesBilled =
      mutation.connectorType === "bigquery"
        ? maximumBigQueryBytesBilled()
        : undefined;
    const prepared = isRowPrepare(parsed)
      ? await this.registry.dataSource.prepareSqlChange({
          dataSource: parsed.dataSourceId,
          sql: parsed.sql,
          dialect,
          timeout: connection.policy.queryTimeoutMs,
          maxRows: rowLimit,
          maximumBytesBilled: preparationMaximumBytesBilled,
        })
      : await this.registry.dataSource.prepareColumnChange({
          dataSource: parsed.dataSourceId,
          dialect,
          change: StructuredColumnChangeSchema.parse(stripScope(parsed)),
          timeout: connection.policy.queryTimeoutMs,
          maxRows: rowLimit,
          maximumBytesBilled: preparationMaximumBytesBilled,
        });
    if (isRowPrepare(parsed) && prepared.operation !== parsed.operation) {
      throw new Error("Declared SQL operation does not match parsed SQL.");
    }
    const target = requireAllowedTarget(prepared.target, mutation);
    const maximumBytesBilled = assertPreparedResourceEstimate(
      mutation.connectorType,
      prepared.operation,
      prepared.resourceEstimate,
    );
    const statementHash = sqlChangeStatementHash({
      dialect,
      canonicalSql: prepared.canonicalSql,
      boundParameters: prepared.boundParameters,
    });
    const changeSetId = generateSqlChangeSetId();
    const stored = await createSqlChangeSet({
      id: changeSetId,
      chatSessionId: this.scope.chatSessionId,
      dataSourceId: parsed.dataSourceId,
      connectorType: mutation.connectorType,
      sqlDialect: dialect,
      operation: prepared.operation,
      targetCatalog: target.catalog,
      targetSchema: target.schema,
      targetTable: target.table,
      canonicalSql: prepared.canonicalSql,
      boundParameters: prepared.boundParameters,
      structuredOperation:
        "structuredOperation" in prepared ? prepared.structuredOperation : null,
      statementHash,
      preview: prepared.preview,
      preconditions: prepared.preconditions,
      executionStrategy: {
        ...prepared.executionStrategy,
        targetSql: prepared.target.sql,
        rowLimit,
        ...(maximumBytesBilled ? { maximumBytesBilled } : {}),
      },
      resourceEstimate: prepared.resourceEstimate,
      expectedAffectedRows: prepared.expectedAffectedRows,
      credentialRevision: mutation.credentialRevision,
    });
    return {
      changeSetId: stored.id,
      status: stored.status,
      expiresAt: stored.expiresAt.toISOString(),
      preview: stored.preview,
      approval: approvalDisplay(stored),
    };
  }

  async apply(input: ApplySqlChangeInput) {
    const parsed = ApplySqlChangeInputSchema.parse(input);
    this.requireSession(parsed.sessionId);
    this.requireBound(parsed.dataSourceId);
    const connection = await this.registry.get(parsed.dataSourceId);
    const mutation = connection.mutation;
    if (!mutation || mutation.mode !== "controlled") {
      throw new Error("Controlled mutations are disabled for this datasource.");
    }
    requireAllowedTarget(parsed.target, mutation);
    let executionId = generateSqlChangeExecutionId();
    let changeSet: SqlChangeSet | undefined;
    let plannedProviderPhases: Record<string, unknown> = {};
    try {
      const begun = await beginSqlChangeApply({
        executionId,
        changeSetId: parsed.changeSetId,
        chatSessionId: this.scope.chatSessionId,
        dataSourceId: parsed.dataSourceId,
        connectorType: parsed.connector,
        operation: parsed.operation,
        targetCatalog: parsed.target.catalog,
        targetSchema: parsed.target.schema,
        targetTable: parsed.target.table,
        canonicalSql: parsed.canonicalSql,
        statementHash: parsed.statementHash,
        expectedAffectedRows: parsed.expectedAffectedRows,
        resourceEstimate: parsed.resourceEstimate,
      });
      changeSet = begun.changeSet;
      executionId = begun.executionId;
      plannedProviderPhases = providerPhaseEvidence(changeSet, executionId);
      if (Object.keys(plannedProviderPhases).length > 0) {
        await recordSqlChangeApplyProgress({
          executionId,
          changeSetId: changeSet.id,
          verification: { phase: "started", ...plannedProviderPhases },
          errorCode: null,
        });
      }
      const rowLimit = assertCurrentRowLimit(changeSet.expectedAffectedRows);
      const maximumBytesBilled = await this.revalidateResourceEstimate(
        changeSet,
        connection.policy.queryTimeoutMs,
      );
      const result = changeSet.structuredOperation
        ? await this.applyColumnChange(
            changeSet,
            executionId,
            rowLimit,
            maximumBytesBilled,
            connection.policy.queryTimeoutMs,
          )
        : await this.applyRowChange(
            changeSet,
            executionId,
            rowLimit,
            maximumBytesBilled,
            connection.policy.queryTimeoutMs,
          );
      const completed = await completeSqlChangeApply({
        executionId,
        changeSetId: changeSet.id,
        outcome: "applied",
        providerExecutionId: result.providerExecutionId,
        actualAffectedRows: result.rowCount,
        verification: {
          ...plannedProviderPhases,
          ...result.verification,
          phase: "verified",
        },
        errorCode: null,
      });
      return {
        changeSetId: completed.changeSet.id,
        status: completed.changeSet.status,
        affectedRows: completed.execution.actualAffectedRows,
        providerExecutionId: completed.execution.providerExecutionId,
        audit: {
          executionId: completed.execution.id,
          trueforgeTurnId: completed.execution.trueforgeTurnId,
          trueforgeToolCallId: completed.execution.trueforgeToolCallId,
          executedAt: completed.execution.executedAt?.toISOString() ?? null,
        },
      };
    } catch (error) {
      if (changeSet) {
        const partial = isSqlChangePartialCommitError(error);
        const isStale =
          error instanceof Error && error.name === "SqlChangeStaleError";
        const resumable = isResumableSqlChangeError(error);
        if (partial) {
          await completeSqlChangeApply({
            executionId,
            changeSetId: changeSet.id,
            outcome: "partial",
            providerExecutionId: error.providerExecutionId,
            actualAffectedRows: null,
            verification: {
              ...plannedProviderPhases,
              ...error.verification,
              phase: "partial_ddl_committed",
              terminal: true,
              freshApprovalRequired: true,
            },
            errorCode: error.name,
          }).catch(() => undefined);
        } else if (resumable) {
          await recordSqlChangeApplyProgress({
            executionId,
            changeSetId: changeSet.id,
            verification: {
              phase: "resume_required",
              ...plannedProviderPhases,
            },
            errorCode: error instanceof Error ? error.name : "UNKNOWN",
          }).catch(() => undefined);
        } else {
          await completeSqlChangeApply({
            executionId,
            changeSetId: changeSet.id,
            outcome: isStale ? "stale" : "failed",
            providerExecutionId: null,
            actualAffectedRows: null,
            verification: { phase: "failed", ...plannedProviderPhases },
            errorCode: error instanceof Error ? error.name : "UNKNOWN",
          }).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private async applyRowChange(
    changeSet: SqlChangeSet,
    executionId: string,
    maximumRows: number,
    maximumBytesBilled: string | undefined,
    timeout: number,
  ) {
    const preconditions = rowPreconditions(changeSet.preconditions);
    const targetSql = stringProperty(changeSet.executionStrategy, "targetSql");
    return this.registry.dataSource.applySqlChange(changeSet.dataSourceId, {
      targetSql,
      canonicalSql: changeSet.canonicalSql,
      params: [],
      operation: changeSet.operation as "insert" | "update" | "delete",
      preconditionSql: preconditions.selectSql,
      preconditionParams: preconditions.params,
      expectedAffectedRows: changeSet.expectedAffectedRows,
      expectedRowHashes: preconditions.rowHashes,
      maximumRows,
      timeout,
      executionToken: executionId,
      ...(maximumBytesBilled ? { maximumBytesBilled } : {}),
      ...(preconditions.providerPrecondition
        ? { providerPrecondition: preconditions.providerPrecondition }
        : {}),
    });
  }

  private async applyColumnChange(
    changeSet: SqlChangeSet,
    executionId: string,
    maximumRows: number,
    maximumBytesBilled: string | undefined,
    timeout: number,
  ) {
    const structured = StructuredColumnChangeSchema.parse(
      changeSet.structuredOperation,
    );
    const schemaFingerprint = stringProperty(
      changeSet.preconditions,
      "schemaFingerprint",
    );
    const preconditions = columnPreconditions(changeSet.preconditions);
    return this.registry.dataSource.applyColumnChange({
      dataSource: changeSet.dataSourceId,
      dialect: changeSet.sqlDialect,
      change: structured,
      canonicalSql: changeSet.canonicalSql,
      expectedSchemaFingerprint: schemaFingerprint,
      expectedAffectedRows: changeSet.expectedAffectedRows,
      maximumRows,
      timeout,
      preconditionSql: preconditions.selectSql,
      verificationSql: preconditions.verificationSql,
      expectedRowHashes: preconditions.rowHashes,
      expectedPreconditionRowHashes: preconditions.preconditionRowHashes,
      ...(preconditions.providerPrecondition
        ? { providerPrecondition: preconditions.providerPrecondition }
        : {}),
      executionToken: executionId,
      ...(maximumBytesBilled ? { maximumBytesBilled } : {}),
      ddlAlreadyCommitted:
        changeSet.executionStrategy.ddlAlreadyCommitted === true,
    });
  }

  private async revalidateResourceEstimate(
    changeSet: SqlChangeSet,
    timeout: number,
  ): Promise<string | undefined> {
    if (changeSet.connectorType !== "bigquery") return undefined;
    const mutationSql = bigQueryApplyScript(changeSet);
    if (!mutationSql) return undefined;
    const current = await this.registry.dataSource.estimateSqlChange({
      dataSource: changeSet.dataSourceId,
      canonicalSql: mutationSql,
      timeout,
    });
    return assertBigQueryApplyCost({
      approved: changeSet.resourceEstimate,
      current,
    });
  }

  private requireBound(dataSourceId: string): void {
    const source = this.scope.dataSources.find(
      (candidate) => candidate.id === dataSourceId,
    );
    if (
      !source ||
      source.connectorType === "csv" ||
      source.connectorType === "xlsx"
    ) {
      throw new Error(`Data source '${dataSourceId}' is not available`);
    }
  }

  private requireSession(sessionId: string): void {
    if (sessionId !== this.scope.chatSessionId) {
      throw new Error(`Session '${sessionId}' is not active`);
    }
  }
}

export function providerPhaseEvidence(
  changeSet: SqlChangeSet,
  executionId: string,
): Record<string, unknown> {
  if (changeSet.connectorType !== "bigquery") return {};
  if (!changeSet.structuredOperation) {
    return { providerJobIds: { mutation: `${executionId}_row` } };
  }
  return {
    providerJobIds: {
      ddl: `${executionId}_ddl`,
      ...(changeSet.operation === "add_and_backfill_column"
        ? { backfill: `${executionId}_backfill` }
        : {}),
      resume: `${executionId}_resume`,
    },
  };
}

function approvalDisplay(changeSet: SqlChangeSet) {
  return {
    changeSetId: changeSet.id,
    sessionId: changeSet.chatSessionId,
    dataSourceId: changeSet.dataSourceId,
    connector: changeSet.connectorType,
    operation: changeSet.operation,
    target: {
      catalog: changeSet.targetCatalog,
      schema: changeSet.targetSchema,
      table: changeSet.targetTable,
    },
    canonicalSql: changeSet.canonicalSql,
    statementHash: changeSet.statementHash,
    expectedAffectedRows: changeSet.expectedAffectedRows,
    resourceEstimate: changeSet.resourceEstimate,
  };
}

function isRowPrepare(
  input: z.output<typeof PrepareSqlChangeInputSchema>,
): input is z.output<typeof RowPrepareSchema> {
  return ["insert", "update", "delete"].includes(input.operation);
}

function stripScope(
  input: Exclude<
    z.output<typeof PrepareSqlChangeInputSchema>,
    z.output<typeof RowPrepareSchema>
  >,
): StructuredColumnChange {
  const { sessionId, dataSourceId, ...change } = input;
  ChatSessionIdSchema.parse(sessionId);
  DataSourceIdSchema.parse(dataSourceId);
  return StructuredColumnChangeSchema.parse(change);
}

function dialectFor(connector: DatabaseConnectorType): SqlChangeDialect {
  return connector === "sqlserver"
    ? "transactsql"
    : connector === "redshift"
      ? "redshift"
      : connector;
}

export function requireAllowedTarget(
  target: {
    catalog: string | null;
    schema: string | null;
    table: string;
    sql?: string;
  },
  mutation: NonNullable<
    Awaited<ReturnType<ConnectionRegistry["get"]>>["mutation"]
  >,
): { catalog: string | null; schema: string | null; table: string } {
  const quoted = qualifiedTargetQuoteFlags(target.sql);
  const matches = (
    allowed: string | null,
    requested: string | null,
    isQuoted: boolean,
  ) =>
    requested === null ||
    (isQuoted
      ? allowed === requested
      : allowed?.toLowerCase() === requested.toLowerCase());
  const candidates = mutation.allowedTargets.filter(
    (candidate) =>
      matches(candidate.table, target.table, quoted.table) &&
      matches(candidate.catalog, target.catalog, quoted.catalog) &&
      matches(candidate.schema, target.schema, quoted.schema),
  );
  if (candidates.length !== 1) {
    throw new Error(
      "Mutation target is outside the configured table allowlist.",
    );
  }
  const allowed = candidates[0];
  if (!allowed) {
    throw new Error(
      "Mutation target is outside the configured table allowlist.",
    );
  }
  return allowed;
}

export function requireMatchingMutationTarget(
  sqlTarget: { catalog: string | null; schema: string | null; table: string },
  declaredTarget: {
    catalog: string | null;
    schema: string | null;
    table: string;
  },
): void {
  if (
    sqlTarget.catalog !== declaredTarget.catalog ||
    sqlTarget.schema !== declaredTarget.schema ||
    sqlTarget.table !== declaredTarget.table
  ) {
    throw new Error("Declared mutation target does not match the SQL target.");
  }
}

function qualifiedTargetQuoteFlags(sql: string | undefined): {
  catalog: boolean;
  schema: boolean;
  table: boolean;
} {
  if (!sql) return { catalog: false, schema: false, table: false };
  const parts: string[] = [];
  let part = "";
  let closingQuote: '"' | "`" | "]" | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (closingQuote) {
      part += character;
      if (character === closingQuote) {
        if (sql[index + 1] === closingQuote) {
          part += sql[++index]!;
        } else {
          closingQuote = undefined;
        }
      }
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      closingQuote = character === "[" ? "]" : character;
      part += character;
      continue;
    }
    if (character === ".") {
      parts.push(part.trim());
      part = "";
      continue;
    }
    part += character;
  }
  parts.push(part.trim());
  const flags = parts.map((value) => /^["`\[]/.test(value));
  return parts.length === 3
    ? { catalog: flags[0]!, schema: flags[1]!, table: flags[2]! }
    : parts.length === 2
      ? { catalog: false, schema: flags[0]!, table: flags[1]! }
      : { catalog: false, schema: false, table: flags[0] ?? false };
}

function rowPreconditions(value: Record<string, unknown>): {
  selectSql: string;
  params: [];
  rowHashes: string[];
  providerPrecondition?: {
    kind: "bigquery_row_json";
    values: string[];
  };
} {
  const selectSql = stringProperty(value, "selectSql");
  const rowHashes = value.rowHashes;
  if (
    !Array.isArray(rowHashes) ||
    rowHashes.some((hash) => typeof hash !== "string")
  ) {
    throw new Error("Stored SQL change preconditions are invalid.");
  }
  const provider = value.providerPrecondition;
  if (provider !== undefined) {
    if (
      !provider ||
      typeof provider !== "object" ||
      !("kind" in provider) ||
      provider.kind !== "bigquery_row_json" ||
      !("values" in provider) ||
      !Array.isArray(provider.values) ||
      provider.values.some((item) => typeof item !== "string")
    ) {
      throw new Error("Stored SQL change provider precondition is invalid.");
    }
    return {
      selectSql,
      params: [],
      rowHashes,
      providerPrecondition: {
        kind: "bigquery_row_json",
        values: provider.values as string[],
      },
    };
  }
  return { selectSql, params: [], rowHashes };
}

function columnPreconditions(value: Record<string, unknown>): {
  selectSql: string | null;
  verificationSql: string | null;
  rowHashes: string[];
  preconditionRowHashes?: string[];
  providerPrecondition?: {
    kind: "bigquery_row_json";
    values: string[];
  };
} {
  const selectSql = nullableStringProperty(value, "selectSql");
  const verificationSql = nullableStringProperty(value, "verificationSql");
  const rowHashes = value.rowHashes;
  const preconditionRowHashes = value.preconditionRowHashes;
  if (
    !Array.isArray(rowHashes) ||
    rowHashes.some((hash) => typeof hash !== "string") ||
    (preconditionRowHashes !== undefined &&
      (!Array.isArray(preconditionRowHashes) ||
        preconditionRowHashes.some((hash) => typeof hash !== "string")))
  ) {
    throw new Error("Stored column-change preconditions are invalid.");
  }
  const provider = value.providerPrecondition;
  if (provider === undefined) {
    return {
      selectSql,
      verificationSql,
      rowHashes,
      ...(preconditionRowHashes
        ? { preconditionRowHashes: preconditionRowHashes as string[] }
        : {}),
    };
  }
  if (
    !provider ||
    typeof provider !== "object" ||
    !("kind" in provider) ||
    provider.kind !== "bigquery_row_json" ||
    !("values" in provider) ||
    !Array.isArray(provider.values) ||
    provider.values.some((item) => typeof item !== "string")
  ) {
    throw new Error("Stored column-change provider precondition is invalid.");
  }
  return {
    selectSql,
    verificationSql,
    rowHashes,
    ...(preconditionRowHashes
      ? { preconditionRowHashes: preconditionRowHashes as string[] }
      : {}),
    providerPrecondition: {
      kind: "bigquery_row_json",
      values: provider.values as string[],
    },
  };
}

function bigQueryApplyScript(changeSet: SqlChangeSet): string | null {
  if (!changeSet.structuredOperation) {
    const preconditions = rowPreconditions(changeSet.preconditions);
    if (!preconditions.providerPrecondition) {
      throw new Error("Stored BigQuery row precondition is unavailable.");
    }
    return buildBigQueryRowMutationScript({
      preconditionSql: preconditions.selectSql,
      mutationSql: changeSet.canonicalSql,
      expectedRows: preconditions.providerPrecondition.values,
      expectedAffectedRows: changeSet.expectedAffectedRows,
    });
  }
  if (changeSet.operation !== "add_and_backfill_column") return null;
  const preconditions = columnPreconditions(changeSet.preconditions);
  if (
    !preconditions.selectSql ||
    !preconditions.verificationSql ||
    !preconditions.providerPrecondition
  ) {
    throw new Error("Stored BigQuery backfill preconditions are unavailable.");
  }
  const phases = splitStructuredCanonicalSql({
    operation: "add_and_backfill_column",
    canonicalSql: changeSet.canonicalSql,
  });
  if (!phases.backfillSql) {
    throw new Error("Stored BigQuery backfill SQL is unavailable.");
  }
  return buildBigQueryBackfillScript({
    preconditionSql: preconditions.selectSql,
    backfillSql: phases.backfillSql,
    verificationSql: preconditions.verificationSql,
    expectedRows: preconditions.providerPrecondition.values,
    expectedAffectedRows: changeSet.expectedAffectedRows,
  });
}

function nullableStringProperty(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const result = value[key];
  if (result !== null && (typeof result !== "string" || !result)) {
    throw new Error("Stored SQL change preconditions are invalid.");
  }
  return result;
}

function stringProperty(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result) {
    throw new Error("Stored SQL change strategy is invalid.");
  }
  return result;
}

function maximumRows(): number {
  const value = Number(process.env.SQL_CHANGE_MAX_ROWS ?? 100);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("SQL_CHANGE_MAX_ROWS must be an integer from 1 to 100.");
  }
  return value;
}

export function assertCurrentRowLimit(expectedAffectedRows: number): number {
  const rowLimit = maximumRows();
  if (expectedAffectedRows > rowLimit) {
    const error = new Error("SQL change exceeds the current row limit.");
    error.name = "SqlChangeStaleError";
    throw error;
  }
  return rowLimit;
}

export function isResumableSqlChangeError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "SqlChangeResumeRequiredError"
  );
}

export function maximumBigQueryBytesBilled(): string {
  const value =
    process.env.SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED ?? "1000000000";
  if (!/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error(
      "SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED must be a positive integer string.",
    );
  }
  return value;
}

export function assertPreparedResourceEstimate(
  connector: DatabaseConnectorType,
  operation: z.output<typeof SqlChangeOperationSchema>,
  estimate: Record<string, unknown> | null,
): string | undefined {
  if (
    connector !== "bigquery" ||
    !["insert", "update", "delete", "add_and_backfill_column"].includes(
      operation,
    )
  ) {
    return undefined;
  }
  const bytes = assertBigQueryWorkflowEstimate(estimate);
  const maximum = maximumBigQueryBytesBilled();
  if (bytes > BigInt(maximum)) {
    throw new Error("SQL change exceeds the configured BigQuery cost limit.");
  }
  return maximum;
}

function bigQueryEstimateBytes(
  estimate: Record<string, unknown> | null,
  key:
    | "dryRunBytesProcessed"
    | "workflowBytesProcessed"
    | "previewBytesProcessed"
    | "transactionBytesProcessed",
): bigint {
  const value = estimate?.[key];
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error("BigQuery mutation cost evidence is unavailable.");
  }
  return BigInt(value);
}

function assertBigQueryWorkflowEstimate(
  estimate: Record<string, unknown> | null,
): bigint {
  const total = bigQueryEstimateBytes(estimate, "dryRunBytesProcessed");
  const workflow = bigQueryEstimateBytes(estimate, "workflowBytesProcessed");
  const preview = bigQueryEstimateBytes(estimate, "previewBytesProcessed");
  const transaction = bigQueryEstimateBytes(
    estimate,
    "transactionBytesProcessed",
  );
  if (total !== workflow || preview + transaction > workflow) {
    throw new Error("BigQuery workflow cost evidence is inconsistent.");
  }
  const paidJobs = estimate?.paidReadJobBytesProcessed;
  if (
    !Array.isArray(paidJobs) ||
    paidJobs.length === 0 ||
    paidJobs.some(
      (value) => typeof value !== "string" || !/^[0-9]+$/.test(value),
    ) ||
    paidJobs.reduce((sum, value) => sum + BigInt(String(value)), 0n) !== preview
  ) {
    throw new Error("BigQuery paid-read cost evidence is inconsistent.");
  }
  return workflow;
}

function staleResourceEstimateError(): Error {
  const error = new Error("SQL change resource estimate is stale.");
  error.name = "SqlChangeStaleError";
  return error;
}

export function assertBigQueryApplyCost(input: {
  approved: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
}): string {
  const approvedBytes = assertBigQueryWorkflowEstimate(input.approved);
  const approvedTransactionBytes = bigQueryEstimateBytes(
    input.approved,
    "transactionBytesProcessed",
  );
  const currentBytes = bigQueryEstimateBytes(
    input.current,
    "dryRunBytesProcessed",
  );
  const configuredMaximum = BigInt(maximumBigQueryBytesBilled());
  if (
    approvedBytes > configuredMaximum ||
    currentBytes > approvedTransactionBytes ||
    currentBytes > configuredMaximum
  ) {
    throw staleResourceEstimateError();
  }
  return approvedTransactionBytes > 0n
    ? approvedTransactionBytes.toString()
    : "1";
}
