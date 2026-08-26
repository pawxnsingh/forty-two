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
import {
  type AdapterQueryResult,
  BaseAdapter,
  type FieldMetadata,
} from "./base.js";
import { normalizeRowValues } from "./helpers/normalize-values.js";
import { mapSnowflakeType } from "./type-mappings/snowflake.js";

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
}
