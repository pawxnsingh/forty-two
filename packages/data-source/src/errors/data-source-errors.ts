/**
 * Base error class for all data source related errors
 */
export abstract class DataSourceError extends Error {
  abstract readonly code: string;
  abstract readonly isRetryable: boolean;

  constructor(
    message: string,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Generic connection pool error
 */
export class ConnectionPoolError extends DataSourceError {
  readonly code = "CONNECTION_POOL_ERROR";
  readonly isRetryable = true;

  constructor(message: string, originalError?: Error) {
    super(`Connection pool error: ${message}`, originalError);
  }
}

/**
 * Connection acquisition timeout
 */
export class ConnectionAcquisitionTimeoutError extends DataSourceError {
  readonly code = "CONNECTION_ACQUISITION_TIMEOUT";
  readonly isRetryable = true;

  constructor(timeout: number, originalError?: Error) {
    super(`Failed to acquire connection within ${timeout}ms`, originalError);
  }
}

/**
 * Connection pool exhausted
 */
export class ConnectionPoolExhaustedError extends DataSourceError {
  readonly code = "CONNECTION_POOL_EXHAUSTED";
  readonly isRetryable = true;

  constructor(maxConnections: number, originalError?: Error) {
    super(`Connection pool exhausted (max: ${maxConnections})`, originalError);
  }
}

/**
 * Query execution errors
 */
export class QueryExecutionError extends DataSourceError {
  readonly code = "QUERY_EXECUTION_ERROR";
  readonly isRetryable = false;

  constructor(
    message: string,
    public readonly sql?: string,
    originalError?: Error,
  ) {
    super(`Query execution failed: ${message}`, originalError);
  }
}

/**
 * Query timeout error
 */
export class QueryTimeoutError extends DataSourceError {
  readonly code = "QUERY_TIMEOUT";
  readonly isRetryable = true;

  constructor(
    timeout: number,
    public readonly sql?: string,
    originalError?: Error,
  ) {
    super(`Query timeout after ${timeout}ms`, originalError);
  }
}

/**
 * Authentication/credential errors
 */
export class AuthenticationError extends DataSourceError {
  readonly code = "AUTHENTICATION_ERROR";
  readonly isRetryable = false;

  constructor(message: string, originalError?: Error) {
    super(`Authentication failed: ${message}`, originalError);
  }
}

/**
 * Network/connection errors
 */
export class NetworkError extends DataSourceError {
  readonly code = "NETWORK_ERROR";
  readonly isRetryable = true;

  constructor(message: string, originalError?: Error) {
    super(`Network error: ${message}`, originalError);
  }
}

/**
 * Data source configuration errors
 */
export class ConfigurationError extends DataSourceError {
  readonly code = "CONFIGURATION_ERROR";
  readonly isRetryable = false;

  constructor(message: string, originalError?: Error) {
    super(`Configuration error: ${message}`, originalError);
  }
}

/**
 * Helper function to classify errors and return appropriate DataSourceError
 */
export function classifyError(
  error: unknown,
  context?: { sql?: string; timeout?: number },
): DataSourceError {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const originalError =
    error instanceof Error ? error : new Error(String(error));

  // Connection pool errors
  if (
    errorMessage.includes("acquire connection") ||
    errorMessage.includes("Connection pool")
  ) {
    if (errorMessage.includes("timeout")) {
      return new ConnectionAcquisitionTimeoutError(
        context?.timeout || 30000,
        originalError,
      );
    }
    if (
      errorMessage.includes("limit reached") ||
      errorMessage.includes("exhausted")
    ) {
      return new ConnectionPoolExhaustedError(10, originalError); // Default max connections
    }
    return new ConnectionPoolError(errorMessage, originalError);
  }

  // Timeout errors
  if (errorMessage.includes("timeout") || errorMessage.includes("Timeout")) {
    return new QueryTimeoutError(
      context?.timeout || 60000,
      context?.sql,
      originalError,
    );
  }

  // Authentication errors
  if (
    errorMessage.includes("authentication") ||
    errorMessage.includes("Authentication") ||
    errorMessage.includes("Invalid username or password") ||
    errorMessage.includes("Access denied") ||
    errorMessage.includes("credentials")
  ) {
    return new AuthenticationError(errorMessage, originalError);
  }

  // Network errors
  if (
    errorMessage.includes("ECONNREFUSED") ||
    errorMessage.includes("ECONNRESET") ||
    errorMessage.includes("ETIMEDOUT") ||
    errorMessage.includes("ENETUNREACH") ||
    errorMessage.includes("network") ||
    errorMessage.includes("Network")
  ) {
    return new NetworkError(errorMessage, originalError);
  }

  // Configuration errors
  if (
    errorMessage.includes("configuration") ||
    errorMessage.includes("Configuration") ||
    errorMessage.includes("Invalid") ||
    errorMessage.includes("not found")
  ) {
    return new ConfigurationError(errorMessage, originalError);
  }

  // Default to query execution error
  return new QueryExecutionError(errorMessage, context?.sql, originalError);
}
