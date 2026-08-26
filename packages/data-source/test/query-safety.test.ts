import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseAdapter } from "../src/adapters/base.js";
import { BigQueryAdapter } from "../src/adapters/bigquery.js";
import { convertPositionalPlaceholders } from "../src/adapters/helpers/positional-placeholders.js";
import { MySQLAdapter } from "../src/adapters/mysql.js";
import { PostgreSQLAdapter } from "../src/adapters/postgresql.js";
import { RedshiftAdapter } from "../src/adapters/redshift.js";
import { BigQueryIntrospector } from "../src/introspection/bigquery.js";
import { MySQLIntrospector } from "../src/introspection/mysql.js";
import { SnowflakeIntrospector } from "../src/introspection/snowflake.js";
import {
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteStringLiteral,
} from "../src/introspection/sql-quoting.js";
import { DataSourceType } from "../src/types/credentials.js";
import { normalizeBigQueryLocation } from "../src/utils/bigquery-location.js";
import { resolveQueryTimeout } from "../src/utils/query-options.js";
import { checkQueryIsReadOnly } from "../src/utils/sql-validation.js";
import {
  isValidCredentials,
  toCredentials,
} from "../src/utils/validate-credentials.js";

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

test("serializes session-level PostgreSQL and Redshift timeouts with queries", async () => {
  for (const adapter of [new PostgreSQLAdapter(), new RedshiftAdapter()]) {
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql === "SELECT 'first'") {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return { rows: [], fields: [], rowCount: 0 };
      },
    };
    Object.assign(adapter, { client, connected: true });

    await Promise.all([
      adapter.query("SELECT 'first'", undefined, undefined, 1_000),
      adapter.query("SELECT 'second'", undefined, undefined, 2_000),
    ]);

    assert.deepEqual(calls, [
      "SET statement_timeout = 1000",
      "SELECT 'first'",
      "SET statement_timeout = 2000",
      "SELECT 'second'",
    ]);
  }
});

test("bounds MySQL rows by streaming the original SQL and reconnects after cancellation", async () => {
  const boundedAdapter = new MySQLAdapter();
  let boundedSql = "";
  let boundedParams: unknown;
  Object.assign(boundedAdapter, {
    connected: true,
    connection: {
      query(sql: string, params: unknown) {
        boundedSql = sql;
        boundedParams = params;
        const listeners = new Map<string, (...args: unknown[]) => void>();
        return {
          on(event: string, listener: (...args: unknown[]) => void) {
            listeners.set(event, listener);
            return this;
          },
          stream() {
            return {
              on(event: string, listener: (...args: unknown[]) => void) {
                if (event === "data") {
                  listener({ id: 1 });
                  listener({ id: 2 });
                  listener({ id: 3 });
                }
                return this;
              },
            };
          },
        };
      },
      destroy() {},
    },
  });

  const bounded = await boundedAdapter.query(
    "SELECT u.id, o.id FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id > ?; -- note",
    [0],
    2,
    1_000,
  );
  assert.equal(
    boundedSql,
    "SELECT u.id, o.id FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id > ?; -- note",
  );
  assert.deepEqual(boundedParams, [0]);
  assert.equal(bounded.rows.length, 2);
  assert.equal(bounded.hasMoreRows, true);

  const recoveryAdapter = new MySQLAdapter();
  let destroyed = false;
  Object.assign(recoveryAdapter, {
    connected: true,
    credentials: {
      type: DataSourceType.MySQL,
      host: "db",
      default_database: "app",
      username: "reader",
      password: "secret",
    },
    connection: {
      execute: (
        _sql: string,
        _params: unknown,
        _callback: (...args: unknown[]) => void,
      ) => undefined,
      destroy: () => {
        destroyed = true;
      },
    },
  });
  recoveryAdapter.initialize = async () => {
    Object.assign(recoveryAdapter, {
      connected: true,
      connection: {
        execute(
          _sql: string,
          _params: unknown,
          callback: (...args: unknown[]) => void,
        ) {
          callback(null, [{ ok: 1 }], []);
        },
      },
    });
  };

  await assert.rejects(
    recoveryAdapter.query("SELECT 1", undefined, undefined, 1),
    /timed out/i,
  );
  assert.equal(destroyed, true);
  const recovered = await recoveryAdapter.query("SELECT 1");
  assert.deepEqual(recovered.rows, [{ ok: 1 }]);
});

test("pushes discovery limits into MySQL metadata work without per-table fanout", async () => {
  const calls: Array<{
    sql: string;
    maxRows: number | undefined;
    timeout: number | undefined;
  }> = [];
  const adapter = {
    async query(
      sql: string,
      _params: unknown,
      maxRows: number | undefined,
      timeout: number | undefined,
    ) {
      calls.push({ sql, maxRows, timeout });
      return {
        rows: [
          {
            database_name: "app",
            name: "orders",
            type: "BASE TABLE",
            row_count: 7,
            size_bytes: 42,
          },
        ],
        fields: [],
        rowCount: 1,
      };
    },
  } as unknown as DatabaseAdapter;

  const tables = await new MySQLIntrospector("mysql", adapter).getTables(
    undefined,
    undefined,
    { limit: 2, timeout: 1_234 },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.maxRows, 2);
  assert.equal(calls[0]?.timeout, 1_234);
  assert.equal(tables[0]?.rowCount, 7);
});

