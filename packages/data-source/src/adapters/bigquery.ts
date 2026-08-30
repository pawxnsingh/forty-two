import {
  BigQuery,
  type BigQueryOptions,
  type Job,
  type Query,
  type QueryRowsResponse,
  type TableSchema,
} from "@google-cloud/bigquery";
import type { DataSourceIntrospector } from "../introspection/base.js";
import { BigQueryIntrospector } from "../introspection/bigquery.js";
import {
  type BigQueryCredentials,
  type Credentials,
  DataSourceType,
} from "../types/credentials.js";
import type { QueryParameter } from "../types/query.js";
import { normalizeBigQueryLocation } from "../utils/bigquery-location.js";
import { resolveQueryTimeout } from "../utils/query-options.js";
import {
  type AdapterQueryResult,
  BaseAdapter,
  type FieldMetadata,
} from "./base.js";
import { fixBigQueryTableReferences } from "./helpers/bigquery-sql-fixer.js";
import { normalizeRowValues } from "./helpers/normalize-values.js";
import { convertPositionalPlaceholders } from "./helpers/positional-placeholders.js";
import {
  getBigQuerySimpleType,
  mapBigQueryType,
} from "./type-mappings/bigquery.js";
import type {
  ApplyControlledMutationInput,
  ApplyControlledMutationResult,
} from "../mutations/types.js";
import {
  assertAffectedRows,
  verifiedRowEvidence,
} from "../mutations/verify.js";
import {
  buildBigQueryBackfillScript,
  buildBigQueryRowMutationScript,
} from "../mutations/bigquery-workflow.js";
import {
  type ApplyStructuredColumnChangeInput,
  type ApplyStructuredColumnChangeResult,
} from "../mutations/structured-column-change.js";

/**
 * BigQuery database adapter
 */
export class BigQueryAdapter extends BaseAdapter {
  private client?: BigQuery | undefined;
  private introspector?: BigQueryIntrospector;

