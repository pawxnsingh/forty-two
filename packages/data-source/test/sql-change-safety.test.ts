import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseAdapter } from "../src/adapters/base.js";
import { executedStructuredStatements } from "../src/adapters/mysql.js";
import { snowflakeImplicitDdlOutcome } from "../src/adapters/snowflake.js";
import type { Column } from "../src/types/introspection.js";
import {
  buildBigQueryBackfillScript,
  buildBigQueryRowMutationScript,
  prepareControlledSqlChange,
  prepareStructuredColumnChange,
  parseSqlChange,
  structuredColumnTypeMatches,
  StructuredColumnChangeSchema,
  type SqlChangeDialect,
} from "../src/mutations/index.js";

test("Snowflake controlled INSERT fails before provider preview", async () => {
  await assert.rejects(
    prepareControlledSqlChange({
      adapter: {} as DatabaseAdapter,
      dialect: "snowflake",
      sql: "INSERT INTO inventory (id, quantity) VALUES (7, 4)",
    }),
    /controlled INSERT is unavailable/,
  );
});

const DIALECTS: SqlChangeDialect[] = [
  "postgresql",
  "mysql",
  "transactsql",
  "snowflake",
  "bigquery",
  "redshift",
];

test("parses one bounded row change for every supported dialect", () => {
  for (const dialect of DIALECTS) {
    const parsed = parseSqlChange(
      "UPDATE inventory SET quantity = 4 WHERE id = 7",
      dialect,
    );
    assert.equal(parsed.operation, "update", dialect);
    assert.equal(parsed.target.table, "inventory", dialect);
    assert.deepEqual(parsed.assignments, { quantity: 4 }, dialect);
    assert.deepEqual(
      parsed.boundParameters.map(({ type, value }) => ({ type, value })),
      [
        { type: "number", value: 4 },
        { type: "number", value: 7 },
      ],
      dialect,
    );
  }
});

test("comment markers and separators are rejected only outside quoted tokens", () => {
  for (const dialect of DIALECTS) {
    for (const value of [
      "https://example.com/path",
      "a--b",
      "a/*b*/c",
      "first;second",
    ]) {
      const parsed = parseSqlChange(
        `UPDATE inventory SET note = '${value}' WHERE id = 7`,
        dialect,
      );
      assert.equal(parsed.assignments.note, value, `${dialect}: ${value}`);
    }
    for (const suffix of [
      "; DELETE FROM inventory",
      " -- comment",
      " /* comment */",
    ]) {
      assert.throws(
        () =>
          parseSqlChange(
            `UPDATE inventory SET note = 'safe' WHERE id = 7${suffix}`,
            dialect,
          ),
        /Comments and multiple SQL statements/,
        `${dialect}: ${suffix}`,
      );
    }
  }
});

test("literal extraction ignores numeric-looking identifier fragments in every dialect", () => {
  for (const dialect of DIALECTS) {
    const tableDigits = parseSqlChange(
      "UPDATE inventory_2024 SET value = 1 WHERE id = 7",
      dialect,
    );
    assert.deepEqual(
      tableDigits.boundParameters.map(({ value }) => value),
      [1, 7],
      `${dialect} table identifier`,
    );
    const exponentColumn = parseSqlChange(
      "UPDATE inventory SET c_1e309 = 1 WHERE id = 7",
      dialect,
    );
    assert.deepEqual(
      exponentColumn.boundParameters.map(({ value }) => value),
      [1, 7],
      `${dialect} exponent-like column identifier`,
    );
    assert.equal(exponentColumn.assignments.c_1e309, 1);
    const quote =
      dialect === "mysql"
        ? (value: string) => `\`${value}\``
        : dialect === "transactsql"
          ? (value: string) => `[${value}]`
          : (value: string) => `"${value}"`;
    const quoted = parseSqlChange(
      `UPDATE ${quote("inventory_2024")} SET ${quote("c_1e309")} = 1 WHERE id = 7`,
      dialect,
    );
    assert.deepEqual(
      quoted.boundParameters.map(({ value }) => value),
      [1, 7],
      `${dialect} quoted identifiers`,
    );
  }
});

