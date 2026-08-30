import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSqlChangeTarget,
  parseSqlChange,
  SqlChangePartialCommitError,
} from "@forty-two/data-source";

import {
  ApplySqlChangeInputSchema,
  assertBigQueryApplyCost,
  assertCurrentRowLimit,
  assertPreparedResourceEstimate,
  PrepareSqlChangeInputSchema,
  PrepareSqlChangeToolInputSchema,
  requireAllowedTarget,
  isResumableSqlChangeError,
} from "../src/sql-change-service.js";

const sessionId = "sess_01HZX000000000000000000001";
const dataSourceId = "ds_01HZX000000000000000000001";

test("accepts every strict prepare operation and rejects nested unknown fields", () => {
  const target = { catalog: null, schema: "public", table: "metrics" };
  for (const input of [
    {
      sessionId,
      dataSourceId,
      operation: "insert",
      sql: "INSERT INTO metrics (id, value) VALUES (2, 7)",
    },
    {
      sessionId,
      dataSourceId,
      operation: "update",
      sql: "UPDATE metrics SET value = 7 WHERE id = 2",
    },
    {
      sessionId,
      dataSourceId,
      operation: "delete",
      sql: "DELETE FROM metrics WHERE id = 2",
    },
    {
      sessionId,
      dataSourceId,
      operation: "add_column",
      target,
      columnName: "note",
      columnType: "text",
    },
    {
      sessionId,
      dataSourceId,
      operation: "rename_column",
      target,
      sourceColumn: "note",
      destinationColumn: "description",
    },
    {
      sessionId,
      dataSourceId,
      operation: "add_and_backfill_column",
      target,
      columnName: "copied_value",
      columnType: "integer",
      expression: { kind: "column", column: "value" },
    },
  ]) {
    assert.equal(PrepareSqlChangeInputSchema.safeParse(input).success, true);
  }

  assert.equal(
    PrepareSqlChangeInputSchema.safeParse({
      sessionId,
      dataSourceId,
      operation: "add_column",
      target: { ...target, injected: true },
      columnName: "note",
      columnType: "text",
    }).success,
    false,
  );
  assert.equal(
    PrepareSqlChangeInputSchema.safeParse({
      sessionId,
      dataSourceId,
      operation: "drop_column",
      target,
      columnName: "value",
    }).success,
    false,
  );
});

test("both published prepare schemas preflight deep expressions before recursion", () => {
  const input = {
    sessionId,
    dataSourceId,
    operation: "add_and_backfill_column",
    target: { catalog: null, schema: "public", table: "metrics" },
    columnName: "copied_value",
    columnType: "integer",
    expression: deeplyNestedExpression(3_000),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1_048_576);
  for (const schema of [
    PrepareSqlChangeInputSchema,
    PrepareSqlChangeToolInputSchema,
  ]) {
    let result: ReturnType<typeof schema.safeParse> | undefined;
    assert.doesNotThrow(() => {
      result = schema.safeParse(input);
    });
    assert.equal(result?.success, false);
    if (result && !result.success) {
      assert.match(
        result.error.issues.map(({ message }) => message).join(" "),
        /structural safety bound/,
      );
    }
    assert.equal(schema.safeParse({ ...input, injected: true }).success, false);
  }
});

test("apply accepts only the immutable visible approval contract", () => {
  const approval = {
    changeSetId: "change_01HZX000000000000000000001",
    sessionId,
    dataSourceId,
    connector: "postgresql",
    operation: "update",
    target: { catalog: null, schema: "public", table: "metrics" },
    canonicalSql: "UPDATE metrics SET value = 7 WHERE id = 2",
    statementHash: "a".repeat(64),
    expectedAffectedRows: 1,
    resourceEstimate: null,
  };
  assert.equal(ApplySqlChangeInputSchema.safeParse(approval).success, true);
  assert.equal(
    ApplySqlChangeInputSchema.safeParse({ ...approval, approved: true })
      .success,
    false,
  );
  assert.equal(
    ApplySqlChangeInputSchema.safeParse({
      ...approval,
      sql: "DELETE FROM metrics",
    }).success,
    false,
  );
});

