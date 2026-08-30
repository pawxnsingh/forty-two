import assert from "node:assert/strict";

import { MySQLAdapter } from "../src/adapters/mysql.js";
import { DataSourceType } from "../src/types/credentials.js";

const port = Number(process.env.MYSQL_INTEGRATION_PORT);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("MYSQL_INTEGRATION_PORT is required");
}

const adapter = new MySQLAdapter();
await adapter.initialize({
  type: DataSourceType.MySQL,
  host: "127.0.0.1",
  port,
  default_database: "integration",
  username: "root",
  password: "integration-secret",
});

try {
  await adapter.executeWrite?.(
    "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50))",
  );
  await adapter.executeWrite?.(
    "CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, amount INT)",
  );
  for (let index = 1; index <= 5; index += 1) {
    await adapter.executeWrite?.("INSERT INTO users VALUES (?, ?)", [
      index,
      `user-${index}`,
    ]);
    await adapter.executeWrite?.("INSERT INTO orders VALUES (?, ?, ?)", [
      index,
      index,
      index * 10,
    ]);
  }

  const duplicateColumns = await adapter.query(
    "SELECT u.id, o.id FROM users u JOIN orders o ON o.user_id = u.id ORDER BY u.id LIMIT 1",
    undefined,
    10,
  );
  assert.deepEqual(
    duplicateColumns.fields.map((field) => field.name),
    ["id", "id"],
  );

  for (const sql of [
    "SELECT 1; -- trailing note",
    "SELECT 1 # trailing hash note",
    "SELECT 1 /* trailing block note */",
    "WITH selected AS (SELECT id FROM users) SELECT id FROM selected ORDER BY id LIMIT 2",
    "SELECT id FROM users ORDER BY id DESC LIMIT 2 OFFSET 1",
  ]) {
    const result = await adapter.query(sql, undefined, 10);
    assert.ok(result.rows.length > 0, sql);
  }

  const parameterized = await adapter.query(
    "SELECT id FROM users WHERE id > ? ORDER BY id",
    [2],
    10,
  );
  assert.equal(parameterized.rows.length, 3);

  const bounded = await adapter.query(
    "SELECT id FROM users ORDER BY id",
    undefined,
    2,
  );
  assert.equal(bounded.rows.length, 2);
  assert.equal(bounded.hasMoreRows, true);

  const exactNumbers = await adapter.query(
    `SELECT
       CAST(9223372036854775807 AS SIGNED) AS signed_bigint,
       CAST(18446744073709551615 AS UNSIGNED) AS unsigned_bigint,
       CAST(12345678901234567890.1234567890 AS DECIMAL(30, 10)) AS exact_decimal,
       CAST(NULL AS SIGNED) AS null_bigint,
       CAST(NULL AS DECIMAL(30, 10)) AS null_decimal`,
    undefined,
    10,
  );
  assert.deepEqual(exactNumbers.rows, [
    {
      signed_bigint: "9223372036854775807",
      unsigned_bigint: "18446744073709551615",
      exact_decimal: "12345678901234567890.1234567890",
      null_bigint: null,
      null_decimal: null,
    },
  ]);
  assert.deepEqual(
    exactNumbers.fields.map(({ name, type }) => ({ name, type })),
    [
      { name: "signed_bigint", type: "bigint" },
      { name: "unsigned_bigint", type: "bigint" },
      { name: "exact_decimal", type: "decimal" },
      { name: "null_bigint", type: "bigint" },
      { name: "null_decimal", type: "decimal" },
    ],
  );

  const reconnected = await adapter.query(
    "SELECT COUNT(*) AS total FROM users",
  );
  assert.equal(reconnected.rows[0]?.total, "5");

  const activeQuery = adapter.query("SELECT SLEEP(0.25) AS waited");
  let closeSettled = false;
  const closing = adapter.close().then(() => {
    closeSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closeSettled, false);
  const activeResult = await activeQuery;
  await closing;
  assert.equal(activeResult.rows[0]?.waited, "0");
} finally {
  await adapter.close();
}
