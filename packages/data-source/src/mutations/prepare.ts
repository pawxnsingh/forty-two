import type { DatabaseAdapter } from "../adapters/base.js";
import type { Column } from "../types/introspection.js";
import type { QueryParameter } from "../types/query.js";
import {
  assertBigQueryWorkflowWithinLimit,
  bigQueryWorkflowEstimate,
  buildBigQueryRowMutationScript,
} from "./bigquery-workflow.js";
import { hashMutationRow } from "./row-hash.js";
import { parseSqlChange } from "./sql-change-parser.js";
import type {
  PreparedSqlChange,
  SqlChangeDialect,
  SqlChangeTarget,
} from "./types.js";

const MAX_CHANGE_ROWS = 100;

export async function prepareControlledSqlChange(input: {
  adapter: DatabaseAdapter;
  sql: string;
  dialect: SqlChangeDialect;
  timeout?: number;
  maxRows?: number;
  maximumBytesBilled?: string;
}): Promise<PreparedSqlChange> {
  const maximum = input.maxRows ?? MAX_CHANGE_ROWS;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_CHANGE_ROWS) {
    throw new Error("SQL change row limit must be between 1 and 100.");
  }
  const parsed = parseSqlChange(input.sql, input.dialect);
  const resolvedTarget = normalizeSqlChangeTarget(parsed.target, input.dialect);
  const columns = await input.adapter
    .introspect()
    .getColumns(
      resolvedTarget.catalog ?? undefined,
      resolvedTarget.schema ?? undefined,
      resolvedTarget.table,
    );
  if (columns.length === 0) throw new Error("Mutation target was not found.");
  const declaredKeys = columns
    .filter((column) => column.isPrimaryKey)
    .sort((left, right) => left.position - right.position)
    .map((column) => column.name);
  const identity =
    declaredKeys.length > 0
      ? { columns: declaredKeys, bytesProcessed: undefined }
      : await resolveStableIdentity(
          input.adapter,
          resolvedTarget,
          input.dialect,
          input.timeout,
          input.maximumBytesBilled,
        );
  const primaryKeys = identity.columns;
  if (primaryKeys.length === 0) {
    throw new Error("Mutation target requires a stable primary-key identity.");
  }
  assertKnownColumns(parsed, columns, primaryKeys);

  const preconditionSql = buildPreconditionSql(
    parsed,
    resolvedTarget,
    primaryKeys,
  );
  const boundedPreconditionSql = boundSelect(
    preconditionSql,
    input.dialect,
    maximum + 1,
  );
  const bigQueryProviderSql = `SELECT TO_JSON_STRING(tf_row) AS tf_row_json FROM (${preconditionSql}) AS tf_row`;
  const bigQueryPreflight =
    input.dialect === "bigquery"
      ? await preflightBigQueryRowWorkflow({
          adapter: input.adapter,
          previewSql: boundedPreconditionSql,
          providerSql: bigQueryProviderSql,
          preconditionSql,
          mutationSql: parsed.canonicalSql,
          identityLookupBytesProcessed: identity.bytesProcessed,
          maximumBytesBilled: requireBigQueryLimit(input.maximumBytesBilled),
          timeout: input.timeout,
        })
      : undefined;
  const previewResult = await input.adapter.queryReadOnly(
    boundedPreconditionSql,
    [],
    maximum + 1,
    input.timeout,
    bigQueryPreflight
      ? billedReadLimit(bigQueryPreflight.previewBytesProcessed)
      : undefined,
  );
  if (previewResult.hasMoreRows || previewResult.rows.length > maximum) {
    throw new Error(`SQL change exceeds the ${maximum}-row safety bound.`);
  }
  const before = previewResult.rows;
  if (parsed.operation === "insert" && before.length !== 0) {
    throw new Error("INSERT primary-key precondition already exists.");
  }
  const identities = identityRows(
    parsed.operation === "insert" ? [parsed.insertValues ?? {}] : before,
    primaryKeys,
  );
  const expectedAffectedRows =
    parsed.operation === "insert" ? 1 : before.length;
  const after =
    parsed.operation === "delete"
      ? []
      : parsed.operation === "insert"
        ? [parsed.insertValues ?? {}]
        : before.map((row) => ({ ...row, ...parsed.assignments }));
  const providerPrecondition =
    input.dialect === "bigquery"
      ? await prepareBigQueryRowPrecondition(
          input.adapter,
          bigQueryProviderSql,
          maximum,
          input.timeout,
          billedReadLimit(bigQueryPreflight!.providerBytesProcessed),
        )
      : undefined;

  const resourceEstimate = providerPrecondition
    ? await exactBigQueryRowEstimate({
        adapter: input.adapter,
        preconditionSql,
        mutationSql: parsed.canonicalSql,
        providerPrecondition,
        expectedAffectedRows,
        previewBytesProcessed: queryBytes(previewResult),
        providerBytesProcessed: providerPrecondition.bytesProcessed,
        identityLookupBytesProcessed: identity.bytesProcessed,
        maximumBytesBilled: requireBigQueryLimit(input.maximumBytesBilled),
        timeout: input.timeout,
      })
    : ((await input.adapter.estimateControlledMutation?.({
        canonicalSql: parsed.canonicalSql,
        params: [],
        timeout: input.timeout,
      })) ?? null);

  return {
    ...parsed,
    target: resolvedTarget,
    expectedAffectedRows,
    preview: {
      before,
      after,
      identityColumns: primaryKeys,
      identities,
    },
    preconditions: {
      selectSql: preconditionSql,
      params: [],
      rowHashes: before.map(hashMutationRow).sort(),
      identityColumns: primaryKeys,
      ...(providerPrecondition
        ? {
            providerPrecondition: {
              kind: providerPrecondition.kind,
              values: providerPrecondition.values,
            },
          }
        : {}),
    },
    executionStrategy: executionStrategy(input.dialect),
    resourceEstimate,
  };
}

