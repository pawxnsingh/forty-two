import { createHash } from "node:crypto";

import { z } from "zod";

import type { DatabaseAdapter } from "../adapters/base.js";
import type { Column } from "../types/introspection.js";
import { hashMutationRow } from "./row-hash.js";
import {
  assertBigQueryWorkflowWithinLimit,
  bigQueryWorkflowEstimate,
  buildBigQueryBackfillScript,
} from "./bigquery-workflow.js";
import type { SqlChangeDialect, SqlChangeTarget } from "./types.js";

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
export const StructuredColumnTypeSchema = z.enum([
  "text",
  "integer",
  "bigint",
  "decimal",
  "boolean",
  "date",
  "timestamp",
]);

export type BackfillExpression =
  | { kind: "column"; column: string }
  | { kind: "literal"; value: null | boolean | number | string }
  | {
      kind: "binary";
      operator: "add" | "subtract" | "multiply" | "divide" | "concat";
      left: BackfillExpression;
      right: BackfillExpression;
    }
  | { kind: "coalesce"; values: BackfillExpression[] };

export const BackfillExpressionSchema: z.ZodType<BackfillExpression> = z.lazy(
  () =>
    z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("column"), column: IdentifierSchema })
        .strict(),
      z
        .object({
          kind: z.literal("literal"),
          value: z.union([
            z.null(),
            z.boolean(),
            z.number().finite(),
            z.string().max(16_384),
          ]),
        })
        .strict(),
      z
        .object({
          kind: z.literal("binary"),
          operator: z.enum(["add", "subtract", "multiply", "divide", "concat"]),
          left: BackfillExpressionSchema,
          right: BackfillExpressionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("coalesce"),
          values: z.array(BackfillExpressionSchema).min(2).max(8),
        })
        .strict(),
    ]),
);

const BackfillExpressionPreflightSchema = z
  .unknown()
  .superRefine((value, context) => {
    const issue = backfillExpressionBoundIssue(value);
    if (issue) context.addIssue({ code: "custom", message: issue });
  });

export const BoundedBackfillExpressionSchema =
  BackfillExpressionPreflightSchema.pipe(BackfillExpressionSchema);

const TargetSchema = z
  .object({
    catalog: IdentifierSchema.nullable().optional().default(null),
    schema: IdentifierSchema.nullable().optional().default(null),
    table: IdentifierSchema,
  })
  .strict();

const StructuredColumnChangeCoreSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("add_column"),
      target: TargetSchema,
      columnName: IdentifierSchema,
      columnType: StructuredColumnTypeSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("rename_column"),
      target: TargetSchema,
      sourceColumn: IdentifierSchema,
      destinationColumn: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("add_and_backfill_column"),
      target: TargetSchema,
      columnName: IdentifierSchema,
      columnType: StructuredColumnTypeSchema,
      expression: BoundedBackfillExpressionSchema,
    })
    .strict(),
]);

const StructuredColumnChangePreflightSchema = z
  .unknown()
  .superRefine((value, context) => {
    const issue = structuredExpressionBoundIssue(value);
    if (issue) context.addIssue({ code: "custom", message: issue });
  });

export const StructuredColumnChangeSchema =
  StructuredColumnChangePreflightSchema.pipe(StructuredColumnChangeCoreSchema);

export type StructuredColumnChange = z.infer<
  typeof StructuredColumnChangeSchema
>;

export type PreparedStructuredColumnChange = {
  dialect: SqlChangeDialect;
  operation: StructuredColumnChange["operation"];
  target: SqlChangeTarget;
  canonicalSql: string;
  boundParameters: [];
  structuredOperation: StructuredColumnChange;
  expectedAffectedRows: number;
  preview: Record<string, unknown>;
  preconditions: {
    schemaFingerprint: string;
    selectSql: string | null;
    verificationSql: string | null;
    rowHashes: string[];
    preconditionRowHashes?: string[];
    providerPrecondition?: {
      kind: "bigquery_row_json";
      values: string[];
      verificationValues?: string[];
    };
  };
  executionStrategy: Record<string, unknown>;
  resourceEstimate: Record<string, unknown> | null;
};

export type ApplyStructuredColumnChangeInput = {
  operation: StructuredColumnChange["operation"];
  target: SqlChangeTarget;
  ddlSql: string;
  backfillSql: string | null;
  expectedSchemaFingerprint: string;
  expectedAffectedRows: number;
  maximumRows: number;
  preconditionSql: string | null;
  verificationSql: string | null;
  expectedRowHashes: string[];
  expectedPreconditionRowHashes?: string[];
  providerPrecondition?: {
    kind: "bigquery_row_json";
    values: string[];
    verificationValues?: string[];
  };
  executionToken: string;
  maximumBytesBilled?: string;
  skipDdl?: boolean;
  timeout?: number;
};