test("numeric literal scanning consumes maximal tokens in every dialect", () => {
  for (const dialect of DIALECTS) {
    for (const [literal, expected] of [
      ["01", 1],
      ["00", 0],
      ["00.5", 0.5],
      ["-00.5", -0.5],
      ["1.5025e2", 150.25],
    ] as const) {
      const parsed = parseSqlChange(
        `UPDATE inventory SET quantity = 4 WHERE value = ${literal}`,
        dialect,
      );
      assert.deepEqual(
        parsed.boundParameters.map(({ value }) => value),
        [4, expected],
        `${dialect} ${literal}`,
      );
    }
    assert.throws(
      () =>
        parseSqlChange(
          "UPDATE inventory SET quantity = 4 WHERE value = 01e309",
          dialect,
        ),
      /out of range/,
      `${dialect} leading-zero exponent overflow`,
    );
  }
});

test("fails closed for unbounded, multi-statement, computed, and arbitrary DDL", () => {
  for (const dialect of DIALECTS) {
    for (const sql of [
      "UPDATE inventory SET quantity = 4",
      "DELETE FROM inventory",
      "UPDATE inventory SET quantity = quantity + 1 WHERE id = 7",
      "UPDATE inventory SET quantity = 4 WHERE id IN (SELECT id FROM other)",
      "INSERT INTO inventory (id) SELECT id FROM other",
      "ALTER TABLE inventory DROP COLUMN quantity",
      "TRUNCATE TABLE inventory",
      "UPDATE inventory SET quantity = 4 WHERE id = 7; DELETE FROM inventory WHERE id = 8",
      "UPDATE inventory SET quantity = unsafe_function(id) WHERE id = 7",
    ]) {
      assert.throws(
        () => parseSqlChange(sql, dialect),
        undefined,
        `${dialect}: ${sql}`,
      );
    }
  }
});

test("structured column contracts reject unknown fields and unsupported changes", () => {
  const target = { schema: "public", table: "inventory" };
  assert.equal(
    StructuredColumnChangeSchema.safeParse({
      operation: "add_column",
      target: { ...target, unexpected: true },
      columnName: "note",
      columnType: "text",
    }).success,
    false,
  );
  for (const operation of [
    "drop_column",
    "alter_type",
    "set_default",
    "set_not_null",
    "add_generated_column",
    "add_index",
    "add_constraint",
  ]) {
    assert.equal(
      StructuredColumnChangeSchema.safeParse({
        operation,
        target,
        columnName: "note",
        columnType: "text",
      }).success,
      false,
      operation,
    );
  }
});

test("deep structured expressions fail preflight without recursive overflow", () => {
  let expression: unknown = { kind: "literal", value: 1 };
  for (let depth = 0; depth < 3_000; depth += 1) {
    expression = {
      kind: "binary",
      operator: "add",
      left: expression,
      right: { kind: "literal", value: 1 },
    };
  }
  const input = {
    operation: "add_and_backfill_column",
    target: { catalog: null, schema: "public", table: "inventory" },
    columnName: "copy",
    columnType: "integer",
    expression,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1_048_576);
  let result: ReturnType<typeof StructuredColumnChangeSchema.safeParse>;
  assert.doesNotThrow(() => {
    result = StructuredColumnChangeSchema.safeParse(input);
  });
  assert.equal(result!.success, false);
  if (!result!.success) {
    assert.match(
      result!.error.issues.map(({ message }) => message).join(" "),
      /structural safety bound/,
    );
  }
});

test("server-renders nullable normal add/backfill phases for all six dialects", async () => {
  for (const dialect of DIALECTS) {
    const adapter = previewAdapter();
    const prepared = await prepareStructuredColumnChange({
      adapter,
      dialect,
      change: {
        operation: "add_and_backfill_column",
        target: { schema: "public", table: "inventory" },
        columnName: "display_name",
        columnType: "text",
        expression: {
          kind: "coalesce",
          values: [
            { kind: "column", column: "name" },
            { kind: "literal", value: "unknown" },
          ],
        },
      },
      ...(dialect === "bigquery" ? { maximumBytesBilled: "1000000000" } : {}),
    });
    assert.match(prepared.canonicalSql, /^ALTER TABLE /, dialect);
    assert.match(prepared.canonicalSql, / NULL; UPDATE /, dialect);
    assert.doesNotMatch(
      prepared.canonicalSql,
      /GENERATED|VIRTUAL|DEFAULT/i,
      dialect,
    );
    assert.equal(prepared.expectedAffectedRows, 2, dialect);
    assert.deepEqual(prepared.executionStrategy.phases, [
      "column_added",
      "backfill_applied",
      "verified",
    ]);
    assert.equal(
      prepared.executionStrategy.mode,
      ["mysql", "snowflake", "bigquery"].includes(dialect)
        ? "idempotent_implicit_commit"
        : "transactional_ddl",
      dialect,
    );
  }
});