async function resolveStableIdentity(
  adapter: DatabaseAdapter,
  target: SqlChangeTarget,
  dialect: SqlChangeDialect,
  timeout: number | undefined,
  maximumBytesBilled: string | undefined,
): Promise<{ columns: string[]; bytesProcessed: string | undefined }> {
  const table = sqlLiteral(target.table, dialect);
  const catalog = target.catalog
    ? sqlLiteral(target.catalog, dialect)
    : dialect === "mysql"
      ? "DATABASE()"
      : dialect === "transactsql"
        ? "DB_NAME()"
        : dialect === "snowflake"
          ? "CURRENT_DATABASE()"
          : dialect === "bigquery"
            ? null
            : "CURRENT_DATABASE()";
  const schema = target.schema
    ? sqlLiteral(target.schema, dialect)
    : dialect === "transactsql"
      ? "SCHEMA_NAME()"
      : dialect === "snowflake"
        ? "CURRENT_SCHEMA()"
        : dialect === "mysql"
          ? catalog
          : dialect === "bigquery"
            ? null
            : "CURRENT_SCHEMA()";
  if (!catalog || !schema) return { columns: [], bytesProcessed: undefined };
  let sql: string;
  if (dialect === "transactsql") {
    sql = `SELECT i.name AS constraint_name, CASE WHEN i.is_primary_key = 1 THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS constraint_type, c.name AS column_name, ic.key_ordinal AS ordinal_position FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE DB_NAME() = ${catalog} AND s.name = ${schema} AND t.name = ${table} AND (i.is_primary_key = 1 OR i.is_unique_constraint = 1) ORDER BY i.is_primary_key DESC, i.name, ic.key_ordinal`;
  } else if (dialect === "mysql") {
    sql = `SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name WHERE tc.table_schema = ${catalog} AND tc.table_name = ${table} AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE') ORDER BY CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 0 ELSE 1 END, tc.constraint_name, kcu.ordinal_position`;
  } else if (dialect === "bigquery") {
    const constraintView = `${quoteIdentifier(target.catalog!, dialect)}.${quoteIdentifier(target.schema!, dialect)}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS`;
    const keyView = `${quoteIdentifier(target.catalog!, dialect)}.${quoteIdentifier(target.schema!, dialect)}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE`;
    sql = `SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position FROM ${constraintView} tc JOIN ${keyView} kcu ON kcu.constraint_catalog = tc.constraint_catalog AND kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name WHERE tc.table_catalog = ${catalog} AND tc.table_schema = ${schema} AND tc.table_name = ${table} AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE') ORDER BY CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 0 ELSE 1 END, tc.constraint_name, kcu.ordinal_position`;
  } else {
    const prefix =
      dialect === "snowflake"
        ? `${quoteIdentifier(target.catalog ?? "", dialect)}.INFORMATION_SCHEMA.`
        : "information_schema.";
    sql = `SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position FROM ${prefix}table_constraints tc JOIN ${prefix}key_column_usage kcu ON kcu.constraint_catalog = tc.constraint_catalog AND kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name WHERE tc.table_catalog = ${catalog} AND tc.table_schema = ${schema} AND tc.table_name = ${table} AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE') ORDER BY CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 0 ELSE 1 END, tc.constraint_name, kcu.ordinal_position`;
  }
  const result = await adapter.queryReadOnly(
    sql,
    [],
    32,
    timeout,
    dialect === "bigquery"
      ? requireBigQueryLimit(maximumBytesBilled)
      : undefined,
  );
  const grouped = new Map<string, { primary: boolean; columns: string[] }>();
  for (const row of result.rows) {
    const name = caseInsensitiveValue(row, "constraint_name");
    const column = caseInsensitiveValue(row, "column_name");
    if (typeof name !== "string" || typeof column !== "string") continue;
    const group = grouped.get(name) ?? {
      primary:
        String(caseInsensitiveValue(row, "constraint_type")).toUpperCase() ===
        "PRIMARY KEY",
      columns: [],
    };
    group.columns.push(column);
    grouped.set(name, group);
  }
  return {
    columns:
      [...grouped.values()].sort(
        (left, right) => Number(right.primary) - Number(left.primary),
      )[0]?.columns ?? [],
    bytesProcessed: dialect === "bigquery" ? queryBytes(result) : undefined,
  };
}

