import snowflake from "snowflake-sdk";
import { TIMEOUT_CONFIG } from "../config/timeouts.js";
import {
  classifyError,
  QueryTimeoutError,
} from "../errors/data-source-errors.js";
import type { DataSourceIntrospector } from "../introspection/base.js";
import { SnowflakeIntrospector } from "../introspection/snowflake.js";
import {
  type Credentials,
  DataSourceType,
  type SnowflakeCredentials,
} from "../types/credentials.js";
import type { QueryParameter } from "../types/query.js";
import { resolveQueryTimeout } from "../utils/query-options.js";
import { checkQueryIsReadOnly } from "../utils/sql-validation.js";
import {
  type AdapterQueryResult,
  BaseAdapter,
  type FieldMetadata,
} from "./base.js";
import { normalizeRowValues } from "./helpers/normalize-values.js";
import { mapSnowflakeType } from "./type-mappings/snowflake.js";
import { AsyncMutex } from "./helpers/async-mutex.js";
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

// Use Snowflake SDK types directly
type SnowflakeError = snowflake.SnowflakeError;

interface SnowflakeStatement {
  getColumns?: () =>
    | Array<{
        getName(): string;
        getType(): string;
        isNullable(): boolean;
        getScale(): number;
        getPrecision(): number;
      }>
    | undefined;
  streamRows?: (options?: {
    start?: number;
    end?: number;
  }) => NodeJS.ReadableStream;
  cancel?: (callback: (err: Error | undefined) => void) => void;
  getNumUpdatedRows?: () => number | undefined;
  getStatementId?: () => string | undefined;
}

// Configure Snowflake SDK to disable logging
snowflake.configure({
  logLevel: "OFF",
  additionalLogToConsole: false,
});

/** Snowflake database adapter. */
export class SnowflakeAdapter extends BaseAdapter {
  private connection?: snowflake.Connection | undefined;
  private introspector?: SnowflakeIntrospector;
  private readonly queryMutex = new AsyncMutex();

  async initialize(credentials: Credentials): Promise<void> {
    this.validateCredentials(credentials, DataSourceType.Snowflake);
    const snowflakeCredentials = credentials as SnowflakeCredentials;

    try {
      this.connection = await this.createConnection(snowflakeCredentials);
      this.credentials = credentials;
      this.connected = true;
    } catch (error) {
      throw classifyError(error);
    }
  }