test("backfill expressions must be same-row, bounded, and reference existing columns", async () => {
  const adapter = previewAdapter();
  await assert.rejects(
    prepareStructuredColumnChange({
      adapter,
      dialect: "postgresql",
      change: {
        operation: "add_and_backfill_column",
        target: { schema: "public", table: "inventory" },
        columnName: "copy",
        columnType: "text",
        expression: { kind: "literal", value: "constant" },
      },
    }),
    /must reference at least one existing column/,
  );
  assert.equal(
    StructuredColumnChangeSchema.safeParse({
      operation: "add_and_backfill_column",
      target: { schema: "public", table: "inventory" },
      columnName: "copy",
      columnType: "text",
      expression: { kind: "function", name: "unsafe", arguments: [] },
    }).success,
    false,
  );
});

test("BigQuery backfill asserts preview, row count, and final values in one transaction", () => {
  const script = buildBigQueryBackfillScript({
    preconditionSql:
      "SELECT id, value + 1 AS copied_value FROM dataset.metrics",
    backfillSql: "UPDATE dataset.metrics SET copied_value = value + 1",
    verificationSql: "SELECT id, copied_value FROM dataset.metrics",
    expectedRows: ['{"id":1,"copied_value":11}'],
    expectedAffectedRows: 1,
  });
  assert.match(script, /^BEGIN TRANSACTION;/);
  assert.match(script, /stale backfill precondition/);
  assert.match(script, /UPDATE dataset\.metrics SET copied_value = value \+ 1/);
  assert.match(script, /ASSERT @@row_count = 1/);
  assert.match(script, /backfill verification mismatch/);
  assert.match(script, /COMMIT TRANSACTION;$/);
  assert.equal(script.match(/UPDATE dataset\.metrics/g)?.length, 1);
});

test("BigQuery row workflow estimates the exact asserted transaction script", () => {
  const script = buildBigQueryRowMutationScript({
    preconditionSql: "SELECT id, value FROM dataset.metrics WHERE id = 1",
    mutationSql: "UPDATE dataset.metrics SET value = 11 WHERE id = 1",
    expectedRows: ['{"id":1,"value":10}'],
    expectedAffectedRows: 1,
  });
  assert.match(script, /^BEGIN TRANSACTION;/);
  assert.match(script, /stale precondition/);
  assert.match(script, /UPDATE dataset\.metrics SET value = 11/);
  assert.match(script, /ASSERT @@row_count = 1/);
  assert.match(script, /COMMIT TRANSACTION;$/);
});

test("Snowflake stale-after-DDL carries partial provider evidence and requires fresh approval", () => {
  const stale = new Error("stale row hashes");
  stale.name = "SqlChangeStaleError";
  const partial = snowflakeImplicitDdlOutcome(stale, {
    ddlCompleted: true,
    skipDdl: false,
    ddlStatementId: "01b12345-0000-0000-0000-000000000001",
  });
  assert.ok(partial instanceof Error);
  assert.equal(partial.name, "SqlChangePartialCommitError");
  assert.equal(
    (partial as Error & { providerExecutionId?: unknown }).providerExecutionId,
    "01b12345-0000-0000-0000-000000000001",
  );
  assert.equal(
    (
      partial as Error & {
        verification?: Record<string, unknown>;
      }
    ).verification?.freshApprovalRequired,
    true,
  );
  assert.equal(
    (partial as Error & { verification?: Record<string, unknown> }).verification
      ?.terminal,
    true,
  );
  assert.equal(
    "resumable" in
      ((partial as Error & { verification?: Record<string, unknown> })
        .verification ?? {}),
    false,
  );

  assert.equal(
    snowflakeImplicitDdlOutcome(stale, {
      ddlCompleted: true,
      skipDdl: true,
      ddlStatementId: undefined,
    }),
    stale,
  );
});

