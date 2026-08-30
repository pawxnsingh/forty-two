import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import mssql from "mssql";
import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";

import { DataSource } from "../src/data-source.js";
import { executedStructuredStatements } from "../src/adapters/mysql.js";
import { splitStructuredCanonicalSql } from "../src/mutations/index.js";
import { DataSourceType } from "../src/types/credentials.js";
import type {
  SqlChangeDialect,
  StructuredColumnChange,
} from "../src/mutations/index.js";

const suffix = `${process.pid}_${Date.now()}`;
const registerLocalProviderTests = process.env.SQL_CHANGE_HELPER_ONLY !== "1";

if (registerLocalProviderTests)
  test("PostgreSQL applies approved row and structured column changes with a target-table-only owner", async () => {
    const table = `tf_change_${suffix}`;
    const port = numberEnvironment("POSTGRES_PORT", 5432);
    const database = process.env.POSTGRES_DB ?? "forty_two";
    const owner = new PgClient({
      host: "127.0.0.1",
      port,
      database,
      user: process.env.POSTGRES_USER ?? "forty_two",
      password: requiredEnvironment("POSTGRES_PASSWORD"),
    });
    await owner.connect();
    try {
      await owner.query(
        `CREATE TABLE demo."${table}" (id bigint PRIMARY KEY, label text NOT NULL, value integer NOT NULL)`,
      );
      await owner.query(
        `INSERT INTO demo."${table}" VALUES (1, 'one', 10), (2, 'two', 20)`,
      );
      await owner.query(
        `ALTER TABLE demo."${table}" OWNER TO forty_two_mutation`,
      );
      const privilege = await owner.query<{
        tableowner: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }>(
        `SELECT tableowner, rolsuper, rolcreatedb, rolcreaterole
       FROM pg_tables JOIN pg_roles ON rolname = tableowner
       WHERE schemaname = 'demo' AND tablename = $1`,
        [table],
      );
      assert.deepEqual(privilege.rows, [
        {
          tableowner: "forty_two_mutation",
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
        },
      ]);

      const postgresqlConfig = {
        name: "postgresql-live",
        type: DataSourceType.PostgreSQL,
        credentials: {
          type: DataSourceType.PostgreSQL,
          host: "127.0.0.1",
          port,
          default_database: database,
          schema: "demo",
          username: "forty_two_mutation",
          password: requiredEnvironment("POSTGRES_MUTATION_PASSWORD"),
          ssl: false,
        },
      } as const;
      await assertBackfillDriftRejected({
        name: "postgresql-live",
        dialect: "postgresql",
        target: { catalog: null, schema: "demo", table },
        config: postgresqlConfig,
        drift: () =>
          owner.query(`UPDATE demo."${table}" SET value = 99 WHERE id = 1`),
      });
      await owner.query(`UPDATE demo."${table}" SET value = 10 WHERE id = 1`);

      await exerciseConnector({
        name: "postgresql-live",
        dialect: "postgresql",
        target: { catalog: null, schema: "demo", table },
        targetSql: `demo."${table}"`,
        config: postgresqlConfig,
      });
    } finally {
      await owner
        .query(`DROP TABLE IF EXISTS demo."${table}"`)
        .catch(() => undefined);
      await owner.end();
    }
  });

