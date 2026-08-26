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
  );
  assert.equal(result.placeholderCount, 1);
  assert.match(result.sql, /@param0 AS value # explanation\?/);
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
  const introspector = new BigQueryIntrospector("analytics", adapter);

  await introspector.getTables("project-a");
  await introspector.getColumns("project-a", "dataset-b", "orders");
  await introspector.getViews(undefined, "dataset-b");

  assert.match(queries[0] ?? "", /table_catalog = 'project-a'/);
  assert.doesNotMatch(queries[0] ?? "", /table_schema = 'project-a'/);
  assert.match(queries[1] ?? "", /table_catalog = 'project-a'/);
  assert.match(queries[1] ?? "", /table_schema = 'dataset-b'/);
  assert.match(queries[1] ?? "", /table_name = 'orders'/);
  assert.match(queries[2] ?? "", /table_schema = 'dataset-b'/);
});