test("implicit-DDL reconciliation requires exact physical column definitions", () => {
  const fixtures: Array<
    [
      SqlChangeDialect,
      Parameters<typeof structuredColumnTypeMatches>[1],
      Column,
    ]
  > = [
    [
      "postgresql",
      "decimal",
      physicalColumn("numeric", { precision: 38, scale: 9 }),
    ],
    [
      "redshift",
      "text",
      physicalColumn("character varying", { maxLength: 65_535 }),
    ],
    [
      "mysql",
      "integer",
      physicalColumn("int", {
        physicalType: "int",
        precision: 10,
        scale: 0,
      }),
    ],
    [
      "transactsql",
      "text",
      physicalColumn("nvarchar", {
        maxLength: 8_000,
        precision: 0,
        scale: 0,
      }),
    ],
    ["snowflake", "text", physicalColumn("VARCHAR", { maxLength: 16_777_216 })],
    ["bigquery", "timestamp", physicalColumn("TIMESTAMP")],
  ];
  for (const [dialect, requested, column] of fixtures) {
    assert.equal(
      structuredColumnTypeMatches(column, requested, dialect),
      true,
      `${dialect} exact physical definition`,
    );
  }

  assert.equal(
    structuredColumnTypeMatches(
      physicalColumn("int", {
        physicalType: "int unsigned",
        precision: 10,
        scale: 0,
      }),
      "integer",
      "mysql",
    ),
    false,
    "MySQL INT UNSIGNED is not the approved signed integer",
  );
  assert.equal(
    structuredColumnTypeMatches(
      physicalColumn("varchar", {
        physicalType: "varchar(1)",
        maxLength: 1,
      }),
      "text",
      "mysql",
    ),
    false,
    "MySQL VARCHAR(1) is not TEXT",
  );
  assert.equal(
    structuredColumnTypeMatches(
      physicalColumn("NUMBER", { precision: 38, scale: 9 }),
      "integer",
      "snowflake",
    ),
    false,
    "Snowflake NUMBER(38,9) is not INTEGER/NUMBER(38,0)",
  );
  assert.equal(
    structuredColumnTypeMatches(
      physicalColumn("VARCHAR", { maxLength: 1 }),
      "text",
      "snowflake",
    ),
    false,
    "Snowflake VARCHAR(1) is not unbounded VARCHAR",
  );
  assert.equal(
    structuredColumnTypeMatches(
      physicalColumn("VARCHAR", {
        maxLength: 16_777_216,
        defaultValue: "",
      }),
      "text",
      "snowflake",
    ),
    false,
    "an empty-string default is not no default",
  );
  assert.equal(
    structuredColumnTypeMatches(
      physicalColumn("VARCHAR", {
        maxLength: 16_777_216,
        isNullable: false,
      }),
      "text",
      "snowflake",
    ),
    false,
    "a non-nullable column is not the approved nullable definition",
  );
  assert.equal(
    structuredColumnTypeMatches(
      physicalColumn("VARCHAR", {
        maxLength: 16_777_216,
        defaultValue: "'fallback'",
      }),
      "text",
      "snowflake",
    ),
    false,
    "an explicit default is not no default",
  );
});

test("skip-DDL execution evidence excludes the approved but unexecuted DDL", () => {
  const ddlSql = "ALTER TABLE inventory ADD COLUMN copy int NULL";
  const executed = executedStructuredStatements({
    ddlSql,
    backfillSql: "UPDATE inventory SET copy = value",
    preconditionSql: "SELECT id, value, copy FROM inventory",
    verificationSql: "SELECT id, value, copy FROM inventory",
    maximumRows: 100,
    skipDdl: true,
  });
  assert.doesNotMatch(executed, /ALTER TABLE/);
  assert.match(executed, /^START TRANSACTION\n/);
  assert.match(executed, /FOR UPDATE\nUPDATE inventory SET copy = value/);
  assert.match(executed, /LIMIT 101\nCOMMIT$/);
});

test("BigQuery workflow budget rejects before the first paid preview read", async () => {
  const adapter = previewAdapter();
  let paidReads = 0;
  adapter.queryReadOnly = async () => {
    paidReads += 1;
    throw new Error("paid preview must not run");
  };
  adapter.estimateControlledMutation = async () => ({
    dryRunBytesProcessed: "60",
  });
  await assert.rejects(
    prepareStructuredColumnChange({
      adapter,
      dialect: "bigquery",
      maximumBytesBilled: "100",
      change: {
        operation: "add_and_backfill_column",
        target: {
          catalog: "project",
          schema: "dataset",
          table: "inventory",
        },
        columnName: "display_name",
        columnType: "text",
        expression: { kind: "column", column: "name" },
      },
    }),
    /cost limit/,
  );
  assert.equal(paidReads, 0);
});

