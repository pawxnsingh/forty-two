import assert from "node:assert/strict";
import test from "node:test";

import {
  inferTableColumnsV1,
  serializeQueryResultTableV1,
} from "../src/table-v1.js";

test("all-null inference does not vacuously become boolean", () => {
  assert.deepEqual(inferTableColumnsV1([{ value: null }, { value: null }]), [
    { name: "value", type: "string", nullable: true },
  ]);
});

test("nonfinite inference treats canonicalized nulls as nullable", () => {
  const columns = inferTableColumnsV1([{ value: Number.NaN }, { value: 2 }]);
  assert.deepEqual(columns, [
    { name: "value", type: "integer", nullable: true },
  ]);
});

test("authoritative connector metadata preserves all-null numeric types and precision", () => {
  const table = serializeQueryResultTableV1({
    columns: [
      {
        name: "pg_numeric",
        type: "numeric",
        nullable: true,
        precision: 38,
        scale: 18,
      },
      {
        name: "mysql_decimal",
        type: "decimal",
        nullable: false,
        precision: 30,
        scale: 10,
      },
      { name: "bigquery_int", type: "bigint", nullable: false },
      { name: "snowflake_number", type: "NUMBER(38, 9)", nullable: true },
    ],
    rows: [
      {
        pg_numeric: null,
        mysql_decimal: "12345678901234567890.1234567890",
        bigquery_int: "9223372036854775807",
        snowflake_number: "0.000000001",
      },
    ],
  });
  assert.deepEqual(table.columns, [
    { name: "pg_numeric", type: "decimal", nullable: true, encoding: "string" },
    {
      name: "mysql_decimal",
      type: "decimal",
      nullable: false,
      encoding: "string",
    },
    {
      name: "bigquery_int",
      type: "integer",
      nullable: false,
      encoding: "string",
    },
    {
      name: "snowflake_number",
      type: "decimal",
      nullable: true,
      encoding: "string",
    },
  ]);
  assert.equal(table.rows[0]!.mysql_decimal, "12345678901234567890.1234567890");
  assert.equal(table.rows[0]!.bigquery_int, "9223372036854775807");
});

test("PostgreSQL physical timestamp names remain datetime columns", () => {
  const table = serializeQueryResultTableV1({
    columns: [
      { name: "zoned", type: "timestamp with time zone", nullable: false },
      { name: "local", type: "timestamp without time zone", nullable: false },
    ],
    rows: [
      {
        zoned: "2026-08-30T00:00:00.000Z",
        local: "2026-08-30T00:00:00.000Z",
      },
    ],
  });
  assert.deepEqual(
    table.columns.map((column) => column.type),
    ["datetime", "datetime"],
  );
});
