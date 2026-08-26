import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseAdapter } from "../src/adapters/base.js";
import { convertPositionalPlaceholders } from "../src/adapters/helpers/positional-placeholders.js";
import { BigQueryIntrospector } from "../src/introspection/bigquery.js";
import {
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteStringLiteral,
} from "../src/introspection/sql-quoting.js";
import { resolveQueryTimeout } from "../src/utils/query-options.js";
import { checkQueryIsReadOnly } from "../src/utils/sql-validation.js";

test("rejects SELECT INTO and locking reads", () => {
  for (const sql of [
    "SELECT * INTO copied_orders FROM orders",
    "WITH recent AS (SELECT * FROM orders) SELECT * INTO copied_orders FROM recent",
    "SELECT id INTO TEMP temporary_orders FROM orders",
  ]) {
    assert.equal(checkQueryIsReadOnly(sql, "postgres").isReadOnly, false);
  }
  assert.equal(
    checkQueryIsReadOnly("SELECT * FROM orders FOR UPDATE", "postgres")
      .isReadOnly,
    false,
  );
});

test("accepts ordinary read-only queries", () => {
  assert.equal(
    checkQueryIsReadOnly(
      "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent",
      "postgres",
    ).isReadOnly,
    true,
  );
});

test("rejects SQL Server locking table hints", () => {
  for (const hint of ["UPDLOCK", "XLOCK", "HOLDLOCK", "TABLOCKX"]) {
    assert.equal(
      checkQueryIsReadOnly(
        `SELECT * FROM orders WITH (${hint}) WHERE id = 1`,
        "sqlserver",
      ).isReadOnly,
      false,
    );
  }
});

test("validates query timeout before SQL interpolation", () => {
  assert.equal(resolveQueryTimeout(30_000), 30_000);
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => resolveQueryTimeout(invalid));
  }
});

test("replaces only real positional placeholders", () => {
  const sql = [
    "SELECT '?' AS literal, [question?] AS bracketed",
    "FROM orders",
    "WHERE id = ? AND note = 'still ?'",
    "-- ignored ?",
    "AND status = ? /* ignored ? */",
  ].join("\n");

  const result = convertPositionalPlaceholders(
    sql,
    2,
    (index) => `@param${index}`,
  );

  assert.equal(result.placeholderCount, 2);
  assert.match(result.sql, /id = @param0/);
  assert.match(result.sql, /status = @param1/);
  assert.match(result.sql, /'still \?'/);
  assert.match(result.sql, /ignored \?/);
});

test("does not consume placeholders inside GoogleSQL hash comments", () => {
  const result = convertPositionalPlaceholders(
    "SELECT ? AS value # explanation?\n, '?' AS marker",
    1,
    (index) => `@param${index}`,
    { hashLineComments: true },
  );
  assert.equal(result.placeholderCount, 1);
  assert.match(result.sql, /@param0 AS value # explanation\?/);
});

test("preserves SQL Server temporary tables while replacing parameters", () => {
  const result = convertPositionalPlaceholders(
    "SELECT * FROM #orders WHERE id = ?",
    1,
    (index) => `@param${index}`,
  );
  assert.equal(result.sql, "SELECT * FROM #orders WHERE id = @param0");
});

test("rejects positional placeholder count mismatches", () => {
  assert.throws(
    () => convertPositionalPlaceholders("SELECT ?", 2, String),
    /placeholder count/i,
  );
});

test("quotes discovered identifiers and literals for every SQL family", () => {
  assert.equal(
    quoteIdentifier('sales"archive', "postgresql"),
    '"sales""archive"',
  );
  assert.equal(quoteIdentifier("sales`archive", "mysql"), "`sales``archive`");
  assert.equal(
    quoteIdentifier("sales]archive", "sqlserver"),
    "[sales]]archive]",
  );
  assert.equal(
    quoteQualifiedIdentifier(["analytics", 'order"items'], "postgresql"),
    '"analytics"."order""items"',
  );
  assert.equal(
    quoteQualifiedIdentifier(
      ["project-a", "dataset-b", "INFORMATION_SCHEMA", "TABLES"],
      "bigquery",
    ),
    "`project-a.dataset-b.INFORMATION_SCHEMA.TABLES`",
  );
  assert.equal(quoteStringLiteral("team's orders"), "'team''s orders'");
});

test("BigQuery filters project and dataset independently", async () => {
  const queries: string[] = [];
  const adapter = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [], fields: [], rowCount: 0 };
    },
  } as unknown as DatabaseAdapter;
  const introspector = new BigQueryIntrospector(
    "analytics",
    adapter,
    "project-a",
    "US",
  );

  await introspector.getTables("project-a", "dataset-b");
  await introspector.getColumns("project-a", "dataset-b", "orders");
  await introspector.getViews(undefined, "dataset-b");

  assert.match(
    queries[0] ?? "",
    /`project-a\.dataset-b\.INFORMATION_SCHEMA\.TABLES`/,
  );
  assert.match(queries[0] ?? "", /table_catalog = 'project-a'/);
  assert.match(queries[0] ?? "", /table_schema = 'dataset-b'/);
  assert.match(
    queries[1] ?? "",
    /`project-a\.dataset-b\.INFORMATION_SCHEMA\.COLUMNS`/,
  );
  assert.match(queries[1] ?? "", /table_catalog = 'project-a'/);
  assert.match(queries[1] ?? "", /table_schema = 'dataset-b'/);
  assert.match(queries[1] ?? "", /table_name = 'orders'/);
  assert.match(
    queries[2] ?? "",
    /`project-a\.dataset-b\.INFORMATION_SCHEMA\.VIEWS`/,
  );
  assert.match(queries[2] ?? "", /table_schema = 'dataset-b'/);
});

test("BigQuery models projects as databases and datasets as schemas", async () => {
  const queries: string[] = [];
  const adapter = {
    query: async (sql: string) => {
      queries.push(sql);
      return {
        rows: [
          {
            dataset_name: "dataset-b",
            project_name: "project-a",
            location: "US",
            creation_time: "2026-01-01T00:00:00.000Z",
          },
        ],
        fields: [],
        rowCount: 1,
      };
    },
  } as unknown as DatabaseAdapter;
  const introspector = new BigQueryIntrospector(
    "analytics",
    adapter,
    "project-a",
    "US",
  );

  const databases = await introspector.getDatabases();
  const schemas = await introspector.getSchemas("project-a");

  assert.equal(databases[0]?.name, "project-a");
  assert.equal(schemas[0]?.name, "dataset-b");
  assert.equal(schemas[0]?.database, "project-a");
  assert.match(
    queries[0] ?? "",
    /`project-a\.region-us\.INFORMATION_SCHEMA\.SCHEMATA`/,
  );
});