test("Snowflake fresh reconciliation skips committed DDL only for an all-null matching column", async () => {
  const adapter = partialColumnPreviewAdapter(null);
  const prepared = await prepareStructuredColumnChange({
    adapter,
    dialect: "snowflake",
    change: {
      operation: "add_and_backfill_column",
      target: { catalog: "DB", schema: "PUBLIC", table: "INVENTORY" },
      columnName: "display_name",
      columnType: "text",
      expression: { kind: "column", column: "name" },
    },
  });
  assert.equal(prepared.executionStrategy.ddlAlreadyCommitted, true);
  assert.deepEqual(prepared.executionStrategy.phases, [
    "column_already_added",
    "backfill_applied",
    "verified",
  ]);
  assert.notDeepEqual(
    prepared.preconditions.preconditionRowHashes,
    prepared.preconditions.rowHashes,
  );

  await assert.rejects(
    prepareStructuredColumnChange({
      adapter: partialColumnPreviewAdapter("already populated"),
      dialect: "snowflake",
      change: {
        operation: "add_and_backfill_column",
        target: { catalog: "DB", schema: "PUBLIC", table: "INVENTORY" },
        columnName: "display_name",
        columnType: "text",
        expression: { kind: "column", column: "name" },
      },
    }),
    /contains values/,
  );
});

function previewAdapter(): DatabaseAdapter {
  return {
    async initialize() {},
    async query() {
      throw new Error("ordinary query path must not be used");
    },
    async queryReadOnly(sql) {
      if (sql.includes("TO_JSON_STRING(tf_row) AS tf_row_json")) {
        return {
          rows: [
            { tf_row_json: '{"id":1,"name":"one"}' },
            { tf_row_json: '{"id":2,"name":null}' },
          ],
          rowCount: 2,
          fields: [],
          hasMoreRows: false,
          bytesProcessed: "10",
        };
      }
      return {
        rows: [
          { id: 1, name: "one", display_name: "one" },
          { id: 2, name: null, display_name: "unknown" },
        ],
        rowCount: 2,
        fields: [],
        hasMoreRows: false,
        bytesProcessed: "10",
      };
    },
    async estimateControlledMutation() {
      return { dryRunBytesProcessed: "10" };
    },
    async testConnection() {
      return true;
    },
    async close() {},
    getDataSourceType() {
      return "postgres";
    },
    introspect() {
      return {
        async getDatabases() {
          return [];
        },
        async getSchemas() {
          return [];
        },
        async getTables() {
          return [];
        },
        async getColumns() {
          return [
            {
              name: "id",
              dataType: "integer",
              isNullable: false,
              isPrimaryKey: true,
              defaultValue: undefined,
              position: 1,
            },
            {
              name: "name",
              dataType: "text",
              isNullable: true,
              isPrimaryKey: false,
              defaultValue: undefined,
              position: 2,
            },
          ];
        },
        async getViews() {
          return [];
        },
        async getTableStatistics() {
          return null;
        },
        async getColumnStatistics() {
          return [];
        },
        async getIntrospectionResult() {
          throw new Error("not used");
        },
      };
    },
  };
}

function partialColumnPreviewAdapter(
  existingValue: string | null,
): DatabaseAdapter {
  const adapter = previewAdapter();
  adapter.queryReadOnly = async () => ({
    rows: [
      {
        id: 1,
        name: "one",
        __trueforge_existing_destination: existingValue,
        display_name: "one",
      },
    ],
    rowCount: 1,
    fields: [],
    hasMoreRows: false,
  });
  const introspector = adapter.introspect();
  introspector.getColumns = async () => [
    {
      name: "id",
      dataType: "integer",
      isNullable: false,
      isPrimaryKey: true,
      defaultValue: undefined,
      position: 1,
    },
    {
      name: "name",
      dataType: "text",
      isNullable: true,
      isPrimaryKey: false,
      defaultValue: undefined,
      position: 2,
    },
    {
      name: "display_name",
      dataType: "VARCHAR",
      physicalType: "VARCHAR",
      isNullable: true,
      isPrimaryKey: false,
      defaultValue: undefined,
      maxLength: 16_777_216,
      position: 3,
    },
  ];
  adapter.introspect = () => introspector;
  return adapter;
}

function physicalColumn(
  dataType: string,
  overrides: Partial<Column> = {},
): Column {
  return {
    name: "copy",
    table: "inventory",
    schema: "public",
    database: "analytics",
    position: 3,
    dataType,
    isNullable: true,
    ...overrides,
  };
}
