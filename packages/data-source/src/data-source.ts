import type { DatabaseAdapter } from "./adapters/base.js";
import { createAdapter } from "./adapters/factory.js";
import type {
  DataSourceIntrospector,
  IntrospectionQueryOptions,
} from "./introspection/base.js";
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
import {
  prepareControlledSqlChange,
  type ApplyControlledMutationInput,
  type ApplyControlledMutationResult,
  type PreparedSqlChange,
  type SqlChangeDialect,
  prepareStructuredColumnChange,
  type PreparedStructuredColumnChange,
  type StructuredColumnChange,
  StructuredColumnChangeSchema,
  fingerprintSchema,
  splitStructuredCanonicalSql,
  verifyStructuredColumnResult,
  structuredColumnTypeMatches,
  type ApplyStructuredColumnChangeResult,
} from "./mutations/index.js";
import { resolveQueryTimeout } from "./utils/query-options.js";
import { checkQueryIsReadOnly } from "./utils/sql-validation.js";

const DEFAULT_MAX_ROWS = 1_000;
const MAX_ALLOWED_ROWS = 10_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_$-]+$/;

interface AdapterInitialization {
  version: number;
  promise: Promise<DatabaseAdapter>;
}

function renderMutationTarget(
  target: { catalog?: string | null; schema?: string | null; table: string },
  dialect: SqlChangeDialect,
): string {
  const quote = (value: string): string => {
    if (dialect === "mysql" || dialect === "bigquery") {
      return `\`${value.replace(/`/g, "``")}\``;
    }
    if (dialect === "transactsql") return `[${value.replace(/]/g, "]]")}]`;
    return `"${value.replace(/"/g, '""')}"`;
  };
  return [target.catalog, target.schema, target.table]
    .filter((part): part is string => Boolean(part))
    .map(quote)
    .join(".");
}

interface InvalidatedAdapterResources {
  adapter?: DatabaseAdapter;
  initialization?: AdapterInitialization;
}

function resolveMaxRows(maxRows: number | undefined): number {
  const resolved = maxRows ?? DEFAULT_MAX_ROWS;
  if (
    !Number.isFinite(resolved) ||
    !Number.isInteger(resolved) ||
    resolved <= 0
  ) {
    throw new Error("maxRows must be a positive finite integer");
  }

  return Math.min(resolved, MAX_ALLOWED_ROWS);
}

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