if (registerLocalProviderTests)
  test("MySQL applies approved row and fresh-approved structured recovery", async () => {
    const table = `tf_change_${suffix}`;
    const port = numberEnvironment("MYSQL_PORT", 3306);
    const owner = await mysql.createConnection({
      host: "127.0.0.1",
      port,
      user: "root",
      password: requiredEnvironment("MYSQL_ROOT_PASSWORD"),
      database: "forty_two_demo",
    });
    try {
      await owner.query(
        `CREATE TABLE \`${table}\` (id BIGINT PRIMARY KEY, label VARCHAR(255) NOT NULL, value INT NOT NULL)`,
      );
      await owner.query(
        `INSERT INTO \`${table}\` VALUES (1, 'one', 10), (2, 'two', 20)`,
      );
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE, ALTER ON \`forty_two_demo\`.\`${table}\` TO 'forty_two_writer'@'%'`,
      );
      const mysqlConfig = {
        name: "mysql-live",
        type: DataSourceType.MySQL,
        credentials: {
          type: DataSourceType.MySQL,
          host: "127.0.0.1",
          port,
          default_database: "forty_two_demo",
          username: "forty_two_writer",
          password: requiredEnvironment("MYSQL_WRITER_PASSWORD"),
          ssl: false,
        },
      } as const;
      await assertBackfillDriftRejected({
        name: "mysql-live",
        dialect: "mysql",
        target: { catalog: "forty_two_demo", schema: null, table },
        config: mysqlConfig,
        drift: () =>
          owner.query(`UPDATE \`${table}\` SET value = 99 WHERE id = 1`),
        adapterColumnState: async (column) => {
          const [columns] = await owner.query<mysql.RowDataPacket[]>(
            "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = 'forty_two_demo' AND table_name = ? AND column_name = ?",
            [table, column],
          );
          const [rows] = await owner.query<mysql.RowDataPacket[]>(
            `SELECT \`${column}\` AS value FROM \`${table}\` ORDER BY id`,
          );
          return {
            exists: Number(columns[0]?.count ?? 0) === 1,
            values: rows.map((row) => row.value),
          };
        },
      });
      await owner.query(`UPDATE \`${table}\` SET value = 10 WHERE id = 1`);
      await owner.query(
        `ALTER TABLE \`${table}\` ADD COLUMN narrow_copy VARCHAR(1) NULL`,
      );
      const narrowSource = new DataSource({ dataSources: [mysqlConfig] });
      try {
        await assert.rejects(
          narrowSource.prepareColumnChange({
            dataSource: "mysql-live",
            dialect: "mysql",
            change: {
              operation: "add_and_backfill_column",
              target: {
                catalog: "forty_two_demo",
                schema: null,
                table,
              },
              columnName: "narrow_copy",
              columnType: "text",
              expression: { kind: "column", column: "label" },
            },
            maxRows: 100,
          }),
          /Destination column already exists/,
        );
        const [narrowRows] = await owner.query<mysql.RowDataPacket[]>(
          `SELECT narrow_copy FROM \`${table}\` ORDER BY id`,
        );
        assert.deepEqual(
          narrowRows.map((row) => row.narrow_copy),
          [null, null],
          "narrow reconciliation must fail before any later data-too-long backfill",
        );
      } finally {
        await narrowSource.close();
        await owner.query(`ALTER TABLE \`${table}\` DROP COLUMN narrow_copy`);
      }
      await exerciseConnector({
        name: "mysql-live",
        dialect: "mysql",
        target: { catalog: "forty_two_demo", schema: null, table },
        targetSql: `\`forty_two_demo\`.\`${table}\``,
        config: mysqlConfig,
        injectImplicitColumnAdd: async (canonicalSql) => {
          const ddl = canonicalSql.split("; ", 1)[0];
          assert.ok(ddl);
          await owner.query(ddl);
        },
      });
    } finally {
      await owner
        .query(
          `REVOKE SELECT, INSERT, UPDATE, DELETE, ALTER ON \`forty_two_demo\`.\`${table}\` FROM 'forty_two_writer'@'%'`,
        )
        .catch(() => undefined);
      await owner
        .query(`DROP TABLE IF EXISTS \`${table}\``)
        .catch(() => undefined);
      await owner.end();
    }
  });

if (registerLocalProviderTests)
  test("SQL Server applies approved row and transactional structured column changes", async () => {
    const table = `tf_change_${suffix}`;
    const port = numberEnvironment("SQLSERVER_PORT", 1433);
    const owner = await mssql.connect({
      server: "localhost",
      port,
      database: "forty_two_demo",
      user: "sa",
      password: requiredEnvironment("SQLSERVER_SA_PASSWORD"),
      options: { encrypt: true, trustServerCertificate: true },
    });
    try {
      await owner.request().query(
        `CREATE TABLE dbo.[${table}] (id BIGINT PRIMARY KEY, label NVARCHAR(255) NOT NULL, value INT NOT NULL);
       INSERT INTO dbo.[${table}] VALUES (1, N'one', 10), (2, N'two', 20);
       GRANT SELECT, INSERT, UPDATE, DELETE, ALTER ON OBJECT::dbo.[${table}] TO forty_two_writer;`,
      );
      const sqlserverConfig = {
        name: "sqlserver-live",
        type: DataSourceType.SQLServer,
        credentials: {
          type: DataSourceType.SQLServer,
          server: "localhost",
          port,
          default_database: "forty_two_demo",
          username: "forty_two_writer",
          password: requiredEnvironment("SQLSERVER_WRITER_PASSWORD"),
          encrypt: true,
          trust_server_certificate: true,
        },
      } as const;
      await assertBackfillDriftRejected({
        name: "sqlserver-live",
        dialect: "transactsql",
        target: { catalog: "forty_two_demo", schema: "dbo", table },
        config: sqlserverConfig,
        drift: () =>
          owner
            .request()
            .query(`UPDATE dbo.[${table}] SET value = 99 WHERE id = 1`),
      });
      await owner
        .request()
        .query(`UPDATE dbo.[${table}] SET value = 10 WHERE id = 1`);
      await exerciseConnector({
        name: "sqlserver-live",
        dialect: "transactsql",
        target: { catalog: "forty_two_demo", schema: "dbo", table },
        targetSql: `[forty_two_demo].[dbo].[${table}]`,
        config: sqlserverConfig,
      });
    } finally {
      await owner
        .request()
        .query(`DROP TABLE IF EXISTS dbo.[${table}]`)
        .catch(() => undefined);
      await owner.close();
    }
  });