function deeplyNestedExpression(depth: number): unknown {
  let expression: unknown = { kind: "literal", value: 1 };
  for (let index = 0; index < depth; index += 1) {
    expression = {
      kind: "binary",
      operator: "add",
      left: expression,
      right: { kind: "literal", value: 1 },
    };
  }
  return expression;
}

test("prepare and apply scope helpers require an exact allowlisted table", () => {
  for (const connectorType of [
    "postgresql",
    "mysql",
    "sqlserver",
    "snowflake",
    "bigquery",
    "redshift",
  ] as const) {
    const mutation = {
      mode: "controlled" as const,
      connectorType,
      credentialRevision: 1,
      allowedCatalog: "analytics",
      allowedSchema: "reporting",
      allowedTargets: [
        { catalog: "analytics", schema: "reporting", table: "metrics" },
      ],
    };
    assert.deepEqual(
      requireAllowedTarget(
        { catalog: null, schema: null, table: "METRICS" },
        mutation,
      ),
      { catalog: "analytics", schema: "reporting", table: "metrics" },
      connectorType,
    );
    assert.throws(
      () =>
        requireAllowedTarget(
          { catalog: null, schema: null, table: "unrelated" },
          mutation,
        ),
      /allowlist/,
      connectorType,
    );
  }
});

test("qualified MySQL DML normalizes before the earliest allowlist check", () => {
  const mutation = {
    mode: "controlled" as const,
    connectorType: "mysql" as const,
    credentialRevision: 1,
    allowedCatalog: "forty_two_demo",
    allowedSchema: null,
    allowedTargets: [
      { catalog: "forty_two_demo", schema: null, table: "metrics" },
    ],
  };
  const qualified = normalizeSqlChangeTarget(
    parseSqlChange(
      "UPDATE `forty_two_demo`.`metrics` SET value = 7 WHERE id = 2",
      "mysql",
    ).target,
    "mysql",
  );
  assert.deepEqual(requireAllowedTarget(qualified, mutation), {
    catalog: "forty_two_demo",
    schema: null,
    table: "metrics",
  });
  const alternate = normalizeSqlChangeTarget(
    parseSqlChange(
      "UPDATE `other_database`.`metrics` SET value = 7 WHERE id = 2",
      "mysql",
    ).target,
    "mysql",
  );
  assert.throws(() => requireAllowedTarget(alternate, mutation), /allowlist/);
});

test("quoted row targets cannot alias an unquoted allowlist entry", () => {
  const mutation = {
    mode: "controlled" as const,
    connectorType: "postgresql" as const,
    credentialRevision: 1,
    allowedCatalog: null,
    allowedSchema: "public",
    allowedTargets: [{ catalog: null, schema: "public", table: "users" }],
  };
  const quoted = normalizeSqlChangeTarget(
    parseSqlChange(
      'UPDATE public."USERS" SET enabled = TRUE WHERE id = 1',
      "postgresql",
    ).target,
    "postgresql",
  );
  assert.throws(
    () => requireAllowedTarget(quoted, mutation),
    /Quoted|allowlist/,
  );
  const exactlyQuoted = normalizeSqlChangeTarget(
    parseSqlChange(
      'UPDATE public."users" SET enabled = TRUE WHERE id = 1',
      "postgresql",
    ).target,
    "postgresql",
  );
  assert.deepEqual(requireAllowedTarget(exactlyQuoted, mutation), {
    catalog: null,
    schema: "public",
    table: "users",
  });
  const mixed = normalizeSqlChangeTarget(
    parseSqlChange(
      'UPDATE PUBLIC."users" SET enabled = TRUE WHERE id = 1',
      "postgresql",
    ).target,
    "postgresql",
  );
  assert.deepEqual(requireAllowedTarget(mixed, mutation), {
    catalog: null,
    schema: "public",
    table: "users",
  });
  assert.deepEqual(
    requireAllowedTarget(
      normalizeSqlChangeTarget(
        parseSqlChange(
          "UPDATE public.users SET enabled = TRUE WHERE id = 1",
          "postgresql",
        ).target,
        "postgresql",
      ),
      mutation,
    ),
    { catalog: null, schema: "public", table: "users" },
  );
});