  async initialize(credentials: Credentials): Promise<void> {
    this.validateCredentials(credentials, DataSourceType.BigQuery);
    const bigqueryCredentials = credentials as BigQueryCredentials;
    const location = normalizeBigQueryLocation(bigqueryCredentials.location);

    try {
      const options: BigQueryOptions = {
        projectId: bigqueryCredentials.project_id,
      };

      // Handle service account authentication
      if (bigqueryCredentials.service_account_key) {
        // Check if it's already an object
        if (typeof bigqueryCredentials.service_account_key === "object") {
          options.credentials = bigqueryCredentials.service_account_key;
        } else if (
          typeof bigqueryCredentials.service_account_key === "string"
        ) {
          try {
            // Try to parse as JSON string
            const keyData = JSON.parse(bigqueryCredentials.service_account_key);
            options.credentials = keyData;
          } catch {
            // If parsing fails, treat as file path
            options.keyFilename = bigqueryCredentials.service_account_key;
          }
        }
      } else if (bigqueryCredentials.key_file_path) {
        options.keyFilename = bigqueryCredentials.key_file_path;
      }

      // Set location - default to US if not specified
      options.location = location;

      this.client = new BigQuery(options);
      this.credentials = { ...bigqueryCredentials, location };
      this.connected = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize BigQuery client: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async query(
    sql: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
  ): Promise<AdapterQueryResult> {
    return this.executeQuery(sql, params, maxRows, timeout);
  }

  async queryReadOnly(
    sql: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
    maximumBytesBilled?: string,
  ): Promise<AdapterQueryResult> {
    const timeoutMs = resolveQueryTimeout(timeout);
    this.ensureConnected();
    if (!this.client) throw new Error("BigQuery client not initialized");

    const options = this.buildQueryOptions(sql, params, timeoutMs, maxRows);
    const [dryRunJob] = await this.client.createQueryJob({
      ...options,
      dryRun: true,
    });
    const [metadata] = await dryRunJob.getMetadata();
    const statementType = metadata.statistics?.query?.statementType;
    if (statementType !== "SELECT") {
      throw new Error("BigQuery read-only execution requires a SELECT job");
    }
    const bytesProcessed = String(
      metadata.statistics?.totalBytesProcessed ?? "0",
    );
    if (maximumBytesBilled !== undefined) {
      assertBigQueryMaximumBytes(maximumBytesBilled);
      if (BigInt(bytesProcessed) > BigInt(maximumBytesBilled)) {
        throw new Error("BigQuery read exceeds the configured cost limit.");
      }
    }
    const result = await this.executeQuery(
      sql,
      params,
      maxRows,
      timeout,
      maximumBytesBilled,
    );
    return { ...result, bytesProcessed };
  }

  private async executeQuery(
    sql: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
    maximumBytesBilled?: string,
  ): Promise<AdapterQueryResult> {
    const timeoutMs = resolveQueryTimeout(timeout);
    this.ensureConnected();

    if (!this.client) {
      throw new Error("BigQuery client not initialized");
    }

    try {
      const options = this.buildQueryOptions(sql, params, timeoutMs, maxRows);
      if (maximumBytesBilled !== undefined) {
        assertBigQueryMaximumBytes(maximumBytesBilled);
        options.maximumBytesBilled = maximumBytesBilled;
      }

      // Apply row limit if specified
      let hasMoreRows = false;
      if (maxRows && maxRows > 0) {
        // BigQuery supports maxResults natively
        options.maxResults = maxRows + 1;
      }

      const [job] = await this.client.createQueryJob(options);
      const queryResults: QueryRowsResponse = await job.getQueryResults();

      // QueryRowsResponse is [RowMetadata[]] or [RowMetadata[], Query | null, QueryResultsResponse]
      const rows = queryResults[0];

      // The third element contains the API response with schema when present
      // The API response may include a table schema.
      const apiResponse = queryResults.length > 2 ? queryResults[2] : null;

      // Extract field metadata from BigQuery schema first (we need this for unwrapping)
      const fields: FieldMetadata[] = [];
      const timestampFields = new Set<string>();
      if (apiResponse && "schema" in apiResponse && apiResponse.schema) {
        const tableSchema = apiResponse.schema as TableSchema;
        if (tableSchema.fields && Array.isArray(tableSchema.fields)) {
          for (const field of tableSchema.fields) {
            // Track which fields are timestamp/datetime types
            if (
              field.type === "TIMESTAMP" ||
              field.type === "DATETIME" ||
              field.type === "DATE" ||
              field.type === "TIME"
            ) {
              timestampFields.add(field.name || "");
            }

            const normalizedType = mapBigQueryType(field.type || "STRING");
            fields.push({
              name: field.name || "",
              type: normalizedType,
              nullable: field.mode !== "REQUIRED",
              // BigQuery doesn't provide length/precision in standard schema
              length: 0,
              precision: 0,
            });
          }
        }
      }

      // Convert BigQuery rows to plain objects and normalize values
      // Unwrap timestamp fields that BigQuery returns as objects
      let resultRows: Record<string, unknown>[] = rows.map((row) => {
        const processedRow: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          // If this is a timestamp field and the value is an object with a 'value' property,
          // extract the actual timestamp string
          if (
            timestampFields.has(key) &&
            typeof value === "object" &&
            value !== null &&
            "value" in value
          ) {
            processedRow[key] = (value as { value: unknown }).value;
          } else {
            processedRow[key] = value;
          }
        }
        return normalizeRowValues(processedRow);
      });

      // Check if we have more rows than requested
      if (maxRows && resultRows.length > maxRows) {
        hasMoreRows = true;
        // Remove the extra row we fetched to check for more
        resultRows = resultRows.slice(0, maxRows);
      }

      return {
        rows: resultRows,
        rowCount: resultRows.length,
        fields,
        hasMoreRows,
      };
    } catch (error) {
      throw new Error(
        `BigQuery query failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private buildQueryOptions(
    sql: string,
    params: QueryParameter[] | undefined,
    timeoutMs: number,
    maxRows: number | undefined,
  ): Query {
    const fixedSql = fixBigQueryTableReferences(sql);
    const parameterValues = params ?? [];
    const conversion = convertPositionalPlaceholders(
      fixedSql,
      parameterValues.length,
      (index) => `@param${index}`,
      { hashLineComments: true },
    );
    const options: Query = {
      query: conversion.sql,
      useLegacySql: false,
      jobTimeoutMs: timeoutMs,
      ...(maxRows && maxRows > 0 ? { maxResults: maxRows + 1 } : {}),
    };
    if (parameterValues.length > 0) {
      options.params = Object.fromEntries(
        parameterValues.map((value, index) => [`param${index}`, value]),
      );
    }
    return options;
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.client) {
        return false;
      }

      // Test connection by running a simple query
      const [job] = await this.client.createQueryJob({
        query: "SELECT 1 as test",
        useLegacySql: false,
      });

      await job.getQueryResults();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // BigQuery client doesn't require explicit closing
    this.connected = false;
    this.client = undefined;
  }

  getDataSourceType(): string {
    return DataSourceType.BigQuery;
  }

  introspect(): DataSourceIntrospector {
    this.ensureConnected();
    if (!this.introspector) {
      const credentials = this.credentials as BigQueryCredentials;
      this.introspector = new BigQueryIntrospector(
        "bigquery",
        this,
        credentials.project_id,
        normalizeBigQueryLocation(credentials.location),
      );
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

    if (!this.client) {
      throw new Error("BigQuery client not initialized");
    }

    try {
      const options: {
        query: string;
        timeoutMs: number;
        params?: unknown[];
      } = {
        query: sql,
        timeoutMs,
      };

      if (params && params.length > 0) {
        options.params = params;
      }

      const [job] = await this.client.createQueryJob(options);
      await job.getQueryResults();
      const [metadata] = await job.getMetadata();
      const queryStats = metadata.statistics?.query as
        | {
            numDmlAffectedRows?: string;
            dmlStats?: {
              insertedRowCount?: string;
              updatedRowCount?: string;
              deletedRowCount?: string;
            };
          }
        | undefined;
      const affectedRows =
        queryStats?.numDmlAffectedRows ??
        queryStats?.dmlStats?.insertedRowCount ??
        queryStats?.dmlStats?.updatedRowCount ??
        queryStats?.dmlStats?.deletedRowCount ??
        "0";

      return {
        rowCount: Number(affectedRows),
      };
    } catch (error) {
      throw new Error(
        `BigQuery write operation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  override async estimateControlledMutation(input: {
    canonicalSql: string;
    params: QueryParameter[];
    timeout?: number;
  }): Promise<Record<string, unknown> | null> {
    const timeoutMs = resolveQueryTimeout(input.timeout);
    this.ensureConnected();
    if (!this.client) throw new Error("BigQuery client not initialized");
    const options = this.buildQueryOptions(
      input.canonicalSql,
      input.params,
      timeoutMs,
      undefined,
    );
    const [job] = await this.client.createQueryJob({
      ...options,
      dryRun: true,
    });
    const [metadata] = await job.getMetadata();
    const bytes = metadata.statistics?.totalBytesProcessed ?? "0";
    return {
      dryRunBytesProcessed: String(bytes),
      location: options.location ?? null,
    };
  }

  override async applyControlledMutation(
    input: ApplyControlledMutationInput,
  ): Promise<ApplyControlledMutationResult> {
    const timeoutMs = resolveQueryTimeout(input.timeout);
    this.ensureConnected();
    if (!this.client) throw new Error("BigQuery client not initialized");
    if (input.providerPrecondition?.kind !== "bigquery_row_json") {
      throw new Error(
        "BigQuery provider precondition evidence is unavailable.",
      );
    }
    const script = buildBigQueryRowMutationScript({
      preconditionSql: input.preconditionSql,
      mutationSql: input.canonicalSql,
      expectedRows: input.providerPrecondition.values,
      expectedAffectedRows: input.expectedAffectedRows,
    });
    const options = {
      ...this.buildQueryOptions(script, input.params, timeoutMs, undefined),
      ...(input.maximumBytesBilled
        ? { maximumBytesBilled: input.maximumBytesBilled }
        : {}),
    };
    const job = await this.runIdempotentMutationJob(
      options,
      `${input.executionToken}_row`,
      script,
    );
    const providerExecutionId = job.id;
    if (!providerExecutionId)
      throw new Error("BigQuery job evidence is unavailable.");
    return {
      rowCount: input.expectedAffectedRows,
      providerExecutionId,
      verification: {
        mode: "multi_statement_transaction",
        preconditionRows: input.providerPrecondition.values.length,
        affectedRows: input.expectedAffectedRows,
      },
    };
  }

  override async applyStructuredColumnChange(
    input: ApplyStructuredColumnChangeInput,
  ): Promise<ApplyStructuredColumnChangeResult> {
    const timeoutMs = resolveQueryTimeout(input.timeout);
    this.ensureConnected();
    if (!this.client) throw new Error("BigQuery client not initialized");
    let ddlCompleted = input.skipDdl === true;
    try {
      const ddlJob = input.skipDdl
        ? null
        : await this.runIdempotentMutationJob(
            {
              ...this.buildQueryOptions(input.ddlSql, [], timeoutMs, undefined),
              ...(input.maximumBytesBilled
                ? { maximumBytesBilled: input.maximumBytesBilled }
                : {}),
            },
            `${input.executionToken}_ddl`,
            input.ddlSql,
          );
      if (ddlJob) ddlCompleted = true;
      let rowCount = 0;
      let backfillJobId: string | undefined;
      let finalEvidence: Record<string, unknown> = {};
      if (input.backfillSql) {
        if (
          !input.preconditionSql ||
          !input.verificationSql ||
          input.providerPrecondition?.kind !== "bigquery_row_json"
        ) {
          throw new Error(
            "Stored BigQuery backfill preconditions are unavailable.",
          );
        }
        const script = buildBigQueryBackfillScript({
          preconditionSql: input.preconditionSql,
          backfillSql: input.backfillSql,
          verificationSql: input.verificationSql,
          expectedRows: input.providerPrecondition.values,
          expectedVerificationRows:
            input.providerPrecondition.verificationValues,
          expectedAffectedRows: input.expectedAffectedRows,
        });
        try {
          const backfillJob = await this.runIdempotentMutationJob(
            {
              ...this.buildQueryOptions(script, [], timeoutMs, undefined),
              ...(input.maximumBytesBilled
                ? { maximumBytesBilled: input.maximumBytesBilled }
                : {}),
            },
            `${input.executionToken}_backfill`,
            script,
          );
          backfillJobId = backfillJob.id;
        } catch (error) {
          if (
            error instanceof Error &&
            /stale backfill precondition|affected row mismatch|backfill verification mismatch/i.test(
              error.message,
            )
          ) {
            error.name = "SqlChangeStaleError";
          }
          throw error;
        }
        rowCount = input.expectedAffectedRows;
        finalEvidence = verifiedRowEvidence(
          providerJsonRows(
            input.providerPrecondition.verificationValues ??
              input.providerPrecondition.values,
          ),
          input.expectedRowHashes,
        );
      } else {
        assertAffectedRows(0, input.expectedAffectedRows);
      }
      const resumeJob =
        input.skipDdl && !backfillJobId
          ? await this.runIdempotentMutationJob(
              this.buildQueryOptions(
                "SELECT CURRENT_TIMESTAMP()",
                [],
                timeoutMs,
                undefined,
              ),
              `${input.executionToken}_resume`,
              "SELECT CURRENT_TIMESTAMP()",
            )
          : null;
      const providerExecutionId = backfillJobId ?? ddlJob?.id ?? resumeJob?.id;
      if (!providerExecutionId)
        throw new Error("BigQuery DDL job evidence is unavailable.");
      return {
        rowCount,
        providerExecutionId,
        verification: {
          mode: "idempotent_implicit_commit",
          ddlJobId: ddlJob?.id ?? null,
          ...(backfillJobId ? { backfillJobId } : {}),
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
        error instanceof Error &&
        error.name !== "SqlChangeStaleError"
      ) {
        error.name = "SqlChangeResumeRequiredError";
      }
      throw error;
    }
  }

  private async runIdempotentMutationJob(
    options: Query,
    jobId: string,
    expectedSql: string,
  ): Promise<Job> {
    this.ensureConnected();
    if (!this.client) throw new Error("BigQuery client not initialized");
    let job: Job;
    try {
      [job] = await this.client.createQueryJob({ ...options, jobId });
    } catch (error) {
      if (!isBigQueryAlreadyExists(error)) throw error;
      job = this.client.job(jobId, {
        location:
          typeof options.location === "string" ? options.location : undefined,
      });
    }
    await job.getQueryResults();
    const [metadata] = await job.getMetadata();
    if (metadata.configuration?.query?.query !== expectedSql) {
      const error = new Error(
        "BigQuery mutation job identity collision detected.",
      );
      error.name = "SqlChangeStaleError";
      throw error;
    }
    return job;
  }
}

function assertBigQueryMaximumBytes(value: string): void {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error("BigQuery maximumBytesBilled must be a positive integer.");
  }
}

function providerJsonRows(values: string[]): Record<string, unknown>[] {
  return values.map((value) => {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("BigQuery provider verification evidence is invalid.");
    }
    return parsed as Record<string, unknown>;
  });
}

function isBigQueryAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Number(error.code) === 409
  );
}