export async function exerciseConnector(input: {
  name: string;
  dialect: SqlChangeDialect;
  target: { catalog: string | null; schema: string | null; table: string };
  targetSql: string;
  config: ConstructorParameters<typeof DataSource>[0]["dataSources"][number];
  injectImplicitColumnAdd?: (canonicalSql: string) => Promise<void>;
}) {
  const source = new DataSource({ dataSources: [input.config] });
  try {
    const prepared = await source.prepareSqlChange({
      dataSource: input.name,
      dialect: input.dialect,
      sql: `UPDATE ${input.targetSql} SET value = 11 WHERE id = 1`,
      maxRows: 100,
    });
    assert.equal(prepared.expectedAffectedRows, 1);
    const applied = await source.applySqlChange(input.name, {
      targetSql: prepared.target.sql,
      canonicalSql: prepared.canonicalSql,
      params: [],
      operation: prepared.operation,
      preconditionSql: prepared.preconditions.selectSql,
      preconditionParams: prepared.preconditions.params,
      expectedAffectedRows: prepared.expectedAffectedRows,
      expectedRowHashes: prepared.preconditions.rowHashes,
      maximumRows: 100,
      executionToken: `exec_${suffix}_row`,
      ...(prepared.preconditions.providerPrecondition
        ? { providerPrecondition: prepared.preconditions.providerPrecondition }
        : {}),
    });
    assert.equal(applied.rowCount, 1);
    assert.ok(applied.providerExecutionId);
    if (input.dialect === "mysql") {
      assert.match(
        applied.providerExecutionId,
        /^mysql:[0-9a-f]{8}-[0-9a-f-]{27}$/i,
      );
      assert.ok(applied.verification.providerExecutionToken);
      assert.match(
        String(applied.verification.providerStatementHash),
        /^[0-9a-f]{64}$/,
      );
    }

    for (const change of columnChanges(input.target)) {
      const proposal = await source.prepareColumnChange({
        dataSource: input.name,
        dialect: input.dialect,
        change,
        maxRows: 100,
      });
      if (
        change.operation === "add_and_backfill_column" &&
        input.injectImplicitColumnAdd
      ) {
        await input.injectImplicitColumnAdd(proposal.canonicalSql);
      }
      const result = await source.applyColumnChange({
        dataSource: input.name,
        dialect: input.dialect,
        change,
        canonicalSql: proposal.canonicalSql,
        expectedSchemaFingerprint: proposal.preconditions.schemaFingerprint,
        expectedAffectedRows: proposal.expectedAffectedRows,
        maximumRows: 100,
        preconditionSql: proposal.preconditions.selectSql,
        verificationSql: proposal.preconditions.verificationSql,
        expectedRowHashes: proposal.preconditions.rowHashes,
        expectedPreconditionRowHashes:
          proposal.preconditions.preconditionRowHashes,
        ...(proposal.preconditions.providerPrecondition
          ? {
              providerPrecondition: proposal.preconditions.providerPrecondition,
            }
          : {}),
        executionToken: `exec_${suffix}_${change.operation}`,
        ddlAlreadyCommitted:
          proposal.executionStrategy.ddlAlreadyCommitted === true,
      });
      assert.ok(result.providerExecutionId);
      if (input.dialect === "mysql") {
        assert.match(
          result.providerExecutionId,
          /^mysql:[0-9a-f]{8}-[0-9a-f-]{27}$/i,
        );
        assert.ok(result.verification.providerExecutionToken);
        assert.match(
          String(result.verification.providerStatementHash),
          /^[0-9a-f]{64}$/,
        );
      }
      assert.equal(result.rowCount, proposal.expectedAffectedRows);
      if (change.operation === "add_and_backfill_column") {
        assert.equal(
          result.verification.verifiedRows,
          proposal.expectedAffectedRows,
        );
        assert.deepEqual(
          result.verification.verifiedRowHashes,
          proposal.preconditions.rowHashes,
        );
        assert.ok(Array.isArray(result.verification.verifiedSample));
      }
      if (
        change.operation === "add_and_backfill_column" &&
        input.injectImplicitColumnAdd
      ) {
        assert.equal(result.verification.resumedAfterImplicitCommit, true);
        if (input.dialect === "mysql") {
          const phases = splitStructuredCanonicalSql({
            operation: change.operation,
            canonicalSql: proposal.canonicalSql,
          });
          assert.equal(
            result.verification.approvedDdlStatementHash,
            sha256(phases.ddlSql),
          );
          assert.equal(
            result.verification.providerStatementHash,
            sha256(
              executedStructuredStatements({
                ddlSql: phases.ddlSql,
                backfillSql: phases.backfillSql,
                preconditionSql: proposal.preconditions.selectSql,
                verificationSql: proposal.preconditions.verificationSql,
                maximumRows: 100,
                skipDdl: true,
              }),
            ),
          );
          assert.notEqual(
            result.verification.providerStatementHash,
            result.verification.approvedDdlStatementHash,
          );
        }
      }
    }

    const result = await source.execute({
      dataSource: input.name,
      sql: `SELECT id, value, description, copied_value FROM ${input.targetSql} ORDER BY id`,
      options: { maxRows: 10 },
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.rows.map(normalizeResultRow), [
      { id: "1", value: 11, description: null, copied_value: 12 },
      { id: "2", value: 20, description: null, copied_value: 21 },
    ]);

    const replay = await source.prepareSqlChange({
      dataSource: input.name,
      dialect: input.dialect,
      sql: `DELETE FROM ${input.targetSql} WHERE id = 2`,
    });
    const staleSql = `UPDATE ${input.targetSql} SET value = 99 WHERE id = 2`;
    const staleProposal = await source.prepareSqlChange({
      dataSource: input.name,
      dialect: input.dialect,
      sql: staleSql,
    });
    await source.applySqlChange(input.name, {
      targetSql: replay.target.sql,
      canonicalSql: replay.canonicalSql,
      params: [],
      operation: replay.operation,
      preconditionSql: replay.preconditions.selectSql,
      preconditionParams: [],
      expectedAffectedRows: replay.expectedAffectedRows,
      expectedRowHashes: replay.preconditions.rowHashes,
      maximumRows: 100,
      executionToken: `exec_${suffix}_delete`,
    });
    await assert.rejects(
      source.applySqlChange(input.name, {
        targetSql: staleProposal.target.sql,
        canonicalSql: staleProposal.canonicalSql,
        params: [],
        operation: staleProposal.operation,
        preconditionSql: staleProposal.preconditions.selectSql,
        preconditionParams: [],
        expectedAffectedRows: staleProposal.expectedAffectedRows,
        expectedRowHashes: staleProposal.preconditions.rowHashes,
        maximumRows: 100,
        executionToken: `exec_${suffix}_stale`,
      }),
      /stale/i,
    );
  } finally {
    await source.close();
  }
}

async function assertBackfillDriftRejected(input: {
  name: string;
  dialect: SqlChangeDialect;
  target: { catalog: string | null; schema: string | null; table: string };
  config: ConstructorParameters<typeof DataSource>[0]["dataSources"][number];
  drift: () => Promise<unknown>;
  adapterColumnState?: (
    column: string,
  ) => Promise<{ exists: boolean; values: unknown[] }>;
}) {
  const source = new DataSource({ dataSources: [input.config] });
  try {
    const change: StructuredColumnChange = {
      operation: "add_and_backfill_column",
      target: input.target,
      columnName: "drift_copy",
      columnType: "integer",
      expression: {
        kind: "binary",
        operator: "add",
        left: { kind: "column", column: "value" },
        right: { kind: "literal", value: 1 },
      },
    };
    const proposal = await source.prepareColumnChange({
      dataSource: input.name,
      dialect: input.dialect,
      change,
      maxRows: 100,
    });
    assert.equal(
      Number(
        (proposal.preview.after as Record<string, unknown>[])[0]?.drift_copy,
      ),
      11,
    );
    await input.drift();
    let rejectedError: unknown;
    await assert.rejects(
      source.applyColumnChange({
        dataSource: input.name,
        dialect: input.dialect,
        change,
        canonicalSql: proposal.canonicalSql,
        expectedSchemaFingerprint: proposal.preconditions.schemaFingerprint,
        expectedAffectedRows: proposal.expectedAffectedRows,
        maximumRows: 100,
        preconditionSql: proposal.preconditions.selectSql,
        verificationSql: proposal.preconditions.verificationSql,
        expectedRowHashes: proposal.preconditions.rowHashes,
        expectedPreconditionRowHashes:
          proposal.preconditions.preconditionRowHashes,
        ...(proposal.preconditions.providerPrecondition
          ? {
              providerPrecondition: proposal.preconditions.providerPrecondition,
            }
          : {}),
        executionToken: `exec_${suffix}_drift`,
      }),
      (error) => {
        rejectedError = error;
        return error instanceof Error && /stale/i.test(error.message);
      },
    );
    if (input.dialect === "mysql") {
      assert.ok(rejectedError instanceof Error);
      assert.equal(rejectedError.name, "SqlChangePartialCommitError");
      assert.match(
        String(
          (rejectedError as Error & { providerExecutionId?: unknown })
            .providerExecutionId,
        ),
        /^mysql:[0-9a-f-]+$/i,
      );
      assert.equal(
        (
          rejectedError as Error & {
            verification?: Record<string, unknown>;
          }
        ).verification?.phase,
        "partial_ddl_committed",
      );
      assert.equal(
        (
          rejectedError as Error & {
            verification?: Record<string, unknown>;
          }
        ).verification?.freshApprovalRequired,
        true,
      );
      assert.equal(
        (
          rejectedError as Error & {
            verification?: Record<string, unknown>;
          }
        ).verification?.terminal,
        true,
      );
      const committed = await input.adapterColumnState?.("drift_copy");
      assert.deepEqual(committed, { exists: true, values: [null, null] });

      const reconciliation = await source.prepareColumnChange({
        dataSource: input.name,
        dialect: input.dialect,
        change,
        maxRows: 100,
      });
      assert.equal(reconciliation.executionStrategy.ddlAlreadyCommitted, true);
      const applied = await source.applyColumnChange({
        dataSource: input.name,
        dialect: input.dialect,
        change,
        canonicalSql: reconciliation.canonicalSql,
        expectedSchemaFingerprint:
          reconciliation.preconditions.schemaFingerprint,
        expectedAffectedRows: reconciliation.expectedAffectedRows,
        maximumRows: 100,
        preconditionSql: reconciliation.preconditions.selectSql,
        verificationSql: reconciliation.preconditions.verificationSql,
        expectedRowHashes: reconciliation.preconditions.rowHashes,
        expectedPreconditionRowHashes:
          reconciliation.preconditions.preconditionRowHashes,
        executionToken: `exec_${suffix}_drift_reconciliation`,
        ddlAlreadyCommitted: true,
      });
      assert.equal(applied.rowCount, 2);
      assert.equal(applied.verification.resumedAfterImplicitCommit, true);
    }
  } finally {
    await source.close();
  }
}

function normalizeResultRow(row: Record<string, unknown>) {
  const value = (name: string) =>
    Object.entries(row).find(([key]) => key.toLowerCase() === name)?.[1];
  return {
    id: String(value("id")),
    value: Number(value("value")),
    description: value("description") ?? null,
    copied_value: Number(value("copied_value")),
  };
}

function columnChanges(target: {
  catalog: string | null;
  schema: string | null;
  table: string;
}): StructuredColumnChange[] {
  return [
    {
      operation: "add_column",
      target,
      columnName: "note",
      columnType: "text",
    },
    {
      operation: "rename_column",
      target,
      sourceColumn: "note",
      destinationColumn: "description",
    },
    {
      operation: "add_and_backfill_column",
      target,
      columnName: "copied_value",
      columnType: "integer",
      expression: {
        kind: "binary",
        operator: "add",
        left: { kind: "column", column: "value" },
        right: { kind: "literal", value: 1 },
      },
    },
  ];
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live SQL change tests.`);
  return value;
}

function numberEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
