import type { DatabaseAdapter } from "./adapters/base.js";
import { createAdapter } from "./adapters/factory.js";
import type { DataSourceIntrospector } from "./introspection/base.js";
import type { Credentials, DataSourceType } from "./types/credentials.js";
import type {
  Column,
  Database,
  DataSourceIntrospectionResult,
  Schema,
  Table,
  TableStatistics,
  View,
} from "./types/introspection.js";
import type { QueryRequest, QueryResult } from "./types/query.js";
import { checkQueryIsReadOnly } from "./utils/sql-validation.js";

const DEFAULT_MAX_ROWS = 1_000;
const MAX_ALLOWED_ROWS = 10_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_$-]+$/;

function assertSafeIdentifier(value: string | undefined, label: string): void {
  if (value !== undefined && !SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid ${label}: only simple database identifiers are allowed`,
    );
  }
}

function assertSafeIdentifiers(
  values: readonly string[] | undefined,
  label: string,
): void {
  values?.forEach((value) => assertSafeIdentifier(value, label));
}

/**
 * Data source configuration for the DataSource
 */
export interface DataSourceConfig {
  /** Unique identifier for this data source */
  name: string;

  /** Type of data source */
  type: DataSourceType;

  /** Credentials for connecting to the data source */
  credentials: Credentials;
}

/**
 * Configuration for the DataSource
 */
export interface DataSourceManagerConfig {
  /** List of data source configurations */
  dataSources: DataSourceConfig[];

  /** Default data source to use if none specified */
  defaultDataSource?: string;
}

/**
 * Main DataSource class that provides routing and introspection across multiple data source types
 */
export class DataSource {
  private dataSources: Map<string, DataSourceConfig> = new Map();
  private adapters: Map<string, DatabaseAdapter> = new Map();
  private config: DataSourceManagerConfig;

  constructor(config: DataSourceManagerConfig) {
    this.config = config;
    this.initializeDataSources();
  }

  /**
   * Initialize data source configurations
   */
  private initializeDataSources(): void {
    for (const dataSource of this.config.dataSources) {
      if (this.dataSources.has(dataSource.name)) {
        throw new Error(`Duplicate data source name '${dataSource.name}'`);
      }
      if (dataSource.type !== dataSource.credentials.type) {
        throw new Error(
          `Data source '${dataSource.name}' type does not match its credentials`,
        );
      }
      this.dataSources.set(dataSource.name, dataSource);
    }
  }

  /**
   * Get or create adapter for a data source
   */
  private async getAdapter(dataSourceName: string): Promise<DatabaseAdapter> {
    const existingAdapter = this.adapters.get(dataSourceName);
    if (existingAdapter) {
      return existingAdapter;
    }

    const dataSource = this.dataSources.get(dataSourceName);
    if (!dataSource) {
      throw new Error(`Data source '${dataSourceName}' not found`);
    }

    try {
      const adapter = await createAdapter(dataSource.credentials);
      this.adapters.set(dataSourceName, adapter);
      return adapter;
    } catch (error) {
      throw new Error(
        `Failed to create adapter for '${dataSourceName}': ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Execute a query on the specified data source
   */
  async execute<T = Record<string, unknown>>(
    request: QueryRequest,
  ): Promise<QueryResult<T>> {
    const dataSourceName = this.resolveDataSource(request);
    const adapter = await this.getAdapter(dataSourceName);
    const startedAt = performance.now();
    const maxRows = Math.min(
      Math.max(request.options?.maxRows ?? DEFAULT_MAX_ROWS, 1),
      MAX_ALLOWED_ROWS,
    );
    const validation = checkQueryIsReadOnly(
      request.sql,
      adapter.getDataSourceType(),
    );

    if (!validation.isReadOnly) {
      return {
        success: false,
        rows: [],
        columns: [],
        executionTime: performance.now() - startedAt,
        dataSource: dataSourceName,
        error: {
          code: "READ_ONLY_QUERY_REQUIRED",
          message: validation.error ?? "Only read-only queries are allowed",
        },
      };
    }

    try {
      const result = await adapter.query(
        request.sql,
        request.params,
        maxRows,
        request.options?.timeout,
      );

      // Convert adapter result to QueryResult format
      return {
        success: true,
        rows: result.rows as T[],
        columns: result.fields.map((field) => ({
          name: field.name || "unknown",
          type: field.type || "unknown",
          nullable: field.nullable ?? true,
          precision: field.precision ?? 0,
          scale: field.scale ?? 0,
          length: field.length ?? 0,
        })),
        rowsAffected: result.rowCount,
        executionTime: performance.now() - startedAt,
        dataSource: dataSourceName,
        metadata: {
          ...(result.hasMoreRows !== undefined
            ? { limited: result.hasMoreRows, maxRows }
            : {}),
          ...(result.totalRowCount !== undefined
            ? { totalRowCount: result.totalRowCount }
            : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        rows: [],
        columns: [],
        executionTime: performance.now() - startedAt,
        dataSource: dataSourceName,
        error: {
          code: "QUERY_EXECUTION_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  // ========== INTROSPECTION METHODS ==========

  /**
   * Get an introspector instance for a specific data source
   */
  async introspect(dataSourceName?: string): Promise<DataSourceIntrospector> {
    const resolvedDataSourceName =
      dataSourceName || this.getDefaultDataSourceName();
    const adapter = await this.getAdapter(resolvedDataSourceName);
    const introspector = adapter.introspect();

    // Keep caller-controlled identifiers out of the introspectors' SQL builders.
    return {
      getDatabases: () => introspector.getDatabases(),
      getSchemas: (database?: string) => {
        assertSafeIdentifier(database, "database");
        return introspector.getSchemas(database);
      },
      getTables: (database?: string, schema?: string) => {
        assertSafeIdentifier(database, "database");
        assertSafeIdentifier(schema, "schema");
        return introspector.getTables(database, schema);
      },
      getColumns: (database?: string, schema?: string, table?: string) => {
        assertSafeIdentifier(database, "database");
        assertSafeIdentifier(schema, "schema");
        assertSafeIdentifier(table, "table");
        return introspector.getColumns(database, schema, table);
      },
      getViews: (database?: string, schema?: string) => {
        assertSafeIdentifier(database, "database");
        assertSafeIdentifier(schema, "schema");
        return introspector.getViews(database, schema);
      },
      getTableStatistics: (database: string, schema: string, table: string) => {
        assertSafeIdentifier(database, "database");
        assertSafeIdentifier(schema, "schema");
        assertSafeIdentifier(table, "table");
        return introspector.getTableStatistics(database, schema, table);
      },
      getColumnStatistics: (
        database: string,
        schema: string,
        table: string,
      ) => {
        assertSafeIdentifier(database, "database");
        assertSafeIdentifier(schema, "schema");
        assertSafeIdentifier(table, "table");
        return introspector.getColumnStatistics(database, schema, table);
      },
      ...(introspector.getIndexes && {
        getIndexes: (database?: string, schema?: string) => {
          assertSafeIdentifier(database, "database");
          assertSafeIdentifier(schema, "schema");
          return (
            introspector.getIndexes?.(database, schema) ?? Promise.resolve([])
          );
        },
      }),
      ...(introspector.getForeignKeys && {
        getForeignKeys: (database?: string, schema?: string) => {
          assertSafeIdentifier(database, "database");
          assertSafeIdentifier(schema, "schema");
          return (
            introspector.getForeignKeys?.(database, schema) ??
            Promise.resolve([])
          );
        },
      }),
      getDataSourceType: () => introspector.getDataSourceType(),
      async getFullIntrospection(options?: {
        databases?: string[];
        schemas?: string[];
        tables?: string[];
      }): Promise<DataSourceIntrospectionResult> {
        assertSafeIdentifiers(options?.databases, "database");
        assertSafeIdentifiers(options?.schemas, "schema");
        assertSafeIdentifiers(options?.tables, "table");
        const result = await introspector.getFullIntrospection(options);
        return {
          ...result,
          dataSourceName: resolvedDataSourceName,
        };
      },
    };
  }

  /**
   * Get all databases from a data source
   */
  async getDatabases(dataSourceName?: string): Promise<Database[]> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getDatabases();
  }

  /**
   * Get all schemas from a data source
   */
  async getSchemas(
    dataSourceName?: string,
    database?: string,
  ): Promise<Schema[]> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getSchemas(database);
  }

  /**
   * Get all tables from a data source
   */
  async getTables(
    dataSourceName?: string,
    database?: string,
    schema?: string,
  ): Promise<Table[]> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getTables(database, schema);
  }

  /**
   * Get all columns from a data source
   */
  async getColumns(
    dataSourceName?: string,
    database?: string,
    schema?: string,
    table?: string,
  ): Promise<Column[]> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getColumns(database, schema, table);
  }

  /**
   * Get all views from a data source
   */
  async getViews(
    dataSourceName?: string,
    database?: string,
    schema?: string,
  ): Promise<View[]> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getViews(database, schema);
  }

  /**
   * Get table statistics for a specific table
   */
  async getTableStatistics(
    database: string,
    schema: string,
    table: string,
    dataSourceName?: string,
  ): Promise<TableStatistics> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getTableStatistics(database, schema, table);
  }

  /**
   * Get comprehensive introspection data for a data source
   */
  async getFullIntrospection(
    dataSourceName?: string,
    options?: {
      databases?: string[];
      schemas?: string[];
      tables?: string[];
    },
  ): Promise<DataSourceIntrospectionResult> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getFullIntrospection(options);
  }

  // ========== UTILITY METHODS ==========

  /**
   * Get the default data source name
   */
  private getDefaultDataSourceName(): string {
    if (this.config.defaultDataSource) {
      return this.config.defaultDataSource;
    }

    if (this.dataSources.size === 1) {
      const firstKey = Array.from(this.dataSources.keys())[0];
      if (!firstKey) {
        throw new Error("No data sources configured");
      }
      return firstKey;
    }

    throw new Error(
      "No default data source configured and multiple data sources available. " +
        "Please specify a data source name.",
    );
  }

  /**
   * Resolve which data source to use for the query
   */
  private resolveDataSource(request: QueryRequest): string {
    // If data source is explicitly specified in the request, use it
    if (request.dataSource) {
      if (!this.dataSources.has(request.dataSource)) {
        throw new Error(
          `Specified data source '${request.dataSource}' not found`,
        );
      }
      return request.dataSource;
    }

    // Use default data source if configured
    if (this.config.defaultDataSource) {
      if (!this.dataSources.has(this.config.defaultDataSource)) {
        throw new Error(
          `Default data source '${this.config.defaultDataSource}' not found`,
        );
      }
      return this.config.defaultDataSource;
    }

    // If only one data source is configured, use it
    if (this.dataSources.size === 1) {
      const firstKey = Array.from(this.dataSources.keys())[0];
      if (!firstKey) {
        throw new Error("No data sources configured");
      }
      return firstKey;
    }

    // No data source specified and no default configured
    throw new Error(
      "No data source specified in request and no default data source configured. " +
        "Please specify a data source in the request or configure a default data source.",
    );
  }

  /**
   * Test connection to a specific data source
   */
  async testDataSource(dataSourceName: string): Promise<boolean> {
    try {
      const adapter = await this.getAdapter(dataSourceName);
      return adapter.testConnection();
    } catch {
      return false;
    }
  }

  /**
   * Test connections to all data sources
   */
  async testAllDataSources(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const dataSourceName of this.dataSources.keys()) {
      results[dataSourceName] = await this.testDataSource(dataSourceName);
    }

    return results;
  }

  /**
   * Get list of configured data sources
   */
  getDataSources(): string[] {
    return Array.from(this.dataSources.keys());
  }

  /**
   * Add a new data source configuration
   */
  async addDataSource(config: DataSourceConfig): Promise<void> {
    // Validate that we don't already have a data source with this name
    if (this.dataSources.has(config.name)) {
      throw new Error(`Data source with name '${config.name}' already exists`);
    }
    if (config.type !== config.credentials.type) {
      throw new Error("Data source type does not match its credentials");
    }

    this.dataSources.set(config.name, config);

    // Test the connection by creating and connecting the adapter
    try {
      await this.getAdapter(config.name);
    } catch (error) {
      // Remove the data source if connection fails
      this.dataSources.delete(config.name);
      throw new Error(
        `Failed to add data source '${config.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Remove a data source
   */
  async removeDataSource(name: string): Promise<void> {
    const adapter = this.adapters.get(name);
    if (adapter) {
      await adapter.close();
      this.adapters.delete(name);
    }

    this.dataSources.delete(name);
  }

  /**
   * Update data source configuration
   */
  async updateDataSource(
    name: string,
    config: Partial<DataSourceConfig>,
  ): Promise<void> {
    const existingConfig = this.dataSources.get(name);
    if (!existingConfig) {
      throw new Error(`Data source '${name}' not found`);
    }

    // Disconnect existing adapter if credentials or type changed
    if (config.credentials || config.type) {
      const adapter = this.adapters.get(name);
      if (adapter) {
        await adapter.close();
        this.adapters.delete(name);
      }
    }

    // Update configuration
    const updatedConfig: DataSourceConfig = {
      ...existingConfig,
      ...config,
      name, // Ensure name doesn't change
    };

    if (updatedConfig.type !== updatedConfig.credentials.type) {
      throw new Error("Data source type does not match its credentials");
    }

    this.dataSources.set(name, updatedConfig);

    // Test new configuration if credentials or type changed
    if (config.credentials || config.type) {
      try {
        await this.getAdapter(name);
      } catch (error) {
        // Restore original configuration if new one fails
        this.dataSources.set(name, existingConfig);
        throw new Error(
          `Failed to update data source '${name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    const disconnectPromises = Array.from(this.adapters.values()).map(
      (adapter) => adapter.close(),
    );

    await Promise.all(disconnectPromises);
    this.adapters.clear();
  }
}