export type ApplyStructuredColumnChangeResult = {
  rowCount: number;
  providerExecutionId: string;
  verification: Record<string, unknown>;
};

export function splitStructuredCanonicalSql(input: {
  operation: StructuredColumnChange["operation"];
  canonicalSql: string;
}): { ddlSql: string; backfillSql: string | null } {
  if (input.operation !== "add_and_backfill_column") {
    if (input.canonicalSql.includes(";")) {
      throw new Error("Structured column SQL contains an unexpected phase.");
    }
    return { ddlSql: input.canonicalSql, backfillSql: null };
  }
  const separator = input.canonicalSql.indexOf("; ");
  if (separator < 1 || input.canonicalSql.indexOf("; ", separator + 2) !== -1) {
    throw new Error("Structured add/backfill SQL phases are malformed.");
  }
  return {
    ddlSql: input.canonicalSql.slice(0, separator),
    backfillSql: input.canonicalSql.slice(separator + 2),
  };
}

export function verifyStructuredColumnResult(
  change: StructuredColumnChange,
  columns: Column[],
  dialect: SqlChangeDialect,
): Record<string, unknown> {
  const actual = new Map(
    columns.map((column) => [column.name.toLowerCase(), column]),
  );
  if (change.operation === "rename_column") {
    if (actual.has(change.sourceColumn.toLowerCase())) {
      throw new Error("Column rename source still exists after apply.");
    }
    const destination = actual.get(change.destinationColumn.toLowerCase());
    if (!destination)
      throw new Error("Renamed column is unavailable after apply.");
    return {
      finalColumn: {
        name: destination.name,
        type: destination.dataType,
        nullable: destination.isNullable,
      },
    };
  }
  const column = actual.get(change.columnName.toLowerCase());
  if (
    !column ||
    !column.isNullable ||
    column.defaultValue != null ||
    !structuredColumnTypeMatches(column, change.columnType, dialect)
  ) {
    throw new Error("Added column definition failed verification.");
  }
  return {
    finalColumn: {
      name: column.name,
      type: column.dataType,
      nullable: column.isNullable,
      default: column.defaultValue ?? null,
      generated: false,
    },
  };
}

export function structuredColumnTypeMatches(
  column: Column,
  requested: z.infer<typeof StructuredColumnTypeSchema>,
  dialect: SqlChangeDialect,
): boolean {
  const actual = normalizePhysicalColumnDefinition(column, dialect);
  const expected = EXPECTED_PHYSICAL_COLUMN_DEFINITIONS[dialect][requested];
  return physicalColumnDefinitionsEqual(actual, expected);
}

type StructuredColumnType = z.infer<typeof StructuredColumnTypeSchema>;
type PhysicalColumnDefinition = {
  type: string;
  physicalType: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  signedness: "signed" | "unsigned" | null;
  timezone: "none" | "without_time_zone" | "utc" | null;
  nullable: boolean;
  defaultValue: { kind: "none" } | { kind: "value"; value: string };
};

const EXPECTED_PHYSICAL_COLUMN_DEFINITIONS: Record<
  SqlChangeDialect,
  Record<StructuredColumnType, PhysicalColumnDefinition>