test("Snowflake sparse discovery scans later and inaccessible databases", async () => {
  const calls: Array<{ sql: string; maxRows: number | undefined }> = [];
  const adapter = {
    async query(sql: string, _params: unknown, maxRows: number | undefined) {
      calls.push({ sql, maxRows });
      if (sql.includes('"DB_1".INFORMATION_SCHEMA.TABLES')) {
        throw new Error("inaccessible database");
      }
      const rows = sql.includes("SHOW DATABASES")
        ? Array.from({ length: 3 }, (_, index) => ({ name: `DB_${index}` }))
        : sql.includes('"DB_2".INFORMATION_SCHEMA.TABLES')
          ? Array.from({ length: 3 }, (_, index) => ({
              TABLE_CATALOG: "DB_0",
              TABLE_SCHEMA: "PUBLIC",
              TABLE_NAME: `TABLE_${index}`,
              TABLE_TYPE: "BASE TABLE",
            }))
          : [];
      const limited = maxRows === undefined ? rows : rows.slice(0, maxRows);
      return { rows: limited, fields: [], rowCount: limited.length };
    },
  } as unknown as DatabaseAdapter;

  const tables = await new SnowflakeIntrospector(
    "snowflake",
    adapter,
  ).getTables(undefined, undefined, { limit: 3, timeout: 1_234 });

  assert.equal(tables.length, 3);
  assert.equal(
    calls.filter((call) => call.sql.includes("INFORMATION_SCHEMA.TABLES"))
      .length,
    3,
  );
  assert.ok(
    calls.some((call) => call.sql.includes('"DB_2".INFORMATION_SCHEMA.TABLES')),
  );
});

