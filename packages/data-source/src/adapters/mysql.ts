import { createHash } from "node:crypto";

import mysql from "mysql2";
import type { DataSourceIntrospector } from "../introspection/base.js";
import { MySQLIntrospector } from "../introspection/mysql.js";
import {
  type Credentials,
  DataSourceType,
  type MySQLCredentials,
} from "../types/credentials.js";
import type { QueryParameter } from "../types/query.js";
import { resolveQueryTimeout } from "../utils/query-options.js";
import {
  type AdapterQueryResult,
  BaseAdapter,
  type FieldMetadata,
} from "./base.js";
import { AsyncMutex } from "./helpers/async-mutex.js";
import { normalizeRowValues } from "./helpers/normalize-values.js";
import { mapMySQLType } from "./type-mappings/mysql.js";
import {
  SqlChangePartialCommitError,
  type ApplyControlledMutationInput,
  type ApplyControlledMutationResult,
} from "../mutations/types.js";
import {
  assertAffectedRows,
  assertMutationPreconditions,
  verifiedRowEvidence,
} from "../mutations/verify.js";
import {
  boundedStructuredMutationSelect,
  type ApplyStructuredColumnChangeInput,
  type ApplyStructuredColumnChangeResult,
} from "../mutations/structured-column-change.js";

/**
 * MySQL database adapter
 */
export class MySQLAdapter extends BaseAdapter {
  private connection?: mysql.Connection | undefined;
  private introspector?: MySQLIntrospector;
  private readonly queryMutex = new AsyncMutex();