> = {
  postgresql: {
    text: expectedDefinition("text"),
    integer: expectedDefinition("integer", { precision: 32, scale: 0 }),
    bigint: expectedDefinition("bigint", { precision: 64, scale: 0 }),
    decimal: expectedDefinition("numeric", { precision: 38, scale: 9 }),
    boolean: expectedDefinition("boolean"),
    date: expectedDefinition("date"),
    timestamp: expectedDefinition("timestamp_ntz", {
      timezone: "without_time_zone",
    }),
  },
  redshift: {
    text: expectedDefinition("varchar", { length: 65_535 }),
    integer: expectedDefinition("integer", { precision: 32, scale: 0 }),
    bigint: expectedDefinition("bigint", { precision: 64, scale: 0 }),
    decimal: expectedDefinition("numeric", { precision: 38, scale: 9 }),
    boolean: expectedDefinition("boolean"),
    date: expectedDefinition("date"),
    timestamp: expectedDefinition("timestamp_ntz", {
      timezone: "without_time_zone",
    }),
  },
  mysql: {
    text: expectedDefinition("text", {
      physicalType: "text",
      length: 65_535,
    }),
    integer: expectedDefinition("int", {
      physicalType: "int",
      precision: 10,
      scale: 0,
      signedness: "signed",
    }),
    bigint: expectedDefinition("bigint", {
      physicalType: "bigint",
      precision: 19,
      scale: 0,
      signedness: "signed",
    }),
    decimal: expectedDefinition("decimal", {
      physicalType: "decimal(38,9)",
      precision: 38,
      scale: 9,
      signedness: "signed",
    }),
    boolean: expectedDefinition("tinyint", {
      physicalType: "tinyint(1)",
      precision: 3,
      scale: 0,
      signedness: "signed",
    }),
    date: expectedDefinition("date", { physicalType: "date" }),
    timestamp: expectedDefinition("datetime", {
      physicalType: "datetime",
      timezone: "none",
    }),
  },
  transactsql: {
    text: expectedDefinition("nvarchar", {
      length: 8_000,
      precision: 0,
      scale: 0,
    }),
    integer: expectedDefinition("int", {
      length: 4,
      precision: 10,
      scale: 0,
    }),
    bigint: expectedDefinition("bigint", {
      length: 8,
      precision: 19,
      scale: 0,
    }),
    decimal: expectedDefinition("decimal", {
      length: 17,
      precision: 38,
      scale: 9,
    }),
    boolean: expectedDefinition("bit", {
      length: 1,
      precision: 1,
      scale: 0,
    }),
    date: expectedDefinition("date", {
      length: 3,
      precision: 10,
      scale: 0,
    }),
    timestamp: expectedDefinition("datetime2", {
      length: 8,
      precision: 27,
      scale: 7,
      timezone: "none",
    }),
  },
  snowflake: {
    text: expectedDefinition("varchar", { length: 16_777_216 }),
    integer: expectedDefinition("number", { precision: 38, scale: 0 }),
    bigint: expectedDefinition("number", { precision: 38, scale: 0 }),
    decimal: expectedDefinition("number", { precision: 38, scale: 9 }),
    boolean: expectedDefinition("boolean"),
    date: expectedDefinition("date"),
    timestamp: expectedDefinition("timestamp_ntz", {
      timezone: "without_time_zone",
    }),
  },
  bigquery: {
    text: expectedDefinition("string"),
    integer: expectedDefinition("int64"),
    bigint: expectedDefinition("int64"),
    decimal: expectedDefinition("numeric"),
    boolean: expectedDefinition("bool"),
    date: expectedDefinition("date"),
    timestamp: expectedDefinition("timestamp", { timezone: "utc" }),
  },
};

function expectedDefinition(
  type: string,
  overrides: Partial<PhysicalColumnDefinition> = {},
): PhysicalColumnDefinition {
  return {
    type,
    physicalType: type,
    length: null,
    precision: null,
    scale: null,
    signedness: null,
    timezone: null,
    nullable: true,
    defaultValue: { kind: "none" },
    ...overrides,
  };
}

function normalizePhysicalColumnDefinition(
  column: Column,
  dialect: SqlChangeDialect,
): PhysicalColumnDefinition {
  const type = canonicalPhysicalType(column.dataType, dialect);
  const providerType = normalizeProviderType(
    column.physicalType ?? column.dataType,
  );
  return {
    type,
    physicalType: dialect === "mysql" ? providerType : type,
    length: physicalMeasure(column.maxLength),
    precision: physicalMeasure(column.precision),
    scale: physicalMeasure(column.scale),
    signedness:
      dialect === "mysql" && MYSQL_SIGNED_TYPES.has(type)
        ? providerType.includes("unsigned")
          ? "unsigned"
          : "signed"
        : null,
    timezone: physicalTimezone(type, dialect),
    nullable: column.isNullable,
    defaultValue:
      column.defaultValue === undefined
        ? { kind: "none" }
        : { kind: "value", value: column.defaultValue },
  };
}

