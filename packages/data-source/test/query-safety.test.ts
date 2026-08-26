import assert from "node:assert/strict";
import test from "node:test";

import { convertPositionalPlaceholders } from "../src/adapters/helpers/positional-placeholders.js";
import {
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteStringLiteral,
} from "../src/introspection/sql-quoting.js";
import { resolveQueryTimeout } from "../src/utils/query-options.js";
import { checkQueryIsReadOnly } from "../src/utils/sql-validation.js";

test("rejects SELECT INTO and locking reads", () => {
  assert.equal(
    checkQueryIsReadOnly("SELECT * INTO copied_orders FROM orders", "postgres")
      .isReadOnly,
    false,
  );
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

test("rejects positional placeholder count mismatches", () => {
  assert.throws(
    () => convertPositionalPlaceholders("SELECT ?", 2, String),
    /placeholder count/i,
  );
});

test("quotes discovered identifiers and literals for every SQL family", () => {
  assert.equal(quoteIdentifier('sales"archive', "postgresql"), '"sales""archive"');
  assert.equal(quoteIdentifier("sales`archive", "mysql"), "`sales``archive`");
  assert.equal(quoteIdentifier("sales]archive", "sqlserver"), "[sales]]archive]");
  assert.equal(
    quoteQualifiedIdentifier(["analytics", 'order"items'], "postgresql"),
    '"analytics"."order""items"',
  );
  assert.equal(quoteStringLiteral("team's orders"), "'team''s orders'");
});
