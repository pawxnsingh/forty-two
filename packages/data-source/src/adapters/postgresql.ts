import { Client, type ClientConfig } from "pg";
import Cursor from "pg-cursor";
import type { DataSourceIntrospector } from "../introspection/base.js";
import { PostgreSQLIntrospector } from "../introspection/postgresql.js";
import {
  type Credentials,
  DataSourceType,
  type PostgreSQLCredentials,
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
import { mapPostgreSQLType } from "./type-mappings/postgresql.js";
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

// Internal types for pg-cursor that aren't exported
interface CursorResult {
  fields: Array<{
    name: string;
    dataTypeID: number;
    dataTypeSize: number;
  }>;
}

interface CursorWithResult extends Cursor {
  _result?: CursorResult;
}

/**
 * PostgreSQL database adapter
 */
export class PostgreSQLAdapter extends BaseAdapter {
  private client?: Client | undefined;
  private introspector?: PostgreSQLIntrospector;
  private readonly queryMutex = new AsyncMutex();

  async initialize(credentials: Credentials): Promise<void> {
    this.validateCredentials(credentials, DataSourceType.PostgreSQL);
    const pgCredentials = credentials as PostgreSQLCredentials;

    try {
      // Handle both 'database' and 'default_database' for backward compatibility
      const database = pgCredentials.database || pgCredentials.default_database;

      if (!database) {
        throw new Error(
          'Database name is required. Please provide either "database" or "default_database" in credentials.',
        );
      }

      const config: ClientConfig = {
        host: pgCredentials.host,
        port: pgCredentials.port || 5432,
        database: database,
        user: pgCredentials.username,
        password: pgCredentials.password,
      };

      // Require authenticated TLS unless local/development credentials
      // explicitly opt out with `ssl: false`.
      if (pgCredentials.ssl !== false) {
        config.ssl =
          pgCredentials.ssl === true || pgCredentials.ssl === undefined
            ? { rejectUnauthorized: true }
            : {
                ...pgCredentials.ssl,
                rejectUnauthorized:
                  pgCredentials.ssl.rejectUnauthorized ?? true,
              };
      }

      // Handle connection timeout
      if (pgCredentials.connection_timeout) {
        config.connectionTimeoutMillis = pgCredentials.connection_timeout;
      }

      // Set default schema if provided
      if (pgCredentials.schema) {
        config.options = `-c search_path=${pgCredentials.schema}`;
      }

      this.client = new Client(config);
      await this.client.connect();

      this.credentials = credentials;
      this.connected = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize PostgreSQL client: ${error instanceof Error ? error.message : "Unknown error"}`,
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
      this.ensureConnected();
      if (!this.client) throw new Error("PostgreSQL client not initialized");

      await this.client.query("BEGIN READ ONLY");
      try {
        const result = await this.queryExclusive(sql, params, maxRows, timeout);
        await this.client.query("ROLLBACK");
        return result;
      } catch (error) {
        await this.client.query("ROLLBACK").catch(() => undefined);
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
    this.ensureConnected();

    if (!this.client) {
      throw new Error("PostgreSQL client not initialized");
    }

    try {
      await this.client.query(`SET statement_timeout = ${timeoutMs}`);

      // If no maxRows specified, use regular query
      if (!maxRows || maxRows <= 0) {
        const result = await this.client.query(sql, params);

        const fields: FieldMetadata[] =
          result.fields?.map((field) => ({
            name: field.name,
            type: mapPostgreSQLType(`pg_type_${field.dataTypeID}`), // Map OID to normalized type
            nullable: true, // PostgreSQL doesn't provide this info directly
            length: field.dataTypeSize > 0 ? field.dataTypeSize : 0,
          })) || [];

        return {
          rows: result.rows.map(normalizeRowValues),
          rowCount: result.rowCount || result.rows.length,
          fields,
          hasMoreRows: false,
        };
      }

      // Use cursor for SELECT queries with maxRows
      const cursor = this.client.query(
        new Cursor(sql, params),
      ) as CursorWithResult;
      const rows: Record<string, unknown>[] = [];
      let hasMoreRows = false;
      let fields: FieldMetadata[] = [];

      // Read rows in batches
      const batchSize = Math.min(maxRows, 1000); // Read up to 1000 rows at a time
      let totalRead = 0;

      while (totalRead < maxRows) {
        const remainingRows = maxRows - totalRead;
        const readSize = Math.min(batchSize, remainingRows) + 1; // Read one extra to check for more

        const batchRows = await new Promise<Record<string, unknown>[]>(
          (resolve, reject) => {
            cursor.read(readSize, (err, batchRows) => {
              if (err) {
                reject(err);
              } else {
                resolve(batchRows);
              }
            });
          },
        );

        if (batchRows.length === 0) {
          break; // No more rows
        }

        // Extract field metadata from cursor on first batch
        if (fields.length === 0 && cursor._result?.fields) {
          fields = cursor._result.fields.map((field) => ({
            name: field.name,
            type: mapPostgreSQLType(`pg_type_${field.dataTypeID}`), // Map OID to normalized type
            nullable: true,
            length: field.dataTypeSize > 0 ? field.dataTypeSize : 0,
          }));
        }

        // Check if we have more rows than requested
        if (totalRead + batchRows.length > maxRows) {
          hasMoreRows = true;
          rows.push(
            ...batchRows.slice(0, maxRows - totalRead).map(normalizeRowValues),
          );
          break;
        }

        rows.push(...batchRows.map(normalizeRowValues));
        totalRead += batchRows.length;

        // If we got fewer rows than requested, we've reached the end
        if (batchRows.length < readSize) {
          break;
        }
      }

      // Close the cursor
      await new Promise<void>((resolve, reject) => {
        cursor.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      return {
        rows,
        rowCount: rows.length,
        fields,
        hasMoreRows,
      };
    } catch (error) {
      throw new Error(
        `PostgreSQL query failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.client) {
        return false;
      }

      // Test connection by running a simple query
      await this.client.query("SELECT 1 as test");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.end();
      } catch (error) {
        // Log error but don't throw - connection is being closed anyway
        console.error("Error closing PostgreSQL connection:", error);
      }
      this.client = undefined;
    }
    this.connected = false;
  }

  getDataSourceType(): string {
    return DataSourceType.PostgreSQL;
  }

  introspect(): DataSourceIntrospector {
    this.ensureConnected();
    if (!this.introspector) {
      this.introspector = new PostgreSQLIntrospector("postgresql", this);
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
      this.ensureConnected();
      if (!this.client) throw new Error("PostgreSQL client not initialized");
      await this.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      try {
        await this.client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
        const locked = await this.client.query(
          `${input.preconditionSql} FOR UPDATE`,
          input.preconditionParams,
        );
        const rows = locked.rows.map(normalizeRowValues);
        assertMutationPreconditions(rows, input.expectedRowHashes);
        const changed = await this.client.query(
          input.canonicalSql,
          input.params,
        );
        const rowCount = changed.rowCount ?? 0;
        assertAffectedRows(rowCount, input.expectedAffectedRows);
        const evidence = await this.client.query<{ id: string }>(
          "SELECT txid_current()::text AS id",
        );
        const providerExecutionId = evidence.rows[0]?.id;
        if (!providerExecutionId)
          throw new Error("PostgreSQL transaction evidence is unavailable.");
        await this.client.query("COMMIT");
        return {
          rowCount,
          providerExecutionId,
          verification: {
            isolation: "serializable",
            lockedRows: rows.length,
            affectedRows: rowCount,
          },
        };
      } catch (error) {
        await this.client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  override async applyStructuredColumnChange(
    input: ApplyStructuredColumnChangeInput,
  ): Promise<ApplyStructuredColumnChangeResult> {
    return this.queryMutex.runExclusive(async () => {
      const timeoutMs = resolveQueryTimeout(input.timeout);
      this.ensureConnected();
      if (!this.client) throw new Error("PostgreSQL client not initialized");
      await this.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      try {
        await this.client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
        let preconditionRows: Record<string, unknown>[] = [];
        if (input.backfillSql) {
          if (!input.preconditionSql || !input.verificationSql) {
            throw new Error("Stored backfill preconditions are unavailable.");
          }
          const current = await this.client.query(
            `${boundedStructuredMutationSelect(input.preconditionSql, "postgresql", input.maximumRows)} FOR UPDATE`,
          );
          preconditionRows = current.rows.map(normalizeRowValues);
          assertMutationPreconditions(
            preconditionRows,
            input.expectedPreconditionRowHashes ?? input.expectedRowHashes,
          );
        }
        if (!input.skipDdl) await this.client.query(input.ddlSql);
        const changed = input.backfillSql
          ? await this.client.query(input.backfillSql)
          : null;
        const rowCount = changed?.rowCount ?? 0;
        assertAffectedRows(rowCount, input.expectedAffectedRows);
        const evidence = await this.client.query<{ id: string }>(
          "SELECT txid_current()::text AS id",
        );
        const providerExecutionId = evidence.rows[0]?.id;
        if (!providerExecutionId)
          throw new Error("PostgreSQL DDL evidence is unavailable.");
        const finalEvidence = input.verificationSql
          ? verifiedRowEvidence(
              (
                await this.client.query(
                  boundedStructuredMutationSelect(
                    input.verificationSql,
                    "postgresql",
                    input.maximumRows,
                  ),
                )
              ).rows.map(normalizeRowValues),
              input.expectedRowHashes,
            )
          : {};
        await this.client.query("COMMIT");
        return {
          rowCount,
          providerExecutionId,
          verification: {
            mode: "transactional_ddl",
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
        await this.client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  private async executeWriteExclusive(
    sql: string,
    params?: QueryParameter[],
    timeout?: number,
  ): Promise<{ rowCount: number }> {
    const timeoutMs = resolveQueryTimeout(timeout);
    this.ensureConnected();

    if (!this.client) {
      throw new Error("PostgreSQL client not initialized");
    }

    try {
      await this.client.query(`SET statement_timeout = ${timeoutMs}`);

      const result = await this.client.query(sql, params);

      return {
        rowCount: result.rowCount ?? 0,
      };
    } catch (error) {
      throw new Error(
        `PostgreSQL write operation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}