function physicalColumnDefinitionsEqual(
  actual: PhysicalColumnDefinition,
  expected: PhysicalColumnDefinition,
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const MYSQL_SIGNED_TYPES = new Set(["int", "bigint", "decimal", "tinyint"]);

function canonicalPhysicalType(
  value: string,
  dialect: SqlChangeDialect,
): string {
  const normalized = normalizeProviderType(value).replace(/[()]/g, "");
  const aliases: Partial<Record<SqlChangeDialect, Record<string, string>>> = {
    postgresql: {
      int4: "integer",
      int8: "bigint",
      decimal: "numeric",
      bool: "boolean",
      timestampwithouttimezone: "timestamp_ntz",
      timestamp: "timestamp_ntz",
    },
    redshift: {
      varchar: "varchar",
      charactervarying: "varchar",
      int: "integer",
      int4: "integer",
      int8: "bigint",
      decimal: "numeric",
      bool: "boolean",
      timestamp: "timestamp_ntz",
      timestampwithouttimezone: "timestamp_ntz",
    },
    mysql: {
      integer: "int",
      numeric: "decimal",
      boolean: "tinyint",
      bool: "tinyint",
    },
    transactsql: { numeric: "decimal" },
    snowflake: {
      text: "varchar",
      string: "varchar",
      integer: "number",
      int: "number",
      bigint: "number",
      decimal: "number",
      numeric: "number",
      timestamp: "timestamp_ntz",
      timestampntz: "timestamp_ntz",
    },
    bigquery: { integer: "int64", boolean: "bool" },
  };
  return aliases[dialect]?.[normalized] ?? normalized;
}

function normalizeProviderType(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"\[\]]/g, "")
    .replace(/\s+/g, "");
}

function physicalMeasure(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function physicalTimezone(
  type: string,
  dialect: SqlChangeDialect,
): PhysicalColumnDefinition["timezone"] {
  if (dialect === "bigquery" && type === "timestamp") return "utc";
  if (type === "timestamp_ntz") return "without_time_zone";
  if (
    (dialect === "mysql" && type === "datetime") ||
    (dialect === "transactsql" && type === "datetime2")
  ) {
    return "none";
  }
  return null;
}

export async function prepareStructuredColumnChange(input: {
  adapter: DatabaseAdapter;
  dialect: SqlChangeDialect;
  change: StructuredColumnChange;
  maxRows?: number;
  timeout?: number;
  maximumBytesBilled?: string;
}): Promise<PreparedStructuredColumnChange> {
  const change = StructuredColumnChangeSchema.parse(input.change);
  assertExpressionBound(change);
  const target = renderTarget(change.target, input.dialect);
  const columns = await input.adapter
    .introspect()
    .getColumns(
      target.catalog ?? undefined,
      target.schema ?? undefined,
      target.table,
    );
  if (columns.length === 0)
    throw new Error("Column-change target was not found.");
  const existing = new Map(
    columns.map((column) => [column.name.toLowerCase(), column]),
  );
  const schemaFingerprint = fingerprintSchema(columns);
  const transactional = !["mysql", "snowflake", "bigquery"].includes(
    input.dialect,
  );

  if (change.operation === "rename_column") {
    const source = existing.get(change.sourceColumn.toLowerCase());
    if (!source) throw new Error("Rename source column was not found.");
    if (existing.has(change.destinationColumn.toLowerCase())) {
      throw new Error("Rename destination column already exists.");
    }
    const ddl = renderRename(target, change, input.dialect);
    return {
      dialect: input.dialect,
      operation: change.operation,
      target,
      canonicalSql: ddl,
      boundParameters: [],
      structuredOperation: change,
      expectedAffectedRows: 0,
      preview: {
        before: {
          name: source.name,
          type: source.dataType,
          nullable: source.isNullable,
        },
        after: {
          name: change.destinationColumn,
          type: source.dataType,
          nullable: source.isNullable,
        },
        dependencyWarnings: dependencyWarnings(source),
      },
      preconditions: {
        schemaFingerprint,
        selectSql: null,
        verificationSql: null,
        rowHashes: [],
      },
      executionStrategy: columnStrategy(input.dialect, transactional, [
        "renamed",
        "verified",
      ]),
      resourceEstimate: null,
    };
  }

  const existingDestination = existing.get(change.columnName.toLowerCase());
  const reconcilesCommittedDdl =
    change.operation === "add_and_backfill_column" &&
    (input.dialect === "mysql" || input.dialect === "snowflake") &&
    existingDestination !== undefined &&
    existingDestination.isNullable &&
    existingDestination.defaultValue == null &&
    structuredColumnTypeMatches(
      existingDestination,
      change.columnType,
      input.dialect,
    );
  if (existingDestination && !reconcilesCommittedDdl) {
    throw new Error("Destination column already exists.");
  }
  const ddl = renderAdd(
    target,
    change.columnName,
    change.columnType,
    input.dialect,
  );
  if (change.operation === "add_column") {
    return {
      dialect: input.dialect,
      operation: change.operation,
      target,
      canonicalSql: ddl,
      boundParameters: [],
      structuredOperation: change,
      expectedAffectedRows: 0,
      preview: {
        before: null,
        after: {
          name: change.columnName,
          type: change.columnType,
          nullable: true,
          default: null,
        },
      },
      preconditions: {
        schemaFingerprint,
        selectSql: null,
        verificationSql: null,
        rowHashes: [],
      },
      executionStrategy: columnStrategy(input.dialect, transactional, [
        "column_added",
        "verified",
      ]),
      resourceEstimate: null,
    };
  }

  const referenced = new Set<string>();
  const expressionSql = renderBackfillValue(
    renderExpression(change.expression, input.dialect, existing, referenced),
    change.columnType,
    input.dialect,
  );
  if (referenced.size === 0) {
    throw new Error(
      "Backfill expression must reference at least one existing column.",
    );
  }
  const maximum = input.maxRows ?? 100;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) {
    throw new Error("SQL change row limit must be between 1 and 100.");
  }
  const selectedColumns = columns
    .slice()
    .sort((left, right) => left.position - right.position)
    .filter(
      (column) =>
        !reconcilesCommittedDdl ||
        column.name.toLowerCase() !== change.columnName.toLowerCase(),
    )
    .map((column) => quoteIdentifier(column.name, input.dialect));
  const outputColumn = quoteIdentifier(change.columnName, input.dialect);
  const existingDestinationAlias = "__trueforge_existing_destination";
  if (reconcilesCommittedDdl && existing.has(existingDestinationAlias)) {
    throw new Error("Destination-column reconciliation alias is unavailable.");
  }
  const selectSql = `SELECT ${[
    ...selectedColumns,
    ...(reconcilesCommittedDdl
      ? [
          `${outputColumn} AS ${quoteIdentifier(existingDestinationAlias, input.dialect)}`,
        ]
      : []),
    `${expressionSql} AS ${outputColumn}`,
  ].join(", ")} FROM ${target.sql}`;
  const verificationSql = `SELECT ${[
    ...selectedColumns,
    `${renderBackfillValue(outputColumn, change.columnType, input.dialect)} AS ${outputColumn}`,
  ].join(", ")} FROM ${target.sql}`;
  const update = `UPDATE ${target.sql} SET ${quoteIdentifier(change.columnName, input.dialect)} = ${expressionSql}`;
  const canonicalSql = `${ddl}; ${update}`;
  const boundedPreviewSql = boundSelect(selectSql, input.dialect, maximum + 1);
  const providerSql = `SELECT TO_JSON_STRING(tf_row) AS tf_row_json FROM (${selectSql}) AS tf_row`;
  const bigQueryPreflight =
    input.dialect === "bigquery"
      ? await preflightBigQueryBackfillWorkflow({
          adapter: input.adapter,
          previewSql: boundedPreviewSql,
          providerSql,
          preconditionSql: selectSql,
          backfillSql: update,
          verificationSql,
          maximumBytesBilled: requireBigQueryLimit(input.maximumBytesBilled),
          timeout: input.timeout,
        })
      : undefined;
  const preview = await input.adapter.queryReadOnly(
    boundedPreviewSql,
    [],
    maximum + 1,
    input.timeout,
    bigQueryPreflight
      ? billedReadLimit(bigQueryPreflight.previewBytesProcessed)
      : undefined,
  );
  if (preview.hasMoreRows || preview.rows.length > maximum) {
    throw new Error(`Column backfill exceeds the ${maximum}-row safety bound.`);
  }
  if (
    reconcilesCommittedDdl &&
    preview.rows.some((row) => row[existingDestinationAlias] !== null)
  ) {
    throw new Error(
      "Committed destination column contains values and cannot be reconciled.",
    );
  }
  const previewRows = preview.rows.map((row) => {
    const copy = { ...row };
    delete copy[existingDestinationAlias];
    return copy;
  });
  const providerPrecondition =
    input.dialect === "bigquery"
      ? await prepareBigQueryBackfillPrecondition(
          input.adapter,
          providerSql,
          maximum,
          input.timeout,
          billedReadLimit(bigQueryPreflight!.providerBytesProcessed),
        )
      : undefined;
  const resourceEstimate = providerPrecondition
    ? await exactBigQueryBackfillEstimate({
        adapter: input.adapter,
        preconditionSql: selectSql,
        backfillSql: update,
        verificationSql,
        providerPrecondition,
        expectedAffectedRows: previewRows.length,
        previewBytesProcessed: queryBytes(preview),
        providerBytesProcessed: providerPrecondition.bytesProcessed,
        maximumBytesBilled: requireBigQueryLimit(input.maximumBytesBilled),
        timeout: input.timeout,
      })
    : null;
  return {
    dialect: input.dialect,
    operation: change.operation,
    target,
    canonicalSql,
    boundParameters: [],
    structuredOperation: change,
    expectedAffectedRows: previewRows.length,
    preview: {
      before: previewRows.map((row) => {
        const copy = { ...row };
        delete copy[change.columnName];
        return copy;
      }),
      after: previewRows,
      column: {
        name: change.columnName,
        type: change.columnType,
        nullable: true,
        generated: false,
      },
    },
    preconditions: {
      schemaFingerprint,
      selectSql,
      verificationSql,
      rowHashes: previewRows.map(hashMutationRow).sort(),
      ...(reconcilesCommittedDdl
        ? { preconditionRowHashes: preview.rows.map(hashMutationRow).sort() }
        : {}),
      ...(providerPrecondition
        ? {
            providerPrecondition: {
              kind: providerPrecondition.kind,
              values: providerPrecondition.values,
            },
          }
        : {}),
    },
    executionStrategy: {
      ...columnStrategy(input.dialect, transactional, [
        reconcilesCommittedDdl ? "column_already_added" : "column_added",
        "backfill_applied",
        "verified",
      ]),
      ...(reconcilesCommittedDdl ? { ddlAlreadyCommitted: true } : {}),
    },
    resourceEstimate,
  };
}

async function prepareBigQueryBackfillPrecondition(
  adapter: DatabaseAdapter,
  providerSql: string,
  maximum: number,
  timeout: number | undefined,
  maximumBytesBilled: string,
): Promise<{
  kind: "bigquery_row_json";
  values: string[];
  bytesProcessed: string;
}> {
  const result = await adapter.queryReadOnly(
    providerSql,
    [],
    maximum + 1,
    timeout,
    maximumBytesBilled,
  );
  if (result.hasMoreRows || result.rows.length > maximum) {
    throw new Error(`Column backfill exceeds the ${maximum}-row safety bound.`);
  }
  const values = result.rows.map((row) => row.tf_row_json);
  if (values.some((value) => typeof value !== "string")) {
    throw new Error("BigQuery backfill precondition evidence is unavailable.");
  }
  return {
    kind: "bigquery_row_json",
    values: (values as string[]).sort(),
    bytesProcessed: queryBytes(result),
  };
}

async function preflightBigQueryBackfillWorkflow(input: {
  adapter: DatabaseAdapter;
  previewSql: string;
  providerSql: string;
  preconditionSql: string;
  backfillSql: string;
  verificationSql: string;
  maximumBytesBilled: string;
  timeout: number | undefined;
}): Promise<{
  previewBytesProcessed: string;
  providerBytesProcessed: string;
}> {
  const previewBytesProcessed = await estimateBigQueryBytes(
    input.adapter,
    input.previewSql,
    input.timeout,
  );
  const providerBytesProcessed = await estimateBigQueryBytes(
    input.adapter,
    input.providerSql,
    input.timeout,
  );
  const transactionBytesProcessed = await estimateBigQueryBytes(
    input.adapter,
    buildBigQueryBackfillScript({
      preconditionSql: input.preconditionSql,
      backfillSql: input.backfillSql,
      verificationSql: input.verificationSql,
      expectedRows: [],
      expectedAffectedRows: 0,
    }),
    input.timeout,
  );
  const estimate = bigQueryWorkflowEstimate({
    paidReadBytesProcessed: [previewBytesProcessed, providerBytesProcessed],
    transactionBytesProcessed,
  });
  assertBigQueryWorkflowWithinLimit(estimate, input.maximumBytesBilled);
  return { previewBytesProcessed, providerBytesProcessed };
}

async function exactBigQueryBackfillEstimate(input: {
  adapter: DatabaseAdapter;
  preconditionSql: string;
  backfillSql: string;
  verificationSql: string;
  providerPrecondition: { values: string[] };
  expectedAffectedRows: number;
  previewBytesProcessed: string;
  providerBytesProcessed: string;
  maximumBytesBilled: string;
  timeout: number | undefined;
}): Promise<Record<string, unknown>> {
  const transactionBytesProcessed = await estimateBigQueryBytes(
    input.adapter,
    buildBigQueryBackfillScript({
      preconditionSql: input.preconditionSql,
      backfillSql: input.backfillSql,
      verificationSql: input.verificationSql,
      expectedRows: input.providerPrecondition.values,
      expectedAffectedRows: input.expectedAffectedRows,
    }),
    input.timeout,
  );
  const estimate = bigQueryWorkflowEstimate({
    paidReadBytesProcessed: [
      input.previewBytesProcessed,
      input.providerBytesProcessed,
    ],
    transactionBytesProcessed,
  });
  assertBigQueryWorkflowWithinLimit(estimate, input.maximumBytesBilled);
  return estimate;
}

async function estimateBigQueryBytes(
  adapter: DatabaseAdapter,
  sql: string,
  timeout: number | undefined,
): Promise<string> {
  const estimate = await adapter.estimateControlledMutation?.({
    canonicalSql: sql,
    params: [],
    timeout,
  });
  const bytes = estimate?.dryRunBytesProcessed;
  if (typeof bytes !== "string" || !/^[0-9]+$/.test(bytes)) {
    throw new Error("BigQuery mutation cost evidence is unavailable.");
  }
  return bytes;
}

function requireBigQueryLimit(value: string | undefined): string {
  if (!value || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error("BigQuery mutation cost limit is unavailable.");
  }
  return value;
}

function billedReadLimit(bytes: string): string {
  return BigInt(bytes) > 0n ? bytes : "1";
}

function queryBytes(result: { bytesProcessed?: string }): string {
  if (
    typeof result.bytesProcessed !== "string" ||
    !/^[0-9]+$/.test(result.bytesProcessed)
  ) {
    throw new Error("BigQuery paid-read cost evidence is unavailable.");
  }
  return result.bytesProcessed;
}

export function fingerprintSchema(columns: Column[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        columns
          .map((column) => ({
            name: column.name.toLowerCase(),
            type: column.dataType.toLowerCase(),
            physicalType: column.physicalType?.toLowerCase() ?? null,
            length: column.maxLength ?? null,
            precision: column.precision ?? null,
            scale: column.scale ?? null,
            nullable: column.isNullable,
            default: column.defaultValue ?? null,
            position: column.position,
          }))
          .sort((left, right) => left.position - right.position),
      ),
    )
    .digest("hex");
}

