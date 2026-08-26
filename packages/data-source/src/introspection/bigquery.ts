import type { AdapterQueryResult, DatabaseAdapter } from "../adapters/base.js";
import { DataSourceType } from "../types/credentials.js";
import type { QueryParameter } from "../types/query.js";
import type {
  Column,
  ColumnStatistics,
  Database,
  DataSourceIntrospectionResult,
  Schema,
  Table,
  TableStatistics,
  View,
} from "../types/introspection.js";
import { BaseIntrospector, type IntrospectionQueryOptions } from "./base.js";
import { ConcurrencyLimiter, mapWithConcurrency } from "./concurrency.js";
import {
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteStringLiteral,
} from "./sql-quoting.js";

/**
 * BigQuery-specific introspector implementation
 * Uses BigQuery's INFORMATION_SCHEMA for metadata queries
 * Optimized to batch metadata queries for efficiency
 */
export class BigQueryIntrospector extends BaseIntrospector {
  private static readonly MAX_CONCURRENT_QUERIES = 8;
  private adapter: DatabaseAdapter;
  private readonly queryLimiter = new ConcurrencyLimiter(
    BigQueryIntrospector.MAX_CONCURRENT_QUERIES,
  );
  private cache: {
    databases?: { data: Database[]; lastFetched: Date };
    schemas?: { data: Schema[]; lastFetched: Date };
    tables?: { data: Table[]; lastFetched: Date };
    columns?: { data: Column[]; lastFetched: Date };
    views?: { data: View[]; lastFetched: Date };
  } = {};

  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    dataSourceName: string,
    adapter: DatabaseAdapter,
    private readonly defaultProject: string,
    private readonly location: string,
  ) {
    super(dataSourceName);
    this.adapter = adapter;
  }

  getDataSourceType(): string {
    return DataSourceType.BigQuery;
  }

  /**
   * Check if cached data is still valid
   */
  private isCacheValid(lastFetched: Date): boolean {
    return Date.now() - lastFetched.getTime() < this.CACHE_TTL;
  }

  async getDatabases(options?: IntrospectionQueryOptions): Promise<Database[]> {
    // Check if we have valid cached data
    if (
      this.cache.databases &&
      this.isCacheValid(this.cache.databases.lastFetched)
    ) {
      return this.cache.databases.data.slice(0, options?.limit);
    }

    const databases: Database[] = [
      this.createProjectDatabase(this.defaultProject),
    ];
    this.cache.databases = { data: databases, lastFetched: new Date() };
    return databases.slice(0, options?.limit);
  }

  async getSchemas(
    database?: string,
    options?: IntrospectionQueryOptions,
  ): Promise<Schema[]> {
    // Only use cache if no filter is applied
    if (
      !database &&
      this.cache.schemas &&
      this.isCacheValid(this.cache.schemas.lastFetched)
    ) {
      return this.cache.schemas.data.slice(0, options?.limit);
    }

    try {
      const project = database ?? this.defaultProject;
      let query = `
        SELECT schema_name as dataset_name,
               catalog_name as project_name,
               location,
               creation_time
        FROM ${this.regionInformationSchemaView(project, "SCHEMATA")}
        WHERE schema_name NOT IN ('INFORMATION_SCHEMA')
      `;

      query += ` AND catalog_name = ${quoteStringLiteral(project)}`;

      query += " ORDER BY schema_name";

      const datasetsResult = await this.query(query, undefined, options);

      const schemas = datasetsResult.rows.map((row) => ({
        name: this.getString(row.dataset_name) || "",
        database: this.getString(row.project_name) || "default_project",
        created: this.parseDate(row.creation_time) || new Date(),
        metadata: {
          project_name: this.getString(row.project_name),
          location: this.getString(row.location),
        },
      }));

      // Only cache if no filter was applied
      if (!database && !options?.limit) {
        this.cache.schemas = { data: schemas, lastFetched: new Date() };
      }

      return schemas;
    } catch (error) {
      console.warn("Failed to fetch BigQuery schemas:", error);
      return [];
    }
  }

  async getTables(
    database?: string,
    schema?: string,
    options?: IntrospectionQueryOptions,
  ): Promise<Table[]> {
    if (!schema) {
      const schemas = await this.getSchemas(database, options);
      const tables: Table[] = [];
      for (const item of schemas) {
        if (options?.limit !== undefined && tables.length >= options.limit)
          break;
        const remaining =
          options?.limit === undefined
            ? undefined
            : options.limit - tables.length;
        tables.push(
          ...(await this.getTables(item.database, item.name, {
            ...options,
            limit: remaining,
          })),
        );
      }
      return tables;
    }

    try {
      let whereClause = "WHERE table_type IN ('BASE TABLE', 'EXTERNAL')";

      if (database) {
        whereClause += ` AND table_catalog = ${quoteStringLiteral(database)}`;
      }
      if (schema) {
        whereClause += ` AND table_schema = ${quoteStringLiteral(schema)}`;
      }

      const tablesResult = await this.query(
        `
        SELECT table_catalog as project_name,
               table_schema as dataset_name,
               table_name,
               table_type,
               creation_time,
               ddl
        FROM ${this.informationSchemaView(database, schema, "TABLES")}
        ${whereClause}
        ORDER BY table_schema, table_name
      `,
        undefined,
        options,
      );

      const tables = tablesResult.rows
        .filter(
          (row) =>
            !this.getString(row.table_type)?.toUpperCase().includes("VIEW"),
        )
        .map((row) => ({
          name: this.getString(row.table_name) || "",
          schema: this.getString(row.dataset_name) || "",
          database: this.getString(row.project_name) || "",
          type: this.mapTableType(this.getString(row.table_type)),
          created: this.parseDate(row.creation_time) || new Date(),
          metadata: {
            ddl: this.getString(row.ddl),
          },
        }));

      if (tables.length === 0) return tables;

      try {
        const statsResult = await this.query(
          `
          SELECT table_id,
                 row_count,
                 size_bytes
          FROM ${quoteQualifiedIdentifier([database ?? this.defaultProject, schema, "__TABLES__"], "bigquery")}
          WHERE table_id IN (${tables.map(() => "?").join(", ")})
        `,
          tables.map((table) => table.name),
          options,
        );
        const statsByTable = new Map(
          statsResult.rows.map((row) => [this.getString(row.table_id), row]),
        );
        return tables.map((table) => {
          const stats = statsByTable.get(table.name);
          return {
            ...table,
            rowCount: this.parseNumber(stats?.row_count) ?? 0,
            sizeBytes: this.parseNumber(stats?.size_bytes) ?? 0,
          };
        });
      } catch (error) {
        console.warn(
          `Failed to get stats for dataset ${database ?? this.defaultProject}.${schema}:`,
          error,
        );
        return tables;
      }
    } catch (error) {
      console.warn("Failed to fetch BigQuery tables:", error);
      return [];
    }
  }

  async getColumns(
    database?: string,
    schema?: string,
    table?: string,
  ): Promise<Column[]> {
    if (!schema) {
      const schemas = await this.getSchemas(database);
      const columns = await mapWithConcurrency(
        schemas,
        BigQueryIntrospector.MAX_CONCURRENT_QUERIES,
        (item) => this.getColumns(item.database, item.name, table),
      );
      return columns.flat();
    }

    try {
      let whereClause = "";

      const predicates: string[] = [];
      if (database) {
        predicates.push(`table_catalog = ${quoteStringLiteral(database)}`);
      }
      if (schema) {
        predicates.push(`table_schema = ${quoteStringLiteral(schema)}`);
      }
      if (table) {
        predicates.push(`table_name = ${quoteStringLiteral(table)}`);
      }
      if (predicates.length > 0) {
        whereClause = `WHERE ${predicates.join(" AND ")}`;
      }

      const columnsResult = await this.query(`
        SELECT table_catalog as project_name,
               table_schema as dataset_name,
               table_name,
               column_name,
               ordinal_position,
               data_type,
               is_nullable,
               column_default,
               is_generated,
               generation_expression,
               is_stored,
               is_hidden,
               is_updatable,
               is_system_defined,
               is_partitioning_column,
               clustering_ordinal_position
        FROM ${this.informationSchemaView(database, schema, "COLUMNS")}
        ${whereClause}
        ORDER BY table_schema, table_name, ordinal_position
      `);

      return columnsResult.rows.map((row) => ({
        name: this.getString(row.column_name) || "",
        table: this.getString(row.table_name) || "",
        schema: this.getString(row.dataset_name) || "",
        database: this.getString(row.project_name) || "",
        position: this.parseNumber(row.ordinal_position) || 0,
        dataType: this.getString(row.data_type) || "",
        isNullable: this.getString(row.is_nullable) === "YES",
        defaultValue: this.getString(row.column_default) || "",
        metadata: {
          is_generated: this.parseBoolean(row.is_generated),
          generation_expression: this.getString(row.generation_expression),
          is_stored: this.parseBoolean(row.is_stored),
          is_hidden: this.parseBoolean(row.is_hidden),
          is_partitioning_column: this.parseBoolean(row.is_partitioning_column),
          clustering_ordinal_position: this.parseNumber(
            row.clustering_ordinal_position,
          ),
        },
      }));
    } catch (error) {
      console.warn("Failed to fetch BigQuery columns:", error);
      return [];
    }
  }

  async getViews(database?: string, schema?: string): Promise<View[]> {
    if (!schema) {
      const schemas = await this.getSchemas(database);
      const views = await mapWithConcurrency(
        schemas,
        BigQueryIntrospector.MAX_CONCURRENT_QUERIES,
        (item) => this.getViews(item.database, item.name),
      );
      return views.flat();
    }

    try {
      let whereClause = "";

      const predicates: string[] = [];
      if (database) {
        predicates.push(`table_catalog = ${quoteStringLiteral(database)}`);
      }
      if (schema) {
        predicates.push(`table_schema = ${quoteStringLiteral(schema)}`);
      }
      if (predicates.length > 0) {
        whereClause = `WHERE ${predicates.join(" AND ")}`;
      }

      const viewsResult = await this.query(`
        SELECT table_catalog as project_name,
               table_schema as dataset_name,
               table_name as view_name,
               view_definition
        FROM ${this.informationSchemaView(database, schema, "VIEWS")}
        ${whereClause}
        ORDER BY table_schema, table_name
      `);

      return viewsResult.rows.map((row) => ({
        name: this.getString(row.view_name) || "",
        schema: this.getString(row.dataset_name) || "",
        database: this.getString(row.project_name) || "",
        definition: this.getString(row.view_definition) || "",
      }));
    } catch (error) {
      console.warn("Failed to fetch BigQuery views:", error);
      return [];
    }
  }

  async getTableStatistics(
    database: string,
    schema: string,
    table: string,
  ): Promise<TableStatistics> {
    // Get basic table statistics only (no column statistics)
    const tableStatsResult = await this.query(`
      SELECT row_count,
             size_bytes,
             last_modified_time
      FROM ${quoteQualifiedIdentifier([database, schema, "__TABLES__"], "bigquery")}
      WHERE table_id = ${quoteStringLiteral(table)}
    `);

    const basicStats = tableStatsResult.rows[0];

    return {
      table,
      schema,
      database,
      rowCount: this.parseNumber(basicStats?.row_count) ?? 0,
      sizeBytes: this.parseNumber(basicStats?.size_bytes) ?? 0,
      columnStatistics: [], // No column statistics in basic table stats
      lastUpdated: this.parseDate(basicStats?.last_modified_time) || new Date(),
    };
  }

  /**
   * Get column statistics for all columns in a specific table
   */
  async getColumnStatistics(
    database: string,
    schema: string,
    table: string,
  ): Promise<ColumnStatistics[]> {
    // Get columns for this table
    const columns = await this.getColumns(database, schema, table);
    return this.getColumnStatisticsForColumns(database, schema, table, columns);
  }

  /**
   * Get column statistics using optimized CTE approach with single table scan
   */
  private async getColumnStatisticsForColumns(
    database: string,
    schema: string,
    table: string,
    columns: Column[],
  ): Promise<ColumnStatistics[]> {
    const columnStatistics: ColumnStatistics[] = [];

    if (columns.length === 0) return columnStatistics;

    try {
      // Build the optimized CTE-based query
      const statsQuery = this.buildOptimizedColumnStatsQuery(
        database,
        schema,
        table,
        columns,
      );
      const columnLabels = columns.map((column) => column.name);
      const statsResult = await this.query(statsQuery, [
        ...columnLabels,
        ...columnLabels,
      ]);

      // Parse results - each row represents one column's statistics
      for (const row of statsResult.rows) {
        if (row) {
          columnStatistics.push({
            columnName: this.getString(row.column_name) || "",
            distinctCount: this.parseNumber(row.distinct_count) ?? 0,
            nullCount: this.parseNumber(row.null_count) ?? 0,
            minValue: this.getString(row.min_value) ?? "",
            maxValue: this.getString(row.max_value) ?? "",
            sampleValues: this.getString(row.sample_values) ?? "",
          });
        }
      }
    } catch (error) {
      console.warn(`Could not get statistics for table ${table}:`, error);

      // Fallback: create empty statistics for each column
      for (const column of columns) {
        columnStatistics.push({
          columnName: column.name,
          distinctCount: 0,
          nullCount: 0,
          minValue: "",
          maxValue: "",
          sampleValues: "",
        });
      }
    }

    return columnStatistics;
  }

  /**
   * Build optimized CTE-based query that scans the table only once
   */
  private buildOptimizedColumnStatsQuery(
    database: string,
    schema: string,
    table: string,
    columns: Column[],
  ): string {
    const fullyQualifiedTable = quoteQualifiedIdentifier(
      [database, schema, table],
      "bigquery",
    );

    // Build raw_stats CTE with all column statistics in one scan
    const rawStatsSelects = columns
      .map((column, index) => {
        const columnName = column.name;
        const quotedColumn = quoteIdentifier(columnName, "bigquery");
        const isNumeric = this.isNumericType(column.dataType);
        const isDate = this.isDateType(column.dataType);

        let selectClause = `
        COUNT(DISTINCT ${quotedColumn}) AS tf_distinct_${index},
        COUNTIF(${quotedColumn} IS NULL) AS tf_null_${index}`;

        if (isNumeric || isDate) {
          selectClause += `,
        MIN(${quotedColumn}) AS tf_min_${index},
        MAX(${quotedColumn}) AS tf_max_${index}`;
        }

        return selectClause;
      })
      .join(",");

    // Build sample_values CTE with UNION ALL for each column
    const sampleValuesUnions = columns
      .map((column) => {
        const columnName = column.name;
        const quotedColumn = quoteIdentifier(columnName, "bigquery");
        const columnLabel = "?";
        return `
    SELECT ${columnLabel} AS column_name,
           STRING_AGG(
               CASE
                   WHEN LENGTH(sample_val) > 100
                   THEN CONCAT(SUBSTR(sample_val, 1, 100), '...')
                   ELSE sample_val
               END,
               ','
               ORDER BY sample_val
           ) AS sample_values
    FROM (
        SELECT DISTINCT CAST(${quotedColumn} AS STRING) AS sample_val
        FROM sample_data
        WHERE ${quotedColumn} IS NOT NULL
        LIMIT 20
    )`;
      })
      .join("\n    UNION ALL");

    // Build stats CTE with UNION ALL for each column
    const statsUnions = columns
      .map((column, index) => {
        const columnName = column.name;
        const columnLabel = "?";
        const isNumeric = this.isNumericType(column.dataType);
        const isDate = this.isDateType(column.dataType);

        let minMaxClause = "NULL AS min_value,\n        NULL AS max_value";
        if (isNumeric || isDate) {
          minMaxClause = `CAST(rs.tf_min_${index} AS STRING) AS min_value,
        CAST(rs.tf_max_${index} AS STRING) AS max_value`;
        }

        return `
    SELECT
        ${columnLabel} AS column_name,
        rs.tf_distinct_${index} AS distinct_count,
        rs.tf_null_${index} AS null_count,
        ${minMaxClause}
    FROM raw_stats rs`;
      })
      .join("\n    UNION ALL");

    // Combine all CTEs into final query
    return `
WITH raw_stats AS (
    SELECT
        ${rawStatsSelects}
    FROM ${fullyQualifiedTable}
),
sample_data AS (
    SELECT * FROM ${fullyQualifiedTable} TABLESAMPLE SYSTEM (1 PERCENT)
),
sample_values AS (
    ${sampleValuesUnions}
),
stats AS (
    ${statsUnions}
)
SELECT
    s.column_name,
    s.distinct_count,
    s.null_count,
    s.min_value,
    s.max_value,
    sv.sample_values
FROM stats s
LEFT JOIN sample_values sv ON s.column_name = sv.column_name
ORDER BY s.column_name`;
  }

  private informationSchemaView(
    database: string | undefined,
    schema: string,
    view: "TABLES" | "COLUMNS" | "VIEWS",
  ): string {
    return quoteQualifiedIdentifier(
      [database ?? this.defaultProject, schema, "INFORMATION_SCHEMA", view],
      "bigquery",
    );
  }

  private regionInformationSchemaView(
    database: string,
    view: "SCHEMATA",
  ): string {
    const region = this.location.toLowerCase().replace(/^region-/, "");
    return quoteQualifiedIdentifier(
      [database, `region-${region}`, "INFORMATION_SCHEMA", view],
      "bigquery",
    );
  }

  private createProjectDatabase(project: string): Database {
    return {
      name: project,
      created: new Date(),
      metadata: {
        project_name: project,
        location: this.location,
      },
    };
  }

  private query(
    sql: string,
    params?: QueryParameter[],
    options?: IntrospectionQueryOptions,
  ): Promise<AdapterQueryResult> {
    return this.queryLimiter.run(() =>
      this.adapter.query(sql, params, options?.limit, options?.timeout),
    );
  }

  /**
   * Map BigQuery table types to our standard types
   */
  private mapTableType(
    bigQueryType: string | undefined,
  ):
    | "TABLE"
    | "VIEW"
    | "MATERIALIZED_VIEW"
    | "EXTERNAL_TABLE"
    | "TEMPORARY_TABLE" {
    if (!bigQueryType) return "TABLE";

    const type = bigQueryType.toUpperCase();
    if (type.includes("VIEW")) return "VIEW";
    if (type.includes("EXTERNAL")) return "EXTERNAL_TABLE";
    if (type.includes("BASE TABLE")) return "TABLE";
    return "TABLE";
  }

  /**
   * Check if a data type is numeric for statistics purposes
   */
  private isNumericType(dataType: string): boolean {
    const numericTypes = [
      "int64",
      "integer",
      "float64",
      "float",
      "numeric",
      "decimal",
      "bignumeric",
      "bigdecimal",
    ];

    return numericTypes.some((type) => dataType.toLowerCase().includes(type));
  }

  /**
   * Check if a data type is date for statistics purposes
   */
  private isDateType(dataType: string): boolean {
    const dateTypes = ["date", "datetime", "timestamp", "time"];

    return dateTypes.some((type) => dataType.toLowerCase().includes(type));
  }

  /**
   * BigQuery-optimized full introspection that takes advantage of caching
   * Fetches data sequentially: databases → schemas → tables → columns → views
   * Each step benefits from the cache populated by previous steps
   */
  override async getFullIntrospection(options?: {
    databases?: string[];
    schemas?: string[];
    tables?: string[];
  }): Promise<DataSourceIntrospectionResult> {
    // Validate that filter arrays are not empty
    if (options?.databases && options.databases.length === 0) {
      throw new Error(
        "Database filter array is empty. Please provide at least one database name or remove the filter.",
      );
    }
    if (options?.schemas && options.schemas.length === 0) {
      throw new Error(
        "Schema filter array is empty. Please provide at least one schema name or remove the filter.",
      );
    }
    if (options?.tables && options.tables.length === 0) {
      throw new Error(
        "Table filter array is empty. Please provide at least one table name or remove the filter.",
      );
    }

    // BigQuery cannot enumerate every project visible to a service account. An
    // explicit database filter therefore defines the projects to inspect;
    // otherwise introspection remains scoped to the configured default project.
    const databases = options?.databases
      ? Array.from(new Set(options.databases), (project) =>
          this.createProjectDatabase(project),
        )
      : await this.getDatabases();

    const schemaGroups = await mapWithConcurrency(
      databases,
      BigQueryIntrospector.MAX_CONCURRENT_QUERIES,
      (database) => this.getSchemas(database.name),
    );
    let schemas = schemaGroups.flat();
    if (options?.schemas) {
      schemas = schemas.filter(
        (schema) => options.schemas?.includes(schema.name) ?? false,
      );
    }

    const tableGroups = await mapWithConcurrency(
      schemas,
      BigQueryIntrospector.MAX_CONCURRENT_QUERIES,
      (schema) => this.getTables(schema.database, schema.name),
    );
    let tables = tableGroups.flat();
    if (options?.tables) {
      tables = tables.filter(
        (table) => options.tables?.includes(table.name) ?? false,
      );
    }

    const columnGroups = await mapWithConcurrency(
      schemas,
      BigQueryIntrospector.MAX_CONCURRENT_QUERIES,
      (schema) => this.getColumns(schema.database, schema.name),
    );
    const columns = columnGroups
      .flat()
      .filter((column) =>
        tables.some(
          (table) =>
            table.name === column.table &&
            table.schema === column.schema &&
            table.database === column.database,
        ),
      );

    const viewGroups = await mapWithConcurrency(
      schemas,
      BigQueryIntrospector.MAX_CONCURRENT_QUERIES,
      (schema) => this.getViews(schema.database, schema.name),
    );
    const views = viewGroups.flat();

    // Get column statistics in batches of 20 tables
    const columnsWithStats = await this.attachColumnStatisticsBigQuery(
      tables,
      columns,
    );

    // Filter databases to only those that have schemas when schema filter is applied
    let filteredDatabases = databases;
    if (options?.schemas && !options?.databases) {
      const databasesWithFilteredSchemas = new Set(
        schemas.map((schema) => schema.database),
      );
      filteredDatabases = databases.filter((db) =>
        databasesWithFilteredSchemas.has(db.name),
      );
    }

    return {
      dataSourceName: this.dataSourceName,
      dataSourceType: this.getDataSourceType(),
      databases: filteredDatabases,
      schemas,
      tables,
      columns: columnsWithStats,
      views,
      indexes: [], // BigQuery doesn't expose index information
      foreignKeys: [], // BigQuery doesn't expose foreign key information
      introspectedAt: new Date(),
    };
  }

  /**
   * Attach column statistics to columns by processing tables in batches
   */
  private async attachColumnStatisticsBigQuery(
    tables: Table[],
    columns: Column[],
  ): Promise<Column[]> {
    const columnMap = new Map<string, Column>();
    const columnsByTable = new Map<string, Column[]>();
    for (const column of columns) {
      const key = `${column.database}.${column.schema}.${column.table}.${column.name}`;
      columnMap.set(key, { ...column });
      const tableKey = `${column.database}.${column.schema}.${column.table}`;
      const tableColumns = columnsByTable.get(tableKey) ?? [];
      tableColumns.push(column);
      columnsByTable.set(tableKey, tableColumns);
    }

    await mapWithConcurrency(
      tables,
      BigQueryIntrospector.MAX_CONCURRENT_QUERIES,
      async (table) => {
        try {
          const tableKey = `${table.database}.${table.schema}.${table.name}`;
          const tableColumns = columnsByTable.get(tableKey) ?? [];
          if (tableColumns.length === 0) return;

          const columnStats = await this.getColumnStatisticsForColumns(
            table.database,
            table.schema,
            table.name,
            tableColumns,
          );

          for (const stat of columnStats) {
            const key = `${table.database}.${table.schema}.${table.name}.${stat.columnName}`;
            const column = columnMap.get(key);
            if (column) {
              column.distinctCount = stat.distinctCount ?? 0;
              column.nullCount = stat.nullCount ?? 0;
              column.minValue = stat.minValue ?? "";
              column.maxValue = stat.maxValue ?? "";
              column.sampleValues = stat.sampleValues ?? "";
            }
          }
        } catch (error) {
          console.warn(
            `Failed to get column statistics for table ${table.database}.${table.schema}.${table.name}:`,
            error,
          );
        }
      },
    );

    return Array.from(columnMap.values());
  }
}