  private async createConnection(
    credentials: SnowflakeCredentials,
  ): Promise<snowflake.Connection> {
    const connectionOptions: snowflake.ConnectionOptions = {
      account: credentials.account_id, // Always required by SDK
      username: credentials.username,
      password: credentials.password,
      warehouse: credentials.warehouse_id,
      database: credentials.default_database,
    };

    // Use custom_host if provided via accessUrl
    if (credentials.custom_host) {
      // Ensure the URL has proper protocol
      const host = credentials.custom_host.startsWith("http")
        ? credentials.custom_host
        : `https://${credentials.custom_host}`;
      connectionOptions.accessUrl = host;
    }

    if (credentials.role) {
      connectionOptions.role = credentials.role;
    }

    if (credentials.default_schema) {
      connectionOptions.schema = credentials.default_schema;
    }

    const connection = snowflake.createConnection(connectionOptions);

    // Connect with timeout
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Connection timeout after ${TIMEOUT_CONFIG.connection.acquisition}ms`,
          ),
        );
      }, TIMEOUT_CONFIG.connection.acquisition);

      connection.connect((err) => {
        clearTimeout(timeout);
        if (err) {
          reject(new Error(`Failed to connect to Snowflake: ${err.message}`));
        } else {
          resolve(connection);
        }
      });
    });
  }

  private async testWarmConnection(
    connection: snowflake.Connection,
  ): Promise<boolean> {
    try {
      return new Promise((resolve) => {
        const timeout = setTimeout(
          () => resolve(false),
          TIMEOUT_CONFIG.connection.health,
        );

        connection.execute({
          sqlText: "SELECT 1",
          complete: (err: SnowflakeError | undefined) => {
            clearTimeout(timeout);
            resolve(!err);
          },
        });
      });
    } catch {
      return false;
    }
  }

  private async destroyConnection(
    connection: snowflake.Connection,
  ): Promise<void> {
    return new Promise((resolve) => {
      connection.destroy((err: SnowflakeError | undefined) => {
        if (err) {
          console.error("Error destroying connection:", err);
        }
        resolve();
      });
    });
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
    const validation = checkQueryIsReadOnly(sql, "snowflake");
    if (!validation.isReadOnly) {
      throw new Error(
        validation.error ?? "Snowflake read-only execution requires SELECT",
      );
    }
    return this.queryMutex.runExclusive(async () => {
      await this.executeControlStatement("BEGIN");
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
    const timeoutMs = resolveQueryTimeout(
      timeout,
      TIMEOUT_CONFIG.query.default,
    );
    this.ensureConnected();

    if (!this.connection) {
      throw new Error("Snowflake connection not initialized");
    }

    let activeStatement: SnowflakeStatement | undefined;
    const executeWithTimeout = async <T>(
      queryPromise: Promise<T>,
      timeoutMs: number,
    ): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          activeStatement?.cancel?.(() => undefined);
          reject(new QueryTimeoutError(timeoutMs, sql));
        }, timeoutMs);
      });

      try {
        return await Promise.race([queryPromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const connection = this.connection;

    try {
      // Only apply limit if explicitly requested, otherwise fetch all rows
      const limit = maxRows && maxRows > 0 ? maxRows : undefined;

      const queryPromise = new Promise<{
        rows: Record<string, unknown>[];
        statement: SnowflakeStatement;
        hasMoreRows: boolean;
      }>((resolve, reject) => {
        if (!connection) {
          reject(new Error("Failed to acquire Snowflake connection"));
          return;
        }

        activeStatement = connection.execute({
          sqlText: sql, // Use original SQL unchanged for caching
          binds: params as snowflake.Binds,
          streamResult: true, // Enable streaming
          complete: (
            err: SnowflakeError | undefined,
            stmt: SnowflakeStatement,
          ) => {
            if (err) {
              reject(new Error(`Snowflake query failed: ${err.message}`));
              return;
            }

            const rows: Record<string, unknown>[] = [];
            let hasMoreRows = false;

            // Stream rows with or without limit
            const stream = limit
              ? stmt.streamRows?.({ start: 0, end: limit })
              : stmt.streamRows?.();
            if (!stream) {
              reject(new Error("Snowflake streaming not supported"));
              return;
            }

            let rowCount = 0;

            stream
              .on("data", (row: Record<string, unknown>) => {
                // If limit is set, only keep up to limit rows
                if (!limit || rowCount < limit) {
                  // Transform column names to lowercase to match expected behavior
                  const transformedRow: Record<string, unknown> = {};
                  for (const [key, value] of Object.entries(row)) {
                    transformedRow[key.toLowerCase()] = value;
                  }
                  // Normalize values to ensure proper types (numbers, dates, etc.)
                  rows.push(normalizeRowValues(transformedRow));
                }
                rowCount++;
              })
              .on("error", (streamErr: Error) => {
                reject(
                  new Error(`Snowflake stream error: ${streamErr.message}`),
                );
              })
              .on("end", () => {
                // If we got more rows than requested, there are more available
                hasMoreRows = limit ? rowCount > limit : false;
                resolve({
                  rows,
                  statement: stmt,
                  hasMoreRows,
                });
              });
          },
        }) as SnowflakeStatement;
      });

      const result = await executeWithTimeout(queryPromise, timeoutMs);

      const fields: FieldMetadata[] =
        result.statement?.getColumns?.()?.map((col) => ({
          name: col.getName().toLowerCase(),
          type: mapSnowflakeType(col.getType()),
          nullable: col.isNullable(),
          scale: col.getScale() > 0 ? col.getScale() : 0,
          precision: col.getPrecision() > 0 ? col.getPrecision() : 0,
        })) || [];

      const queryResult = {
        rows: result.rows,
        rowCount: result.rows.length,
        fields,
        hasMoreRows: result.hasMoreRows,
      };

      return queryResult;
    } catch (error) {
      // Use the error classification system
      throw classifyError(error, {
        sql,
        timeout: timeoutMs,
      });
    }
  }

  private async executeControlStatement(sqlText: string): Promise<void> {
    this.ensureConnected();
    if (!this.connection) {
      throw new Error("Snowflake connection not initialized");
    }
    const connection = this.connection;
    await new Promise<void>((resolve, reject) => {
      connection.execute({
        sqlText,
        complete: (error: SnowflakeError | undefined) => {
          if (error) reject(new Error("Snowflake transaction control failed"));
          else resolve();
        },
      });
    });
  }

  async testConnection(): Promise<boolean> {
    if (!this.connection) {
      return false;
    }

    try {
      // Test connection by running a simple query
      const isHealthy = await this.testWarmConnection(this.connection);

      return isHealthy;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.destroyConnection(this.connection);
    }

    this.connection = undefined;
    this.connected = false;
  }

  getDataSourceType(): string {
    return DataSourceType.Snowflake;
  }

  introspect(): DataSourceIntrospector {
    this.ensureConnected();
    if (!this.introspector) {
      this.introspector = new SnowflakeIntrospector("snowflake", this);
    }
    return this.introspector;
  }

  /**
   * Execute a write operation (INSERT, UPDATE, DELETE)
   * This is a generic method for any write operations
   */
  override async executeWrite(
    sql: string,
    params?: QueryParameter[],
    timeout?: number,
  ): Promise<{ rowCount: number }> {
    const timeoutMs = resolveQueryTimeout(
      timeout,
      TIMEOUT_CONFIG.query.default,
    );
    this.ensureConnected();

    if (!this.connection) {
      throw new Error("Snowflake connection not initialized");
    }

    try {
      let statement: SnowflakeStatement | undefined;
      const operation = new Promise<{ rowCount: number }>((resolve, reject) => {
        if (!this.connection) {
          reject(new Error("Failed to acquire Snowflake connection"));
          return;
        }

        statement = this.connection.execute({
          sqlText: sql,
          binds: params as snowflake.Binds,
          streamResult: false, // Don't stream for write operations
          complete: (
            err: SnowflakeError | undefined,
            stmt: SnowflakeStatement,
          ) => {
            if (err) {
              reject(
                new Error(`Snowflake write operation failed: ${err.message}`),
              );
              return;
            }

            resolve({
              rowCount: stmt.getNumUpdatedRows?.() ?? 0,
            });
          },
        }) as SnowflakeStatement;
      });
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          statement?.cancel?.(() => undefined);
          reject(
            new Error(
              `Snowflake write timed out after ${timeoutMs}ms; its outcome is unknown`,
            ),
          );
        }, timeoutMs);
      });

      try {
        return await Promise.race([operation, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      throw classifyError(error, {
        sql,
        timeout: timeoutMs,
      });
    }
  }

  override async applyControlledMutation(
    input: ApplyControlledMutationInput,
  ): Promise<ApplyControlledMutationResult> {
    return this.queryMutex.runExclusive(async () => {
      const timeoutMs = resolveQueryTimeout(
        input.timeout,
        TIMEOUT_CONFIG.query.default,
      );
      await this.executeControlStatement("BEGIN");
      try {
        const current = await this.queryExclusive(
          input.preconditionSql,
          input.preconditionParams,
          101,
          timeoutMs,
        );
        assertMutationPreconditions(current.rows, input.expectedRowHashes);
        const changed = await this.executeMutationStatement(
          input.canonicalSql,
          input.params,
          timeoutMs,
        );
        assertAffectedRows(changed.rowCount, input.expectedAffectedRows);
        if (!changed.statementId) {
          throw new Error("Snowflake statement evidence is unavailable.");
        }
        await this.executeControlStatement("COMMIT");
        return {
          rowCount: changed.rowCount,
          providerExecutionId: changed.statementId,
          verification: {
            isolation: "provider transaction",
            conflictHandling:
              "provider write-conflict plus locked-state recheck",
            lockedRows: current.rows.length,
            affectedRows: changed.rowCount,
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
      const timeoutMs = resolveQueryTimeout(
        input.timeout,
        TIMEOUT_CONFIG.query.default,
      );
      let ddlCompleted = input.skipDdl === true;
      let ddlStatementId: string | undefined;
      try {
        const ddl = input.skipDdl
          ? null
          : await this.executeMutationStatement(input.ddlSql, [], timeoutMs);
        if (ddl) {
          if (!ddl.statementId) {
            throw new Error("Snowflake DDL evidence is unavailable.");
          }
          ddlStatementId = ddl.statementId;
          ddlCompleted = true;
        }
        let rowCount = 0;
        let backfillStatementId: string | undefined;
        let preconditionRows: Record<string, unknown>[] = [];
        let finalEvidence: Record<string, unknown> = {};
        if (input.backfillSql) {
          if (!input.preconditionSql || !input.verificationSql) {
            throw new Error("Stored backfill preconditions are unavailable.");
          }
          await this.executeControlStatement("BEGIN");
          try {
            preconditionRows = (
              await this.queryExclusive(
                boundedStructuredMutationSelect(
                  input.preconditionSql,
                  "snowflake",
                  input.maximumRows,
                ),
                [],
                input.maximumRows + 1,
                timeoutMs,
              )
            ).rows;
            assertMutationPreconditions(
              preconditionRows,
              input.expectedPreconditionRowHashes ?? input.expectedRowHashes,
            );
            const changed = await this.executeMutationStatement(
              input.backfillSql,
              [],
              timeoutMs,
            );
            rowCount = changed.rowCount;
            backfillStatementId = changed.statementId;
            assertAffectedRows(rowCount, input.expectedAffectedRows);
            finalEvidence = verifiedRowEvidence(
              (
                await this.queryExclusive(
                  boundedStructuredMutationSelect(
                    input.verificationSql,
                    "snowflake",
                    input.maximumRows,
                  ),
                  [],
                  input.maximumRows + 1,
                  timeoutMs,
                )
              ).rows,
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
        }
        const resumeEvidence =
          input.skipDdl && !backfillStatementId
            ? await this.executeMutationStatement(
                "SELECT CURRENT_TIMESTAMP()",
                [],
                timeoutMs,
              )
            : null;
        const providerExecutionId =
          backfillStatementId ??
          ddl?.statementId ??
          resumeEvidence?.statementId;
        if (!providerExecutionId)
          throw new Error("Snowflake DDL evidence is unavailable.");
        return {
          rowCount,
          providerExecutionId,
          verification: {
            mode: "idempotent_implicit_commit",
            preconditionRows: preconditionRows.length,
            ...finalEvidence,
            ddlStatementId: ddl?.statementId ?? null,
            ...(backfillStatementId ? { backfillStatementId } : {}),
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
        throw snowflakeImplicitDdlOutcome(error, {
          ddlCompleted,
          skipDdl: input.skipDdl === true,
          ddlStatementId,
        });
      }
    });
  }

  private async executeMutationStatement(
    sqlText: string,
    params: QueryParameter[],
    timeoutMs: number,
  ): Promise<{ rowCount: number; statementId: string | undefined }> {
    this.ensureConnected();
    const connection = this.connection;
    if (!connection) throw new Error("Snowflake connection not initialized");
    let active: SnowflakeStatement | undefined;
    let timer: NodeJS.Timeout | undefined;
    const operation = new Promise<{
      rowCount: number;
      statementId: string | undefined;
    }>((resolve, reject) => {
      active = connection.execute({
        sqlText,
        binds: params as snowflake.Binds,
        streamResult: false,
        complete: (
          error: SnowflakeError | undefined,
          statement: SnowflakeStatement,
        ) => {
          if (error) reject(new Error("Snowflake controlled mutation failed."));
          else {
            resolve({
              rowCount: statement.getNumUpdatedRows?.() ?? 0,
              statementId: statement.getStatementId?.(),
            });
          }
        },
      }) as SnowflakeStatement;
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        active?.cancel?.(() => undefined);
        reject(new Error("Snowflake controlled mutation timed out."));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function snowflakeImplicitDdlOutcome(
  error: unknown,
  input: {
    ddlCompleted: boolean;
    skipDdl: boolean;
    ddlStatementId: string | undefined;
  },
): unknown {
  if (
    input.ddlCompleted &&
    !input.skipDdl &&
    input.ddlStatementId &&
    error instanceof Error &&
    error.name === "SqlChangeStaleError"
  ) {
    return new SqlChangePartialCommitError(
      "Snowflake column DDL committed before the backfill became stale.",
      input.ddlStatementId,
      {
        phase: "partial_ddl_committed",
        terminal: true,
        freshApprovalRequired: true,
        ddlCommitted: true,
        ddlStatementId: input.ddlStatementId,
      },
    );
  }
  if (
    input.ddlCompleted &&
    error instanceof Error &&
    error.name !== "SqlChangeStaleError"
  ) {
    error.name = "SqlChangeResumeRequiredError";
  }
  return error;
}