function renderTarget(
  target: z.output<typeof TargetSchema>,
  dialect: SqlChangeDialect,
): SqlChangeTarget {
  const parts = [target.catalog, target.schema, target.table].filter(
    (part): part is string => Boolean(part),
  );
  return {
    catalog: target.catalog,
    schema: target.schema,
    table: target.table,
    sql: parts.map((part) => quoteIdentifier(part, dialect)).join("."),
  };
}

function renderAdd(
  target: SqlChangeTarget,
  columnName: string,
  columnType: z.infer<typeof StructuredColumnTypeSchema>,
  dialect: SqlChangeDialect,
): string {
  const addKeyword = dialect === "transactsql" ? "ADD" : "ADD COLUMN";
  return `ALTER TABLE ${target.sql} ${addKeyword} ${quoteIdentifier(columnName, dialect)} ${renderType(columnType, dialect)} NULL`;
}

function renderRename(
  target: SqlChangeTarget,
  change: Extract<StructuredColumnChange, { operation: "rename_column" }>,
  dialect: SqlChangeDialect,
): string {
  if (dialect === "transactsql") {
    const qualified = [
      target.catalog,
      target.schema,
      target.table,
      change.sourceColumn,
    ]
      .filter(Boolean)
      .join(".")
      .replace(/'/g, "''");
    return `EXEC sys.sp_rename N'${qualified}', N'${change.destinationColumn.replace(/'/g, "''")}', N'COLUMN'`;
  }
  return `ALTER TABLE ${target.sql} RENAME COLUMN ${quoteIdentifier(change.sourceColumn, dialect)} TO ${quoteIdentifier(change.destinationColumn, dialect)}`;
}

function renderType(
  type: z.infer<typeof StructuredColumnTypeSchema>,
  dialect: SqlChangeDialect,
): string {
  const map: Record<SqlChangeDialect, Record<typeof type, string>> = {
    postgresql: {
      text: "text",
      integer: "integer",
      bigint: "bigint",
      decimal: "numeric(38,9)",
      boolean: "boolean",
      date: "date",
      timestamp: "timestamp",
    },
    redshift: {
      text: "varchar(65535)",
      integer: "integer",
      bigint: "bigint",
      decimal: "decimal(38,9)",
      boolean: "boolean",
      date: "date",
      timestamp: "timestamp",
    },
    mysql: {
      text: "text",
      integer: "int",
      bigint: "bigint",
      decimal: "decimal(38,9)",
      boolean: "boolean",
      date: "date",
      timestamp: "datetime",
    },
    transactsql: {
      text: "nvarchar(4000)",
      integer: "int",
      bigint: "bigint",
      decimal: "decimal(38,9)",
      boolean: "bit",
      date: "date",
      timestamp: "datetime2",
    },
    snowflake: {
      text: "varchar",
      integer: "integer",
      bigint: "number(38,0)",
      decimal: "number(38,9)",
      boolean: "boolean",
      date: "date",
      timestamp: "timestamp_ntz",
    },
    bigquery: {
      text: "string",
      integer: "int64",
      bigint: "int64",
      decimal: "numeric",
      boolean: "bool",
      date: "date",
      timestamp: "timestamp",
    },
  };
  return map[dialect][type];
}

function renderBackfillValue(
  expressionSql: string,
  type: z.infer<typeof StructuredColumnTypeSchema>,
  dialect: SqlChangeDialect,
): string {
  if (dialect !== "mysql") {
    return `CAST(${expressionSql} AS ${renderType(type, dialect)})`;
  }
  const mysqlType: Record<typeof type, string> = {
    text: "CHAR",
    integer: "SIGNED",
    bigint: "SIGNED",
    decimal: "DECIMAL(38,9)",
    boolean: "UNSIGNED",
    date: "DATE",
    timestamp: "DATETIME",
  };
  return `CAST(${expressionSql} AS ${mysqlType[type]})`;
}

function renderExpression(
  expression: BackfillExpression,
  dialect: SqlChangeDialect,
  columns: Map<string, Column>,
  referenced: Set<string>,
): string {
  switch (expression.kind) {
    case "column": {
      const column = columns.get(expression.column.toLowerCase());
      if (!column)
        throw new Error(
          `Backfill column '${expression.column}' was not found.`,
        );
      referenced.add(column.name);
      return quoteIdentifier(column.name, dialect);
    }
    case "literal":
      return sqlLiteral(expression.value, dialect);
    case "binary": {
      const left = renderExpression(
        expression.left,
        dialect,
        columns,
        referenced,
      );
      const right = renderExpression(
        expression.right,
        dialect,
        columns,
        referenced,
      );
      if (expression.operator === "concat") return `CONCAT(${left}, ${right})`;
      const operators = {
        add: "+",
        subtract: "-",
        multiply: "*",
        divide: "/",
      } as const;
      return `(${left} ${operators[expression.operator]} ${right})`;
    }
    case "coalesce":
      return `COALESCE(${expression.values.map((value) => renderExpression(value, dialect, columns, referenced)).join(", ")})`;
  }
}

function structuredExpressionBoundIssue(value: unknown): string | null {
  if (
    !isUnknownRecord(value) ||
    value.operation !== "add_and_backfill_column"
  ) {
    return null;
  }
  return backfillExpressionBoundIssue(value.expression);
}

function backfillExpressionBoundIssue(expression: unknown): string | null {
  let nodes = 0;
  const stack: Array<{ expression: unknown; depth: number }> = [
    { expression, depth: 1 },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 32 || current.depth > 8) {
      return "Backfill expression exceeds the structural safety bound.";
    }
    if (!isUnknownRecord(current.expression)) continue;
    if (current.expression.kind === "binary") {
      stack.push(
        { expression: current.expression.right, depth: current.depth + 1 },
        { expression: current.expression.left, depth: current.depth + 1 },
      );
    } else if (
      current.expression.kind === "coalesce" &&
      Array.isArray(current.expression.values)
    ) {
      if (current.expression.values.length > 8) {
        return "Backfill expression exceeds the structural safety bound.";
      }
      for (
        let index = current.expression.values.length - 1;
        index >= 0;
        index -= 1
      ) {
        stack.push({
          expression: current.expression.values[index],
          depth: current.depth + 1,
        });
      }
    }
  }
  return null;
}