function resolveIntrospectionOptions(
  options: IntrospectionQueryOptions | undefined,
): IntrospectionQueryOptions | undefined {
  if (!options) return undefined;
  return {
    ...(options.limit !== undefined
      ? { limit: resolveMaxRows(options.limit) }
      : {}),
    ...(options.timeout !== undefined
      ? { timeout: resolveQueryTimeout(options.timeout) }
      : {}),
  };
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
  private adapterInitializations: Map<string, AdapterInitialization> =
    new Map();
  private dataSourceVersions: Map<string, number> = new Map();
  private config: DataSourceManagerConfig;
  private closed = false;

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
      this.dataSourceVersions.set(dataSource.name, 0);
    }
  }

  /**
   * Get or create adapter for a data source
   */
  private async getAdapter(dataSourceName: string): Promise<DatabaseAdapter> {
    this.assertOpen();

    const existingAdapter = this.adapters.get(dataSourceName);
    if (existingAdapter) {
      return existingAdapter;
    }

    const dataSource = this.dataSources.get(dataSourceName);
    if (!dataSource) {
      throw new Error(`Data source '${dataSourceName}' not found`);
    }

    const version = this.dataSourceVersions.get(dataSourceName) ?? 0;
    const existingInitialization =
      this.adapterInitializations.get(dataSourceName);
    if (existingInitialization?.version === version) {
      return existingInitialization.promise;
    }

    const promise = this.createAndStoreAdapter(
      dataSourceName,
      dataSource,
      version,
    );
    const initialization = { version, promise };
    this.adapterInitializations.set(dataSourceName, initialization);
    void promise.then(
      () => this.clearInitialization(dataSourceName, initialization),
      () => this.clearInitialization(dataSourceName, initialization),
    );
    return promise;
  }

  private async createAndStoreAdapter(
    dataSourceName: string,
    dataSource: DataSourceConfig,
    version: number,
  ): Promise<DatabaseAdapter> {
    try {
      const adapter = await createAdapter(dataSource.credentials);
      const isCurrent =
        !this.closed &&
        this.dataSourceVersions.get(dataSourceName) === version &&
        this.dataSources.get(dataSourceName) === dataSource;

      if (!isCurrent) {
        await adapter.close();
        throw new Error(
          `Data source '${dataSourceName}' changed during adapter initialization`,
        );
      }

      this.adapters.set(dataSourceName, adapter);
      return adapter;
    } catch (error) {
      throw new Error(
        `Failed to create adapter for '${dataSourceName}': ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private clearInitialization(
    dataSourceName: string,
    initialization: AdapterInitialization,
  ): void {
    if (this.adapterInitializations.get(dataSourceName) === initialization) {
      this.adapterInitializations.delete(dataSourceName);
    }
  }

  /**
   * Execute a query on the specified data source
   */
  async execute<T = Record<string, unknown>>(
    request: QueryRequest,
  ): Promise<QueryResult<T>> {
    const maxRows = resolveMaxRows(request.options?.maxRows);
    if (request.options?.timeout !== undefined) {
      resolveQueryTimeout(request.options.timeout);
    }
    const dataSourceName = this.resolveDataSource(request);
    const adapter = await this.getAdapter(dataSourceName);
    const startedAt = performance.now();
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
      const result = await adapter.queryReadOnly(
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

  async prepareSqlChange(input: {
    dataSource: string;
    sql: string;
    dialect: SqlChangeDialect;
    timeout?: number;
    maxRows?: number;
    maximumBytesBilled?: string;
  }): Promise<PreparedSqlChange> {
    const adapter = await this.getAdapter(input.dataSource);
    return prepareControlledSqlChange({ adapter, ...input });
  }

  async applySqlChange(
    dataSourceName: string,
    input: ApplyControlledMutationInput,
  ): Promise<ApplyControlledMutationResult> {
    const adapter = await this.getAdapter(dataSourceName);
    if (!adapter.applyControlledMutation) {
      throw new Error(
        "Controlled mutations are unavailable for this connector.",
      );
    }
    return adapter.applyControlledMutation(input);
  }

  async estimateSqlChange(input: {
    dataSource: string;
    canonicalSql: string;
    timeout?: number;
  }): Promise<Record<string, unknown> | null> {
    const adapter = await this.getAdapter(input.dataSource);
    return (
      (await adapter.estimateControlledMutation?.({
        canonicalSql: input.canonicalSql,
        params: [],
        timeout: input.timeout,
      })) ?? null
    );
  }

  async prepareColumnChange(input: {
    dataSource: string;
    dialect: SqlChangeDialect;
    change: StructuredColumnChange;
    timeout?: number;
    maxRows?: number;
    maximumBytesBilled?: string;
  }): Promise<PreparedStructuredColumnChange> {
    const adapter = await this.getAdapter(input.dataSource);
    return prepareStructuredColumnChange({ adapter, ...input });
  }

  async applyColumnChange(input: {
    dataSource: string;
    dialect: SqlChangeDialect;
    change: StructuredColumnChange;
    canonicalSql: string;
    expectedSchemaFingerprint: string;
    expectedAffectedRows: number;
    maximumRows: number;
    preconditionSql: string | null;
    verificationSql: string | null;
    expectedRowHashes: string[];
    expectedPreconditionRowHashes?: string[];
    providerPrecondition?: {
      kind: "bigquery_row_json";
      values: string[];
      verificationValues?: string[];
    };
    executionToken: string;
    maximumBytesBilled?: string;
    ddlAlreadyCommitted?: boolean;
    timeout?: number;
  }): Promise<ApplyStructuredColumnChangeResult> {
    const adapter = await this.getAdapter(input.dataSource);
    if (!adapter.applyStructuredColumnChange) {
      throw new Error(
        "Structured column changes are unavailable for this connector.",
      );
    }
    const parsedChange = StructuredColumnChangeSchema.parse(input.change);
    const target = parsedChange.target;
    const before = await adapter
      .introspect()
      .getColumns(
        target.catalog ?? undefined,
        target.schema ?? undefined,
        target.table,
      );
    const resume = resolveStructuredResume(
      parsedChange,
      before,
      input.expectedSchemaFingerprint,
      input.dialect,
    );
    if (!resume.matches) {
      const error = new Error("Column-change schema precondition is stale.");
      error.name = "SqlChangeStaleError";
      throw error;
    }
    const renderedTarget = {
      catalog: target.catalog ?? null,
      schema: target.schema ?? null,
      table: target.table,
      sql: renderMutationTarget(target, input.dialect),
    };
    const phases = splitStructuredCanonicalSql({
      operation: parsedChange.operation,
      canonicalSql: input.canonicalSql,
    });
    const skipDdl = resume.skipDdl || input.ddlAlreadyCommitted === true;
    const result = await adapter.applyStructuredColumnChange({
      operation: parsedChange.operation,
      target: renderedTarget,
      ...phases,
      expectedSchemaFingerprint: input.expectedSchemaFingerprint,
      expectedAffectedRows: input.expectedAffectedRows,
      maximumRows: input.maximumRows,
      preconditionSql: input.preconditionSql,
      verificationSql: input.verificationSql,
      expectedRowHashes: input.expectedRowHashes,
      expectedPreconditionRowHashes: input.expectedPreconditionRowHashes,
      ...(input.providerPrecondition
        ? { providerPrecondition: input.providerPrecondition }
        : {}),
      executionToken: input.executionToken,
      ...(input.maximumBytesBilled
        ? { maximumBytesBilled: input.maximumBytesBilled }
        : {}),
      skipDdl,
      timeout: input.timeout,
    });
    const after = await adapter
      .introspect()
      .getColumns(
        target.catalog ?? undefined,
        target.schema ?? undefined,
        target.table,
      );
    return {
      ...result,
      verification: {
        ...result.verification,
        ...verifyStructuredColumnResult(parsedChange, after, input.dialect),
        schemaFingerprint: fingerprintSchema(after),
        resumedAfterImplicitCommit: skipDdl,
      },
    };
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
      getDatabases: (options?: IntrospectionQueryOptions) =>
        introspector.getDatabases(resolveIntrospectionOptions(options)),
      getSchemas: (database?: string, options?: IntrospectionQueryOptions) => {
        assertSafeIdentifier(database, "database");
        return introspector.getSchemas(
          database,
          resolveIntrospectionOptions(options),
        );
      },
      getTables: (
        database?: string,
        schema?: string,
        options?: IntrospectionQueryOptions,
      ) => {
        assertSafeIdentifier(database, "database");
        assertSafeIdentifier(schema, "schema");
        return introspector.getTables(
          database,
          schema,
          resolveIntrospectionOptions(options),
        );
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
  async getDatabases(
    dataSourceName?: string,
    options?: IntrospectionQueryOptions,
  ): Promise<Database[]> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getDatabases(resolveIntrospectionOptions(options));
  }

  /**
   * Get all schemas from a data source
   */
  async getSchemas(
    dataSourceName?: string,
    database?: string,
    options?: IntrospectionQueryOptions,
  ): Promise<Schema[]> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getSchemas(
      database,
      resolveIntrospectionOptions(options),
    );
  }

  /**
   * Get all tables from a data source
   */
  async getTables(
    dataSourceName?: string,
    database?: string,
    schema?: string,
    options?: IntrospectionQueryOptions,
  ): Promise<Table[]> {
    const introspector = await this.introspect(dataSourceName);
    return introspector.getTables(
      database,
      schema,
      resolveIntrospectionOptions(options),
    );
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
    this.assertOpen();
    // Validate that we don't already have a data source with this name
    if (this.dataSources.has(config.name)) {
      throw new Error(`Data source with name '${config.name}' already exists`);
    }
    if (config.type !== config.credentials.type) {
      throw new Error("Data source type does not match its credentials");
    }

    this.dataSources.set(config.name, config);
    this.dataSourceVersions.set(config.name, 0);
    const addVersion = 0;

    // Test the connection by creating and connecting the adapter
    try {
      await this.getAdapter(config.name);
    } catch (error) {
      // Do not delete a concurrently removed and re-added configuration.
      if (this.isCurrentConfiguration(config.name, config, addVersion)) {
        this.dataSources.delete(config.name);
        this.dataSourceVersions.delete(config.name);
      }
      throw new Error(
        `Failed to add data source '${config.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Remove a data source
   */
  async removeDataSource(name: string): Promise<void> {
    this.assertOpen();
    const resources = this.invalidateAdapter(name);
    this.dataSources.delete(name);
    await this.closeInvalidatedResources(resources);
  }

  /**
   * Update data source configuration
   */
  async updateDataSource(
    name: string,
    config: Partial<DataSourceConfig>,
  ): Promise<void> {
    this.assertOpen();
    const existingConfig = this.dataSources.get(name);
    if (!existingConfig) {
      throw new Error(`Data source '${name}' not found`);
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

    if (!config.credentials && !config.type) {
      this.dataSources.set(name, updatedConfig);
      return;
    }

    const resources = this.invalidateAdapter(name);
    const updateVersion = this.dataSourceVersions.get(name) ?? 0;
    this.dataSources.set(name, updatedConfig);
    await this.closeInvalidatedResources(resources);

    if (!this.isCurrentConfiguration(name, updatedConfig, updateVersion)) {
      throw new Error(`Data source '${name}' changed during update`);
    }

    try {
      await this.getAdapter(name);
    } catch (error) {
      if (this.isCurrentConfiguration(name, updatedConfig, updateVersion)) {
        const failedResources = this.invalidateAdapter(name);
        this.dataSources.set(name, existingConfig);
        await this.closeInvalidatedResources(failedResources);
      }
      throw new Error(
        `Failed to update data source '${name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const names = new Set([
      ...this.dataSources.keys(),
      ...this.adapters.keys(),
      ...this.adapterInitializations.keys(),
    ]);
    const resources = Array.from(names, (name) => this.invalidateAdapter(name));
    await Promise.all(
      resources.map((resource) => this.closeInvalidatedResources(resource)),
    );
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Data source manager is closed");
    }
  }

  private invalidateAdapter(name: string): InvalidatedAdapterResources {
    const version = (this.dataSourceVersions.get(name) ?? 0) + 1;
    this.dataSourceVersions.set(name, version);

    const adapter = this.adapters.get(name);
    const initialization = this.adapterInitializations.get(name);
    this.adapters.delete(name);
    this.adapterInitializations.delete(name);

    return { adapter, initialization };
  }

  private async closeInvalidatedResources(
    resources: InvalidatedAdapterResources,
  ): Promise<void> {
    const adapters = new Set<DatabaseAdapter>();
    if (resources.adapter) adapters.add(resources.adapter);

    if (resources.initialization) {
      try {
        adapters.add(await resources.initialization.promise);
      } catch {
        // Stale and failed initializations clean up before rejecting.
      }
    }

    await Promise.all(Array.from(adapters, (adapter) => adapter.close()));
  }

  private isCurrentConfiguration(
    name: string,
    config: DataSourceConfig,
    version: number,
  ): boolean {
    return (
      !this.closed &&
      this.dataSources.get(name) === config &&
      this.dataSourceVersions.get(name) === version
    );
  }
}

function resolveStructuredResume(
  change: StructuredColumnChange,
  columns: Column[],
  expectedFingerprint: string,
  dialect: SqlChangeDialect,
): { matches: boolean; skipDdl: boolean } {
  if (fingerprintSchema(columns) === expectedFingerprint) {
    return { matches: true, skipDdl: false };
  }
  const byName = new Map(
    columns.map((column) => [column.name.toLowerCase(), column]),
  );
  if (change.operation === "rename_column") {
    if (
      byName.has(change.sourceColumn.toLowerCase()) ||
      !byName.has(change.destinationColumn.toLowerCase())
    ) {
      return { matches: false, skipDdl: false };
    }
    const reconstructed = columns.map((column) =>
      column.name.toLowerCase() === change.destinationColumn.toLowerCase()
        ? { ...column, name: change.sourceColumn }
        : column,
    );
    return {
      matches: fingerprintSchema(reconstructed) === expectedFingerprint,
      skipDdl: true,
    };
  }
  const added = byName.get(change.columnName.toLowerCase());
  if (
    !added ||
    !added.isNullable ||
    added.defaultValue != null ||
    !structuredColumnTypeMatches(added, change.columnType, dialect)
  ) {
    return { matches: false, skipDdl: false };
  }
  const withoutAdded = columns
    .filter((column) => column !== added)
    .map((column, index) => ({ ...column, position: index + 1 }));
  return {
    matches: fingerprintSchema(withoutAdded) === expectedFingerprint,
    skipDdl: true,
  };
}
