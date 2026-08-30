import type { DataSourceIntrospector } from "../introspection/base.js";
import type { Credentials } from "../types/credentials.js";
import type { QueryParameter } from "../types/query.js";
import type {
  ApplyControlledMutationInput,
  ApplyControlledMutationResult,
} from "../mutations/types.js";
import type {
  ApplyStructuredColumnChangeInput,
  ApplyStructuredColumnChangeResult,
} from "../mutations/structured-column-change.js";
import { isValidCredentials } from "../utils/validate-credentials.js";

/**
 * Field/column metadata for query results
 */
export interface FieldMetadata {
  /** Field name */
  name: string;
  /** Field data type */
  type: string;
  /** Whether field allows null values */
  nullable?: boolean;
  /** Field length (for string types) */
  length?: number;
  /** Field precision (for numeric types) */
  precision?: number;
  /** Field scale (for numeric types) */
  scale?: number;
}

/**
 * Simplified query result for adapters
 */
export interface AdapterQueryResult {
  /** Result rows */
  rows: Record<string, unknown>[];

  /** Number of rows returned or affected */
  rowCount: number;

  /** Field/column metadata */
  fields: FieldMetadata[];

  /** Total row count before limiting (if available) */
  totalRowCount?: number;

  /** Whether the results were limited */
  hasMoreRows?: boolean;

  /** Provider dry-run bytes for an explicitly cost-bounded read. */
  bytesProcessed?: string;
}

/**
 * Base interface that all database adapters must implement
 */
export interface DatabaseAdapter {
  /**
   * Initialize the adapter with credentials
   */
  initialize(credentials: Credentials): Promise<void>;

  /**
   * Execute a SQL query
   */
  query(
    sql: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
  ): Promise<AdapterQueryResult>;

  /** Execute a query that has already passed the read-only SQL validator. */
  queryReadOnly(
    sql: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
    maximumBytesBilled?: string,
  ): Promise<AdapterQueryResult>;

  /**
   * Test the connection to the database
   */
  testConnection(): Promise<boolean>;

  /**
   * Close the connection to the database
   */
  close(): Promise<void>;

  /**
   * Get the data source type this adapter handles
   */
  getDataSourceType(): string;

  /**
   * Get an introspector instance for this adapter
   */
  introspect(): DataSourceIntrospector;

  /**
   * Optional: Execute a write operation (INSERT, UPDATE, DELETE)
   */
  executeWrite?(
    sql: string,
    params?: QueryParameter[],
    timeout?: number,
  ): Promise<{ rowCount: number }>;

  applyControlledMutation?(
    input: ApplyControlledMutationInput,
  ): Promise<ApplyControlledMutationResult>;

  estimateControlledMutation?(input: {
    canonicalSql: string;
    params: QueryParameter[];
    timeout?: number;
  }): Promise<Record<string, unknown> | null>;

  applyStructuredColumnChange?(
    input: ApplyStructuredColumnChangeInput,
  ): Promise<ApplyStructuredColumnChangeResult>;
}

/**
 * Base adapter class with common functionality
 */
export abstract class BaseAdapter implements DatabaseAdapter {
  protected credentials?: Credentials;
  protected connected = false;

  abstract initialize(credentials: Credentials): Promise<void>;
  abstract query(
    sql: string,
    params?: QueryParameter[],
    maxRows?: number,
    timeout?: number,
  ): Promise<AdapterQueryResult>;

  async queryReadOnly(
    _sql: string,
    _params?: QueryParameter[],
    _maxRows?: number,
    _timeout?: number,
    _maximumBytesBilled?: string,
  ): Promise<AdapterQueryResult> {
    throw new Error(
      `${this.getDataSourceType()} does not provide database-enforced read-only query execution`,
    );
  }
  abstract testConnection(): Promise<boolean>;
  abstract close(): Promise<void>;
  abstract getDataSourceType(): string;
  abstract introspect(): DataSourceIntrospector;

  /**
   * Optional: Execute a write operation (INSERT, UPDATE, DELETE)
   */
  async executeWrite?(
    _sql: string,
    _params?: QueryParameter[],
    _timeout?: number,
  ): Promise<{ rowCount: number }> {
    throw new Error("Write operations not implemented for this adapter");
  }

  async applyControlledMutation?(
    _input: ApplyControlledMutationInput,
  ): Promise<ApplyControlledMutationResult> {
    throw new Error(
      "Controlled mutations are not implemented for this adapter",
    );
  }

  async applyStructuredColumnChange?(
    _input: ApplyStructuredColumnChangeInput,
  ): Promise<ApplyStructuredColumnChangeResult> {
    throw new Error(
      "Structured column changes are not implemented for this adapter",
    );
  }

  async estimateControlledMutation?(_input: {
    canonicalSql: string;
    params: QueryParameter[];
    timeout?: number;
  }): Promise<Record<string, unknown> | null> {
    return null;
  }

  /**
   * Check if the adapter is connected
   */
  protected ensureConnected(): void {
    if (!this.connected) {
      throw new Error(
        `${this.getDataSourceType()} adapter is not connected. Call initialize() first.`,
      );
    }
  }

  /**
   * Validate that credentials match the expected type
   */
  protected validateCredentials(
    credentials: Credentials,
    expectedType: string,
  ): void {
    if (credentials.type !== expectedType || !isValidCredentials(credentials)) {
      throw new Error(
        `Invalid credentials. Expected a valid ${expectedType} configuration, got ${credentials.type}`,
      );
    }
  }
}