test("BigQuery sparse table discovery scans later datasets", async () => {
  const queries: string[] = [];
  const adapter = {
    async query(sql: string) {
      queries.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("INFORMATION_SCHEMA.SCHEMATA")) {
        rows = Array.from({ length: 3 }, (_, index) => ({
          dataset_name: `dataset-${index}`,
          project_name: "project-a",
        }));
      } else if (sql.includes("dataset-1.INFORMATION_SCHEMA.TABLES")) {
        throw new Error("inaccessible dataset");
      } else if (sql.includes("dataset-2.INFORMATION_SCHEMA.TABLES")) {
        rows = [
          {
            project_name: "project-a",
            dataset_name: "dataset-2",
            table_name: "orders",
            table_type: "BASE TABLE",
          },
        ];
      } else if (sql.includes(".__TABLES__`")) {
        rows = [{ table_id: "orders", row_count: 1, size_bytes: 10 }];
      }
      return { rows, fields: [], rowCount: rows.length };
    },
  } as unknown as DatabaseAdapter;
  const introspector = new BigQueryIntrospector(
    "analytics",
    adapter,
    "project-a",
    "US",
  );

  const tables = await introspector.getTables(undefined, undefined, {
    limit: 2,
    timeout: 1_234,
  });

  assert.deepEqual(
    tables.map((table) => table.name),
    ["orders"],
  );
  assert.ok(
    queries.some((query) =>
      query.includes("dataset-2.INFORMATION_SCHEMA.TABLES"),
    ),
  );
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

test("BigQuery normalizes blank, multi-region, and regional locations", async () => {
  for (const [location, expected] of [
    [undefined, "US"],
    ["", "US"],
    ["   ", "US"],
    ["us", "US"],
    ["EU", "EU"],
    ["US-CENTRAL1", "us-central1"],
    ["AWS-US-EAST-1", "aws-us-east-1"],
    ["azure-eastus2", "azure-eastus2"],
  ] as const) {
    assert.equal(normalizeBigQueryLocation(location), expected);
  }
  for (const invalid of [
    "us central1",
    "region-us",
    "us--central1",
    "us-",
    "moon",
    42,
    null,
    true,
    {},
    [],
    Object("US"),
  ]) {
    assert.throws(() => normalizeBigQueryLocation(invalid));
    const credentials = {
      type: DataSourceType.BigQuery,
      project_id: "project-a",
      service_account_key: {},
      location: invalid,
    };
    assert.equal(isValidCredentials(credentials), false);
    assert.throws(() => toCredentials(credentials));
  }

  const adapter = new BigQueryAdapter();
  await adapter.initialize({
    type: DataSourceType.BigQuery,
    project_id: "project-a",
    service_account_key: {
      client_email: "reader@project-a.iam.gserviceaccount.com",
      private_key: "test-private-key",
    },
    location: "   ",
  });
  const queries: string[] = [];
  adapter.query = async (sql: string) => {
    queries.push(sql);
    return { rows: [], fields: [], rowCount: 0 };
  };

  await adapter.introspect().getSchemas();
  assert.match(
    queries[0] ?? "",
    /`project-a\.region-us\.INFORMATION_SCHEMA\.SCHEMATA`/,
  );
});

test("BigQuery full introspection honors a non-default project", async () => {
  const { adapter, queries } = createFullIntrospectionBigQueryAdapter();
  const introspector = new BigQueryIntrospector(
    "analytics",
    adapter,
    "project-a",
    "US",
  );

  const result = await introspector.getFullIntrospection({
    databases: ["project-b"],
  });

  assert.deepEqual(
    result.databases.map((database) => database.name),
    ["project-b"],
  );
  assert.deepEqual(
    result.schemas.map((schema) => `${schema.database}.${schema.name}`),
    ["project-b.shared"],
  );
  assert.deepEqual(
    result.tables.map(
      (table) => `${table.database}.${table.schema}.${table.name}`,
    ),
    ["project-b.shared.orders_b"],
  );
  assert.ok(queries.some((query) => query.includes("`project-b.region-us")));
  assert.ok(queries.every((query) => !query.includes("`project-a.")));
});

test("BigQuery full introspection preserves same-named datasets across projects", async () => {
  const { adapter, queries } = createFullIntrospectionBigQueryAdapter();
  const introspector = new BigQueryIntrospector(
    "analytics",
    adapter,
    "project-a",
    "US",
  );

  const result = await introspector.getFullIntrospection({
    databases: ["project-a", "project-b"],
    schemas: ["shared"],
  });

  assert.deepEqual(
    result.schemas.map((schema) => `${schema.database}.${schema.name}`).sort(),
    ["project-a.shared", "project-b.shared"],
  );
  assert.deepEqual(
    result.tables
      .map((table) => `${table.database}.${table.schema}.${table.name}`)
      .sort(),
    ["project-a.shared.orders_a", "project-b.shared.orders_b"],
  );
  for (const project of ["project-a", "project-b"]) {
    assert.ok(
      queries.some((query) =>
        query.includes(`\`${project}.shared.INFORMATION_SCHEMA.TABLES\``),
      ),
    );
  }
});

test("BigQuery bounds metadata fanout and loads dataset stats in bulk", async () => {
  const queries: string[] = [];
  let activeQueries = 0;
  let maxActiveQueries = 0;
  const adapter = {
    query: async (sql: string) => {
      queries.push(sql);
      activeQueries += 1;
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
      await new Promise<void>((resolve) => setImmediate(resolve));

      let rows: Record<string, unknown>[] = [];
      if (sql.includes("INFORMATION_SCHEMA.SCHEMATA")) {
        rows = Array.from({ length: 12 }, (_, index) => ({
          dataset_name: `dataset-${index}`,
          project_name: "project-a",
          location: "US",
        }));
      } else if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        const dataset =
          /project-a\.(dataset-\d+)/.exec(sql)?.[1] ?? "dataset-0";
        rows = Array.from({ length: 10 }, (_, index) => ({
          project_name: "project-a",
          dataset_name: dataset,
          table_name: `table-${index}`,
          table_type: "BASE TABLE",
        }));
      } else if (sql.includes(".__TABLES__`")) {
        rows = Array.from({ length: 10 }, (_, index) => ({
          table_id: `table-${index}`,
          row_count: index,
          size_bytes: index * 10,
        }));
      }

      activeQueries -= 1;
      return { rows, fields: [], rowCount: rows.length };
    },
  } as unknown as DatabaseAdapter;
  const introspector = new BigQueryIntrospector(
    "analytics",
    adapter,
    "project-a",
    "US",
  );

  const result = await introspector.getFullIntrospection();

  assert.equal(result.tables.length, 120);
  assert.ok(maxActiveQueries <= 8, `observed ${maxActiveQueries} queries`);
  assert.equal(
    queries.filter((query) => query.includes(".__TABLES__`")).length,
    12,
  );
});

function createFullIntrospectionBigQueryAdapter(): {
  adapter: DatabaseAdapter;
  queries: string[];
} {
  const queries: string[] = [];
  const adapter = {
    query: async (sql: string) => {
      queries.push(sql);
      const project = /`(project-[ab])\./.exec(sql)?.[1] ?? "project-a";
      const suffix = project.endsWith("a") ? "a" : "b";
      let rows: Record<string, unknown>[] = [];

      if (sql.includes("INFORMATION_SCHEMA.SCHEMATA")) {
        rows = [
          {
            dataset_name: "shared",
            project_name: project,
            location: "US",
            creation_time: "2026-01-01T00:00:00.000Z",
          },
        ];
      } else if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        rows = [
          {
            project_name: project,
            dataset_name: "shared",
            table_name: `orders_${suffix}`,
            table_type: "BASE TABLE",
            creation_time: "2026-01-01T00:00:00.000Z",
            ddl: null,
          },
        ];
      } else if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
        rows = [
          {
            project_name: project,
            dataset_name: "shared",
            table_name: `orders_${suffix}`,
            column_name: "id",
            ordinal_position: 1,
            data_type: "STRING",
            is_nullable: "NO",
          },
        ];
      } else if (sql.includes(".__TABLES__`")) {
        rows = [{ row_count: 1, size_bytes: 10 }];
      }

      return { rows, fields: [], rowCount: rows.length };
    },
  } as unknown as DatabaseAdapter;

  return { adapter, queries };
}
