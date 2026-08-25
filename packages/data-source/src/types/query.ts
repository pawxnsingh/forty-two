/**
 * Query execution request
 */
export interface QueryRequest {
  /** SQL query string */
  sql: string;

  /** Query parameters for parameterized queries */
  params?: QueryParameter[];

  /** Optional configured data-source name to route the query to */
  dataSource?: string;

  /** Query execution options */
  options?: QueryOptions;
}

/**
 * Query parameter type for parameterized queries
 */
export type QueryParameter =
  | string
  | number
  | boolean
  | null
  | Date
  | Buffer
  | string[]
  | number[]
  | boolean[];

/**
 * Query execution options
 */
export interface QueryOptions {
  /** Query timeout in milliseconds */
  timeout?: number;

  /** Maximum number of rows to return */
  maxRows?: number;
}

/**
 * Query execution result
 */
export interface QueryResult<T = Record<string, unknown>> {
  /** Query execution success status */
  success: boolean;

  /** Result rows */
  rows: T[];

  /** Column metadata */
  columns: ColumnMetadata[];

  /** Number of rows affected (for DML operations) */
  rowsAffected?: number;

  /** Query execution time in milliseconds */
  executionTime: number;

  /** Configured data source that executed the query */
  dataSource: string;

  /** Error information if query failed */
  error?: QueryError;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Column metadata
 */
export interface ColumnMetadata {
  /** Column name */
  name: string;

  /** Column data type */
  type: string;

  /** Whether column allows null values */
  nullable: boolean;

  /** Column precision (for numeric types) */
  precision?: number;

  /** Column scale (for numeric types) */
  scale?: number;

  /** Column length (for string types) */
  length?: number;
}

/**
 * Query execution error
 */
export interface QueryError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** SQL state (if applicable) */
  sqlState?: string;

  /** Stack trace */
  stack?: string;

  /** Additional error details */
  details?: Record<string, unknown>;
}