function caseInsensitiveValue(
  row: Record<string, unknown>,
  key: string,
): unknown {
  const actual = Object.keys(row).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return actual ? row[actual] : undefined;
}

async function prepareBigQueryRowPrecondition(
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
    throw new Error(`SQL change exceeds the ${maximum}-row safety bound.`);
  }
  const values = result.rows.map((row) => row.tf_row_json);
  if (values.some((value) => typeof value !== "string")) {
    throw new Error("BigQuery row precondition evidence is unavailable.");
  }
  return {
    kind: "bigquery_row_json",
    values: (values as string[]).sort(),
    bytesProcessed: queryBytes(result),
  };
}

export function normalizeSqlChangeTarget(
  target: SqlChangeTarget,
  dialect: SqlChangeDialect,
): SqlChangeTarget {
  if (dialect === "mysql" && target.catalog === null && target.schema) {
    return { ...target, catalog: target.schema, schema: null };
  }
  return target;
}

function assertKnownColumns(
  parsed: ReturnType<typeof parseSqlChange>,
  columns: Column[],
  primaryKeys: string[],
): void {
  const actual = new Map(
    columns.map((column) => [column.name.toLowerCase(), column.name]),
  );
  const proposed = [
    ...Object.keys(parsed.assignments),
    ...Object.keys(parsed.insertValues ?? {}),
  ];
  for (const column of proposed) {
    if (!actual.has(column.toLowerCase())) {
      throw new Error(`Mutation column '${column}' was not found.`);
    }
  }
  if (
    parsed.operation === "update" &&
    Object.keys(parsed.assignments).some((column) =>
      primaryKeys.some((key) => key.toLowerCase() === column.toLowerCase()),
    )
  ) {
    throw new Error("Updating primary-key columns is not supported.");
  }
  if (parsed.operation === "insert") {
    const provided = new Map(
      Object.entries(parsed.insertValues ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    for (const key of primaryKeys) {
      if (
        !provided.has(key.toLowerCase()) ||
        provided.get(key.toLowerCase()) === null
      ) {
        throw new Error("INSERT must provide every stable primary-key column.");
      }
    }
  }
}

function buildPreconditionSql(
  parsed: ReturnType<typeof parseSqlChange>,
  target: SqlChangeTarget,
  primaryKeys: string[],
): string {
  if (parsed.operation !== "insert") {
    return `SELECT * FROM ${target.sql} WHERE ${parsed.whereSql}`;
  }
  const values = new Map(
    Object.entries(parsed.insertValues ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return `SELECT * FROM ${target.sql} WHERE ${primaryKeys
    .map(
      (key) =>
        `${quoteIdentifier(key, parsed.dialect)} = ${sqlLiteral(values.get(key.toLowerCase()) ?? null, parsed.dialect)}`,
    )
    .join(" AND ")}`;
}

function boundSelect(
  sql: string,
  dialect: SqlChangeDialect,
  maximum: number,
): string {
  if (dialect === "transactsql") {
    return sql.replace(/^SELECT\s+/i, `SELECT TOP (${maximum}) `);
  }
  return `${sql} LIMIT ${maximum}`;
}

function identityRows(
  rows: Record<string, unknown>[],
  primaryKeys: string[],
): Record<string, unknown>[] {
  const identities = rows.map((row) =>
    Object.fromEntries(
      primaryKeys.map((key) => {
        const actualKey = Object.keys(row).find(
          (candidate) => candidate.toLowerCase() === key.toLowerCase(),
        );
        const value = actualKey ? row[actualKey] : undefined;
        if (value === null || value === undefined) {
          throw new Error(
            "Mutation preview contains an unstable primary-key identity.",
          );
        }
        return [key, value];
      }),
    ),
  );
  const serialized = identities.map((identity) => JSON.stringify(identity));
  if (new Set(serialized).size !== serialized.length) {
    throw new Error("Mutation preview contains duplicate row identities.");
  }
  return identities;
}

function executionStrategy(
  dialect: SqlChangeDialect,
): PreparedSqlChange["executionStrategy"] {
  switch (dialect) {
    case "postgresql":
      return {
        connector: dialect,
        atomicUnit: "transaction",
        locking: "SELECT FOR UPDATE",
      };
    case "mysql":
      return {
        connector: dialect,
        atomicUnit: "InnoDB transaction",
        locking: "locking read",
      };
    case "transactsql":
      return {
        connector: dialect,
        atomicUnit: "transaction",
        locking: "UPDLOCK,HOLDLOCK",
      };
    case "snowflake":
      return {
        connector: dialect,
        atomicUnit: "transaction",
        locking: "conflict validation",
      };
    case "bigquery":
      return {
        connector: dialect,
        atomicUnit: "multi-statement transaction job",
        locking: "ASSERT precondition",
      };
    case "redshift":
      return {
        connector: dialect,
        atomicUnit: "serializable transaction",
        locking: "target table lock",
      };
  }
}

async function preflightBigQueryRowWorkflow(input: {
  adapter: DatabaseAdapter;
  previewSql: string;
  providerSql: string;
  preconditionSql: string;
  mutationSql: string;
  identityLookupBytesProcessed: string | undefined;
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
    buildBigQueryRowMutationScript({
      preconditionSql: input.preconditionSql,
      mutationSql: input.mutationSql,
      expectedRows: [],
      expectedAffectedRows: 0,
    }),
    input.timeout,
  );
  const estimate = bigQueryWorkflowEstimate({
    paidReadBytesProcessed: [previewBytesProcessed, providerBytesProcessed],
    transactionBytesProcessed,
    ...(input.identityLookupBytesProcessed
      ? {
          identityLookupBytesProcessed: input.identityLookupBytesProcessed,
        }
      : {}),
  });
  assertBigQueryWorkflowWithinLimit(estimate, input.maximumBytesBilled);
  return { previewBytesProcessed, providerBytesProcessed };
}

async function exactBigQueryRowEstimate(input: {
  adapter: DatabaseAdapter;
  preconditionSql: string;
  mutationSql: string;
  providerPrecondition: { values: string[] };
  expectedAffectedRows: number;
  previewBytesProcessed: string;
  providerBytesProcessed: string;
  identityLookupBytesProcessed: string | undefined;
  maximumBytesBilled: string;
  timeout: number | undefined;
}): Promise<Record<string, unknown>> {
  const transactionBytesProcessed = await estimateBigQueryBytes(
    input.adapter,
    buildBigQueryRowMutationScript({
      preconditionSql: input.preconditionSql,
      mutationSql: input.mutationSql,
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
    ...(input.identityLookupBytesProcessed
      ? {
          identityLookupBytesProcessed: input.identityLookupBytesProcessed,
        }
      : {}),
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

function quoteIdentifier(value: string, dialect: SqlChangeDialect): string {
  if (dialect === "mysql" || dialect === "bigquery") {
    return `\`${value.replace(/`/g, "``")}\``;
  }
  if (dialect === "transactsql") return `[${value.replace(/]/g, "]]")}]`;
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: QueryParameter, dialect: SqlChangeDialect): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") {
    return dialect === "transactsql" || dialect === "mysql"
      ? value
        ? "1"
        : "0"
      : value
        ? "TRUE"
        : "FALSE";
  }
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}