  private async executeWithTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.invalidateConnection();
        reject(
          new Error(
            `MySQL operation timed out after ${timeoutMs}ms; its outcome is unknown`,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async initialize(credentials: Credentials): Promise<void> {
    this.validateCredentials(credentials, DataSourceType.MySQL);
    const mysqlCredentials = credentials as MySQLCredentials;

    try {
      const config: mysql.ConnectionOptions = {
        host: mysqlCredentials.host,
        port: mysqlCredentials.port || 3306,
        database: mysqlCredentials.default_database,
        user: mysqlCredentials.username,
        password: mysqlCredentials.password,
        // mysql2 otherwise converts BIGINT values to JavaScript numbers before
        // the metadata-aware artifact serializer can preserve them. Keep both
        // signed and unsigned 64-bit integers lossless at the driver boundary.
        // DECIMAL values remain strings under this configuration as well.
        supportBigNumbers: true,
        bigNumberStrings: true,
      };

      // Handle SSL configuration
      if (mysqlCredentials.ssl === true) {
        config.ssl = { rejectUnauthorized: true };
      } else if (typeof mysqlCredentials.ssl === "object") {
        // For object SSL configuration, mysql2 expects specific properties
        config.ssl = {
          rejectUnauthorized: mysqlCredentials.ssl.rejectUnauthorized ?? true,
          ...(mysqlCredentials.ssl.ca && { ca: mysqlCredentials.ssl.ca }),
          ...(mysqlCredentials.ssl.cert && { cert: mysqlCredentials.ssl.cert }),
          ...(mysqlCredentials.ssl.key && { key: mysqlCredentials.ssl.key }),
        };
      }

      // Handle connection timeout
      if (mysqlCredentials.connection_timeout) {
        config.connectTimeout = mysqlCredentials.connection_timeout;
      }

      // Handle charset
      if (mysqlCredentials.charset) {
        config.charset = mysqlCredentials.charset;
      }

      const connection = mysql.createConnection(config);
      await new Promise<void>((resolve, reject) => {
        connection.connect((error) => (error ? reject(error) : resolve()));
      });
      this.connection = connection;

      this.credentials = credentials;
      this.connected = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize MySQL client: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async query(
    sql: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
  ): Promise<AdapterQueryResult> {
    return this.queryMutex.runExclusive(() =>
      this.queryExclusive(sql, params, maxRows, timeout),
    );
  }

  async queryReadOnly(
    sql: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
  ): Promise<AdapterQueryResult> {
    return this.queryMutex.runExclusive(async () => {
      await this.ensureUsableConnection();
      if (!this.connection) throw new Error("MySQL connection not initialized");

      await this.executeControlStatement("START TRANSACTION READ ONLY");
      try {
        const result = await this.queryExclusive(sql, params, maxRows, timeout);
        await this.executeControlStatement("ROLLBACK");
        return result;
      } catch (error) {
        await this.executeControlStatement("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  private async queryExclusive(
    sql: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
  ): Promise<AdapterQueryResult> {
    const timeoutMs = resolveQueryTimeout(timeout);
    await this.ensureUsableConnection();

    if (!this.connection) {
      throw new Error("MySQL connection not initialized");
    }

    try {
      if (maxRows !== undefined && maxRows > 0) {
        return await this.executeWithTimeout(
          this.streamBoundedQuery(sql, params, maxRows),
          timeoutMs,
        );
      }

      const [rows, fields] = await this.executeWithTimeout(
        this.executeQuery(sql, params),
        timeoutMs,
      );

      // Handle different result types
      let resultRows: Record<string, unknown>[] = [];
      let rowCount = 0;
      const hasMoreRows = false;

      if (Array.isArray(rows)) {
        // For SELECT queries that return rows
        resultRows = rows as Record<string, unknown>[];
        rowCount = resultRows.length;
      } else if (rows && typeof rows === "object" && "affectedRows" in rows) {
        // For INSERT, UPDATE, DELETE operations
        const resultSet = rows as mysql.ResultSetHeader;
        rowCount = resultSet.affectedRows || 0;
        resultRows = [];
      }

      const fieldMetadata = this.mapFields(fields);

      return {
        rows: resultRows.map(normalizeRowValues),
        rowCount,
        fields: fieldMetadata,
        hasMoreRows,
      };
    } catch (error) {
      throw new Error(
        `MySQL query failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.connection) {
        return false;
      }

      // Test connection by running a simple query
      await this.executeQuery("SELECT 1 as test");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.queryMutex.runExclusive(async () => {
      this.invalidateConnection();
    });
  }

  getDataSourceType(): string {
    return DataSourceType.MySQL;
  }

  introspect(): DataSourceIntrospector {
    this.ensureConnected();
    if (!this.introspector) {
      this.introspector = new MySQLIntrospector("mysql", this);
    }
    return this.introspector;
  }

  /**
   * Execute a write operation (INSERT, UPDATE, DELETE)
   */
  override async executeWrite(
    sql: string,
    params?: QueryParameter[],
    timeout?: number,
  ): Promise<{ rowCount: number }> {
    return this.queryMutex.runExclusive(() =>
      this.executeWriteExclusive(sql, params, timeout),
    );
  }

  override async applyControlledMutation(
    input: ApplyControlledMutationInput,
  ): Promise<ApplyControlledMutationResult> {
    return this.queryMutex.runExclusive(async () => {
      const timeoutMs = resolveQueryTimeout(input.timeout);
      await this.ensureUsableConnection();
      if (!this.connection) throw new Error("MySQL connection not initialized");
      await this.executeControlStatement(
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      );
      await this.executeControlStatement("START TRANSACTION");
      try {
        const locked = await this.queryExclusive(
          `${input.preconditionSql} FOR UPDATE`,
          input.preconditionParams,
          undefined,
          timeoutMs,
        );
        assertMutationPreconditions(locked.rows, input.expectedRowHashes);
        const evidence = await this.mysqlExecutionEvidence(timeoutMs);
        const [changed] = await this.executeWithTimeout(
          this.executeQuery(input.canonicalSql, input.params),
          timeoutMs,
        );
        const rowCount =
          changed && typeof changed === "object" && "affectedRows" in changed
            ? (changed as mysql.ResultSetHeader).affectedRows
            : 0;
        assertAffectedRows(rowCount, input.expectedAffectedRows);
        await this.executeControlStatement("COMMIT");
        return {
          rowCount,
          providerExecutionId: evidence.providerExecutionId,
          verification: {
            isolation: "serializable",
            lockedRows: locked.rows.length,
            affectedRows: rowCount,
            providerConnectionId: evidence.connectionId,
            providerExecutionToken: evidence.executionId,
            providerStatementHash: mysqlStatementHash(input.canonicalSql),
          },
        };
      } catch (error) {
        await this.executeControlStatement("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  override async applyStructuredColumnChange(
    input: ApplyStructuredColumnChangeInput,
  ): Promise<ApplyStructuredColumnChangeResult> {
    return this.queryMutex.runExclusive(async () => {
      const timeoutMs = resolveQueryTimeout(input.timeout);
      await this.ensureUsableConnection();
      let ddlCompleted = input.skipDdl === true;
      let ddlEvidence:
        Awaited<ReturnType<MySQLAdapter["mysqlExecutionEvidence"]>> | undefined;
      try {
        if (!input.skipDdl) {
          ddlEvidence = await this.mysqlExecutionEvidence(timeoutMs);
          await this.executeWithTimeout(
            this.executeQuery(input.ddlSql),
            timeoutMs,
          );
          ddlCompleted = true;
        }
        let rowCount = 0;
        let preconditionRows: Record<string, unknown>[] = [];
        let finalEvidence: Record<string, unknown> = {};
        let evidence: Awaited<
          ReturnType<MySQLAdapter["mysqlExecutionEvidence"]>
        >;
        if (input.backfillSql) {
          if (!input.preconditionSql || !input.verificationSql) {
            throw new Error("Stored backfill preconditions are unavailable.");
          }
          await this.executeControlStatement("START TRANSACTION");
          try {
            preconditionRows = (
              await this.queryExclusive(
                `${boundedStructuredMutationSelect(input.preconditionSql, "mysql", input.maximumRows)} FOR UPDATE`,
                [],
                undefined,
                timeoutMs,
              )
            ).rows;
            assertMutationPreconditions(
              preconditionRows,
              input.expectedPreconditionRowHashes ?? input.expectedRowHashes,
            );
            evidence = await this.mysqlExecutionEvidence(timeoutMs);
            const [changed] = await this.executeWithTimeout(
              this.executeQuery(input.backfillSql),
              timeoutMs,
            );
            rowCount =
              changed &&
              typeof changed === "object" &&
              "affectedRows" in changed
                ? (changed as mysql.ResultSetHeader).affectedRows
                : 0;
            assertAffectedRows(rowCount, input.expectedAffectedRows);
            const verificationRows = (
              await this.queryExclusive(
                boundedStructuredMutationSelect(
                  input.verificationSql,
                  "mysql",
                  input.maximumRows,
                ),
                [],
                undefined,
                timeoutMs,
              )
            ).rows;
            finalEvidence = verifiedRowEvidence(
              verificationRows,
              input.expectedRowHashes,
            );
            await this.executeControlStatement("COMMIT");
          } catch (error) {
            await this.executeControlStatement("ROLLBACK").catch(
              () => undefined,
            );
            throw error;
          }
        } else {
          assertAffectedRows(0, input.expectedAffectedRows);
          evidence = await this.mysqlExecutionEvidence(timeoutMs);
        }
        return {
          rowCount,
          providerExecutionId: evidence.providerExecutionId,
          verification: {
            mode: "idempotent_implicit_commit",
            preconditionRows: preconditionRows.length,
            providerConnectionId: evidence.connectionId,
            providerExecutionToken: evidence.executionId,
            approvedDdlStatementHash: mysqlStatementHash(input.ddlSql),
            providerStatementHash: mysqlStatementHash(
              executedStructuredStatements(input),
            ),
            ...finalEvidence,
            phases: input.backfillSql
              ? [
                  input.skipDdl ? "column_already_added" : "column_added",
                  "backfill_applied",
                ]
              : [
                  input.operation === "rename_column"
                    ? "renamed"
                    : "column_added",
                ],
          },
        };
      } catch (error) {
        if (
          ddlCompleted &&
          !input.skipDdl &&
          ddlEvidence &&
          error instanceof Error &&
          error.name === "SqlChangeStaleError"
        ) {
          throw new SqlChangePartialCommitError(
            "MySQL column DDL committed before the backfill became stale.",
            ddlEvidence.providerExecutionId,
            {
              phase: "partial_ddl_committed",
              terminal: true,
              freshApprovalRequired: true,
              ddlCommitted: true,
              providerConnectionId: ddlEvidence.connectionId,
              providerExecutionToken: ddlEvidence.executionId,
              providerStatementHash: mysqlStatementHash(input.ddlSql),
            },
          );
        }
        throw resumableImplicitCommitError(error, ddlCompleted);
      }
    });
  }

  private async mysqlExecutionEvidence(timeoutMs: number): Promise<{
    providerExecutionId: string;
    connectionId: string;
    executionId: string;
  }> {
    const [rows] = await this.executeWithTimeout(
      this.executeQuery(
        "SELECT CAST(CONNECTION_ID() AS CHAR) AS connection_id, UUID() AS execution_id",
      ),
      timeoutMs,
    );
    const row = Array.isArray(rows)
      ? (rows[0] as
          { connection_id?: unknown; execution_id?: unknown } | undefined)
      : undefined;
    const connectionId = String(row?.connection_id ?? "");
    const executionId = String(row?.execution_id ?? "");
    if (!connectionId || !executionId) {
      throw new Error("MySQL execution evidence is unavailable.");
    }
    return {
      providerExecutionId: `mysql:${executionId}`,
      connectionId,
      executionId,
    };
  }

  private async executeWriteExclusive(
    sql: string,
    params?: QueryParameter[],
    timeout?: number,
  ): Promise<{ rowCount: number }> {
    const timeoutMs = resolveQueryTimeout(timeout);
    await this.ensureUsableConnection();

    if (!this.connection) {
      throw new Error("MySQL connection not initialized");
    }

    try {
      const [result] = await this.executeWithTimeout(
        this.executeQuery(sql, params),
        timeoutMs,
      );

      // For write operations, MySQL returns a ResultSetHeader
      if (result && typeof result === "object" && "affectedRows" in result) {
        const resultSet = result as mysql.ResultSetHeader;
        return {
          rowCount: resultSet.affectedRows || 0,
        };
      }

      return {
        rowCount: 0,
      };
    } catch (error) {
      throw new Error(
        `MySQL write operation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private async ensureUsableConnection(): Promise<void> {
    if (this.connected && this.connection) return;
    if (!this.credentials) {
      throw new Error(
        "MySQL adapter is not connected. Call initialize() first.",
      );
    }
    await this.initialize(this.credentials);
  }

  private executeQuery(
    sql: string,
    params?: QueryParameter[],
  ): Promise<[mysql.QueryResult, mysql.FieldPacket[]]> {
    const connection = this.connection;
    if (!connection)
      return Promise.reject(new Error("MySQL connection not initialized"));

    return new Promise((resolve, reject) => {
      connection.execute(sql, params ?? [], (error, result, fields) => {
        if (error) reject(error);
        else resolve([result, fields ?? []]);
      });
    });
  }

  private executeControlStatement(sql: string): Promise<void> {
    const connection = this.connection;
    if (!connection)
      return Promise.reject(new Error("MySQL connection not initialized"));

    return new Promise((resolve, reject) => {
      connection.query(sql, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private streamBoundedQuery(
    sql: string,
    params: QueryParameter[] | undefined,
    maxRows: number,
  ): Promise<AdapterQueryResult> {
    const connection = this.connection;
    if (!connection)
      return Promise.reject(new Error("MySQL connection not initialized"));

    return new Promise((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      let fields: mysql.FieldPacket[] = [];
      let settled = false;
      const finish = (result: AdapterQueryResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const query = connection.query(sql, params ?? []);
      query.on("fields", (receivedFields: unknown) => {
        if (Array.isArray(receivedFields)) {
          fields = receivedFields as mysql.FieldPacket[];
        }
      });
      const stream = query.stream({ highWaterMark: 1 });
      stream.on("data", (row: Record<string, unknown>) => {
        if (settled) return;
        if (rows.length < maxRows) {
          rows.push(normalizeRowValues(row));
          return;
        }

        settled = true;
        this.invalidateConnection();
        resolve({
          rows,
          rowCount: rows.length,
          fields: this.mapFields(fields),
          hasMoreRows: true,
        });
      });
      stream.on("end", () =>
        finish({
          rows,
          rowCount: rows.length,
          fields: this.mapFields(fields),
          hasMoreRows: false,
        }),
      );
      stream.on("error", fail);
      query.on("error", fail);
    });
  }

  private mapFields(fields: readonly mysql.FieldPacket[]): FieldMetadata[] {
    return fields.map((field) => ({
      name: field.name,
      type: mapMySQLType(`mysql_type_${field.type}`),
      nullable:
        typeof field.flags === "number" ? (field.flags & 1) === 0 : true,
      length:
        typeof field.length === "number" && field.length > 0 ? field.length : 0,
      precision:
        typeof field.decimals === "number" && field.decimals > 0
          ? field.decimals
          : 0,
    }));
  }

  private invalidateConnection(): void {
    const connection = this.connection;
    this.connection = undefined;
    this.connected = false;
    connection?.destroy();
  }
}

function resumableImplicitCommitError(
  error: unknown,
  ddlCompleted: boolean,
): unknown {
  if (
    ddlCompleted &&
    error instanceof Error &&
    error.name !== "SqlChangeStaleError"
  ) {
    error.name = "SqlChangeResumeRequiredError";
  }
  return error;
}

function mysqlStatementHash(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function executedStructuredStatements(
  input: Pick<
    ApplyStructuredColumnChangeInput,
    | "ddlSql"
    | "backfillSql"
    | "preconditionSql"
    | "verificationSql"
    | "skipDdl"
    | "maximumRows"
  >,
): string {
  return [
    ...(input.skipDdl ? [] : [input.ddlSql]),
    ...(input.backfillSql && input.preconditionSql && input.verificationSql
      ? [
          "START TRANSACTION",
          `${boundedStructuredMutationSelect(input.preconditionSql, "mysql", input.maximumRows)} FOR UPDATE`,
          input.backfillSql,
          boundedStructuredMutationSelect(
            input.verificationSql,
            "mysql",
            input.maximumRows,
          ),
          "COMMIT",
        ]
      : []),
  ].join("\n");
}