function assertExpressionBound(change: StructuredColumnChange): void {
  const issue = structuredExpressionBoundIssue(change);
  if (issue) throw new Error(issue);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteIdentifier(value: string, dialect: SqlChangeDialect): string {
  if (dialect === "mysql" || dialect === "bigquery")
    return `\`${value.replace(/`/g, "``")}\``;
  if (dialect === "transactsql") return `[${value.replace(/]/g, "]]")}]`;
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlLiteral(
  value: null | boolean | number | string,
  dialect: SqlChangeDialect,
): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") {
    if (dialect === "mysql" || dialect === "transactsql")
      return value ? "1" : "0";
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function boundSelect(
  sql: string,
  dialect: SqlChangeDialect,
  maximum: number,
): string {
  return dialect === "transactsql"
    ? sql.replace(/^SELECT\s+/i, `SELECT TOP (${maximum}) `)
    : `${sql} LIMIT ${maximum}`;
}

export function boundedStructuredMutationSelect(
  sql: string,
  dialect: SqlChangeDialect,
  maximumRows: number,
): string {
  if (!Number.isInteger(maximumRows) || maximumRows < 1 || maximumRows > 100) {
    throw new Error("SQL change row limit must be between 1 and 100.");
  }
  return boundSelect(sql, dialect, maximumRows + 1);
}

function columnStrategy(
  dialect: SqlChangeDialect,
  transactional: boolean,
  phases: string[],
): Record<string, unknown> {
  return {
    connector: dialect,
    mode: transactional ? "transactional_ddl" : "idempotent_implicit_commit",
    phases,
  };
}

function dependencyWarnings(column: Column): string[] {
  const warnings = column.metadata?.dependencyWarnings;
  return Array.isArray(warnings)
    ? warnings
        .filter((value): value is string => typeof value === "string")
        .slice(0, 20)
    : [];
}
