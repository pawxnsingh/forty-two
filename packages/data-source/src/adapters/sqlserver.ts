import sql from "mssql";
import type { DataSourceIntrospector } from "../introspection/base.js";
import { SQLServerIntrospector } from "../introspection/sqlserver.js";
import {
  type Credentials,
  DataSourceType,
  type SQLServerCredentials,
} from "../types/credentials.js";
import type { QueryParameter } from "../types/query.js";
import { resolveQueryTimeout } from "../utils/query-options.js";
import {
  type AdapterQueryResult,
  BaseAdapter,
  type FieldMetadata,
} from "./base.js";
import { normalizeRowValues } from "./helpers/normalize-values.js";
import { convertPositionalPlaceholders } from "./helpers/positional-placeholders.js";
import type {
  ApplyControlledMutationInput,
  ApplyControlledMutationResult,
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

// Internal types for mssql column metadata that aren't properly exported
interface ColumnMetadata {
  type?: (() => { name?: string }) | { name?: string };
  length?: number;
  nullable?: boolean;
}

/**
 * SQL Server database adapter
 */
export class SQLServerAdapter extends BaseAdapter {
  private pool?: sql.ConnectionPool | undefined;
  private introspector?: SQLServerIntrospector;

  private async executeWithTimeout<T>(
    request: sql.Request,
    queryPromise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        request.cancel();
        reject(
          new Error(`SQL Server query execution timeout after ${timeoutMs}ms`),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([queryPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async initialize(credentials: Credentials): Promise<void> {
    this.validateCredentials(credentials, DataSourceType.SQLServer);
    const sqlServerCredentials = credentials as SQLServerCredentials;

    try {
      const config: sql.config = {
        server: sqlServerCredentials.server,
        port: sqlServerCredentials.port,
        database: sqlServerCredentials.default_database,
        user: sqlServerCredentials.username,
        password: sqlServerCredentials.password,
        options: {
          encrypt: sqlServerCredentials.encrypt ?? true,
          trustServerCertificate:
            sqlServerCredentials.trust_server_certificate ?? false,
        },
      };

      // Handle domain authentication
      if (sqlServerCredentials.domain) {
        config.domain = sqlServerCredentials.domain;
      }

      // Handle instance name
      if (sqlServerCredentials.instance) {
        if (!config.options) {
          config.options = {};
        }
        config.options.instanceName = sqlServerCredentials.instance;
      }

      // Handle timeouts
      if (sqlServerCredentials.connection_timeout) {
        config.connectionTimeout = sqlServerCredentials.connection_timeout;
      }

      if (sqlServerCredentials.request_timeout) {
        config.requestTimeout = sqlServerCredentials.request_timeout;
      }

      this.pool = new sql.ConnectionPool(config);
      await this.pool.connect();

      this.credentials = credentials;
      this.connected = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize SQL Server client: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async query(
    sqlQuery: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
  ): Promise<AdapterQueryResult> {
    this.ensureConnected();
    if (!this.pool) {
      throw new Error("SQL Server connection pool not initialized");
    }
    return this.executeRequest(
      this.pool.request(),
      sqlQuery,
      params,
      maxRows,
      timeout,
    );
  }

  async queryReadOnly(
    sqlQuery: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
  ): Promise<AdapterQueryResult> {
    this.ensureConnected();
    if (!this.pool) {
      throw new Error("SQL Server connection pool not initialized");
    }

    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    try {
      const result = await this.executeRequest(
        transaction.request(),
        sqlQuery,
        params,
        maxRows,
        timeout,
      );
      await transaction.rollback();
      return result;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }

  private async executeRequest(
    request: sql.Request,
    sqlQuery: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
  ): Promise<AdapterQueryResult> {
    const timeoutMs = resolveQueryTimeout(timeout);

    try {
      const parameterValues = params ?? [];
      const processedQuery = convertPositionalPlaceholders(
        sqlQuery,
        parameterValues.length,
        (index) => `@param${index}`,
      ).sql;

      // Add parameters if provided
      if (parameterValues.length > 0) {
        parameterValues.forEach((param, index) => {
          request.input(`param${index}`, param);
        });
      }

      // If no maxRows specified, use regular query
      if (!maxRows || maxRows <= 0) {
        const result = await this.executeWithTimeout(
          request,
          request.query(processedQuery),
          timeoutMs,
        );

        const fields: FieldMetadata[] = result.recordset?.columns
          ? Object.keys(result.recordset.columns).map((name) => {
              const column = result.recordset?.columns?.[name];
              const columnType =
                typeof column?.type === "function"
                  ? column.type()
                  : column?.type;

              // Type the column type properly instead of using unknown
              const typedColumnType = columnType as
                { name?: string } | undefined;

              return {
                name,
                type: typedColumnType?.name || "unknown",
                length: column?.length ?? 0,
                nullable: column?.nullable ?? true,
              };
            })
          : [];

        return {
          rows: (result.recordset || []).map(normalizeRowValues),
          rowCount: result.recordset?.length || 0,
          fields,
          hasMoreRows: false,
        };
      }

      // Use streaming for SELECT queries with maxRows
      const streamingPromise = new Promise<AdapterQueryResult>(
        (resolve, reject) => {
          const rows: Record<string, unknown>[] = [];
          let hasMoreRows = false;
          let fields: FieldMetadata[] = [];
          let rowCount = 0;

          // Enable streaming mode
          request.stream = true;

          // Listen for column metadata
          request.on("recordset", (columns: Record<string, ColumnMetadata>) => {
            fields = Object.keys(columns).map((name) => {
              const column = columns[name];
              const columnType =
                typeof column?.type === "function"
                  ? column.type()
                  : column?.type;
              const typedColumnType = columnType as
                { name?: string } | undefined;

              return {
                name,
                type: typedColumnType?.name || "unknown",
                length: column?.length ?? 0,
                nullable: column?.nullable ?? true,
              };
            });
          });

          // Listen for each row
          request.on("row", (row: Record<string, unknown>) => {
            if (rowCount < maxRows) {
              rows.push(normalizeRowValues(row));
              rowCount++;
            } else if (rowCount === maxRows) {
              hasMoreRows = true;
              // Pause the stream to stop receiving more rows
              request.pause();
              // Cancel the request to stop processing
              request.cancel();
            }
          });

          // Listen for errors
          request.on("error", (err) => {
            reject(new Error(`SQL Server query failed: ${err.message}`));
          });

          // Listen for completion
          request.on("done", () => {
            resolve({
              rows,
              rowCount: rows.length,
              fields,
              hasMoreRows,
            });
          });

          // Execute the query
          request.query(processedQuery);
        },
      );

      return await this.executeWithTimeout(
        request,
        streamingPromise,
        timeoutMs,
      );
    } catch (error) {
      throw new Error(
        `SQL Server query failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.pool) {
        return false;
      }

      // Test connection by running a simple query
      const request = this.pool.request();
      await request.query("SELECT 1 as test");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.close();
      } catch (error) {
        // Log error but don't throw - connection is being closed anyway
        console.error("Error closing SQL Server connection:", error);
      }
      this.pool = undefined;
    }
    this.connected = false;
  }

  getDataSourceType(): string {
    return DataSourceType.SQLServer;
  }

  introspect(): DataSourceIntrospector {
    this.ensureConnected();
    if (!this.introspector) {
      this.introspector = new SQLServerIntrospector("sqlserver", this);
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
    const timeoutMs = resolveQueryTimeout(timeout);
    this.ensureConnected();

    if (!this.pool) {
      throw new Error("SQL Server pool not initialized");
    }

    try {
      const request = this.pool.request();

      const parameterValues = params ?? [];
      const processedQuery = convertPositionalPlaceholders(
        sql,
        parameterValues.length,
        (index) => `@param${index}`,
      ).sql;

      // Add parameters if provided
      if (parameterValues.length > 0) {
        parameterValues.forEach((param, index) => {
          request.input(`param${index}`, param);
        });
      }

      const result = await this.executeWithTimeout(
        request,
        request.query(processedQuery),
        timeoutMs,
      );

      return {
        rowCount: result.rowsAffected[0] ?? 0,
      };
    } catch (error) {
      throw new Error(
        `SQL Server write operation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  override async applyControlledMutation(
    input: ApplyControlledMutationInput,
  ): Promise<ApplyControlledMutationResult> {
    const timeoutMs = resolveQueryTimeout(input.timeout);
    this.ensureConnected();
    if (!this.pool) throw new Error("SQL Server pool not initialized");
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const lockedSql = input.preconditionSql.replace(
        new RegExp(`FROM\\s+${escapeRegex(input.targetSql)}`, "i"),
        `FROM ${input.targetSql} WITH (UPDLOCK, HOLDLOCK)`,
      );
      const locked = await this.executeRequest(
        transaction.request(),
        lockedSql,
        input.preconditionParams,
        undefined,
        timeoutMs,
      );
      assertMutationPreconditions(locked.rows, input.expectedRowHashes);

      const request = transaction.request();
      const conversion = convertPositionalPlaceholders(
        input.canonicalSql,
        input.params.length,
        (index) => `@param${index}`,
      );
      input.params.forEach((parameter, index) =>
        request.input(`param${index}`, parameter),
      );
      const changed = await this.executeWithTimeout(
        request,
        request.query(conversion.sql),
        timeoutMs,
      );
      const rowCount = changed.rowsAffected[0] ?? 0;
      assertAffectedRows(rowCount, input.expectedAffectedRows);
      const evidence = await transaction
        .request()
        .query<{ id: string }>(
          "SELECT CONVERT(varchar(128), CURRENT_TRANSACTION_ID()) AS id",
        );
      const providerExecutionId = evidence.recordset[0]?.id;
      if (!providerExecutionId) {
        throw new Error("SQL Server transaction evidence is unavailable.");
      }
      await transaction.commit();
      return {
        rowCount,
        providerExecutionId,
        verification: {
          isolation: "serializable",
          locking: "UPDLOCK,HOLDLOCK",
          lockedRows: locked.rows.length,
          affectedRows: rowCount,
        },
      };
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }

  override async applyStructuredColumnChange(
    input: ApplyStructuredColumnChangeInput,
  ): Promise<ApplyStructuredColumnChangeResult> {
    const timeoutMs = resolveQueryTimeout(input.timeout);
    this.ensureConnected();
    if (!this.pool) throw new Error("SQL Server pool not initialized");
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      let preconditionRows: Record<string, unknown>[] = [];
      if (input.backfillSql) {
        if (!input.preconditionSql || !input.verificationSql) {
          throw new Error("Stored backfill preconditions are unavailable.");
        }
        preconditionRows = (
          await transaction
            .request()
            .query(
              boundedStructuredMutationSelect(
                input.preconditionSql,
                "transactsql",
                input.maximumRows,
              ),
            )
        ).recordset.map(normalizeRowValues);
        assertMutationPreconditions(
          preconditionRows,
          input.expectedPreconditionRowHashes ?? input.expectedRowHashes,
        );
      }
      if (!input.skipDdl) await transaction.request().query(input.ddlSql);
      const changed = input.backfillSql
        ? await transaction.request().query(input.backfillSql)
        : null;
      const rowCount = changed?.rowsAffected[0] ?? 0;
      assertAffectedRows(rowCount, input.expectedAffectedRows);
      const evidence = await transaction
        .request()
        .query<{ id: string }>(
          "SELECT CONVERT(varchar(128), CURRENT_TRANSACTION_ID()) AS id",
        );
      const providerExecutionId = evidence.recordset[0]?.id;
      if (!providerExecutionId)
        throw new Error("SQL Server DDL evidence is unavailable.");
      const finalEvidence = input.verificationSql
        ? verifiedRowEvidence(
            (
              await transaction
                .request()
                .query(
                  boundedStructuredMutationSelect(
                    input.verificationSql,
                    "transactsql",
                    input.maximumRows,
                  ),
                )
            ).recordset.map(normalizeRowValues),
            input.expectedRowHashes,
          )
        : {};
      await transaction.commit();
      return {
        rowCount,
        providerExecutionId,
        verification: {
          mode: "transactional_ddl",
          isolation: "serializable",
          preconditionRows: preconditionRows.length,
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
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