test("BigQuery cost cap rejects excessive or missing prepare evidence", () => {
  const previous = process.env.SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED;
  process.env.SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED = "1000";
  try {
    assert.equal(
      assertPreparedResourceEstimate("bigquery", "update", {
        dryRunBytesProcessed: "1000",
        workflowBytesProcessed: "1000",
        previewBytesProcessed: "400",
        transactionBytesProcessed: "600",
        paidReadJobBytesProcessed: ["200", "200"],
      }),
      "1000",
    );
    assert.throws(
      () =>
        assertPreparedResourceEstimate("bigquery", "update", {
          dryRunBytesProcessed: "1001",
          workflowBytesProcessed: "1001",
          previewBytesProcessed: "400",
          transactionBytesProcessed: "601",
          paidReadJobBytesProcessed: ["200", "200"],
        }),
      /cost limit/,
    );
    assert.throws(
      () => assertPreparedResourceEstimate("bigquery", "update", null),
      /evidence/,
    );
    assert.throws(
      () =>
        assertPreparedResourceEstimate("bigquery", "update", {
          dryRunBytesProcessed: "100",
        }),
      /evidence/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED;
    } else {
      process.env.SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED = previous;
    }
  }
});

test("apply revalidates the current configured row cap", () => {
  const previous = process.env.SQL_CHANGE_MAX_ROWS;
  process.env.SQL_CHANGE_MAX_ROWS = "2";
  try {
    assert.equal(assertCurrentRowLimit(2), 2);
    assert.throws(() => assertCurrentRowLimit(3), /current row limit/);
  } finally {
    if (previous === undefined) delete process.env.SQL_CHANGE_MAX_ROWS;
    else process.env.SQL_CHANGE_MAX_ROWS = previous;
  }
});

test("apply rejects increased or newly over-cap BigQuery cost", () => {
  const previous = process.env.SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED;
  process.env.SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED = "1000";
  try {
    assert.equal(
      assertBigQueryApplyCost({
        approved: {
          dryRunBytesProcessed: "900",
          workflowBytesProcessed: "900",
          previewBytesProcessed: "300",
          transactionBytesProcessed: "600",
          paidReadJobBytesProcessed: ["150", "150"],
        },
        current: { dryRunBytesProcessed: "600" },
      }),
      "600",
    );
    assert.throws(
      () =>
        assertBigQueryApplyCost({
          approved: {
            dryRunBytesProcessed: "900",
            workflowBytesProcessed: "900",
            previewBytesProcessed: "300",
            transactionBytesProcessed: "600",
            paidReadJobBytesProcessed: ["150", "150"],
          },
          current: { dryRunBytesProcessed: "601" },
        }),
      /stale/,
    );
    assert.throws(
      () =>
        assertBigQueryApplyCost({
          approved: {
            dryRunBytesProcessed: "900",
            workflowBytesProcessed: "900",
            previewBytesProcessed: "600",
            transactionBytesProcessed: "300",
            paidReadJobBytesProcessed: ["300", "300"],
          },
          current: { dryRunBytesProcessed: "301" },
        }),
      /stale/,
    );
    assert.throws(
      () =>
        assertBigQueryApplyCost({
          approved: { dryRunBytesProcessed: "900" },
          current: { dryRunBytesProcessed: "300" },
        }),
      /evidence/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED;
    } else {
      process.env.SQL_CHANGE_MAX_BIGQUERY_BYTES_BILLED = previous;
    }
  }
});

test("implicit-commit resume requires an explicit provider-safe signal", () => {
  assert.equal(isResumableSqlChangeError(new Error("generic failure")), false);
  const resumable = new Error("provider phase can be reconciled");
  resumable.name = "SqlChangeResumeRequiredError";
  assert.equal(isResumableSqlChangeError(resumable), true);
  const stale = new Error("stale");
  stale.name = "SqlChangeStaleError";
  assert.equal(isResumableSqlChangeError(stale), false);
  const partial = new SqlChangePartialCommitError(
    "DDL committed",
    "provider-ddl-id",
    {
      phase: "partial_ddl_committed",
      ddlCommitted: true,
      terminal: true,
      freshApprovalRequired: true,
    },
  );
  assert.equal(isResumableSqlChangeError(partial), false);
});
