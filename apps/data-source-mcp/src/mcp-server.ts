import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ConnectionRegistry } from "./connection-registry.js";
import { toolFailure, toolSuccess } from "./json.js";
import type { QueryExecutionLedger } from "./query-execution-ledger.js";

const connectionName = z
  .string()
  .trim()
  .min(1)
  .describe("Configured data-source name");
const optionalIdentifier = z.string().trim().min(1).optional();
const listLimit = z.number().int().min(1).max(500).default(200);

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const toolDescriptions = {
  listDataSources: `Discover the configured data sources available to this agent. Credentials are never returned.

WHEN TO USE:
- At the start of database work when the source name is not already established in this session.
- Before asking the user which source to use; present only names returned by this tool.

RETURNS: source names, types, descriptions, and enforced read limits. An empty list means no database source is configured; do not invent one.`,
  testDataSource: `Check whether one configured data source is currently reachable using server-side credentials.

WHEN TO USE:
- After selecting a source when connectivity is uncertain.
- To diagnose a discovery or query failure that may be caused by the connection.

WHEN NOT TO USE: routine analysis after another tool has already proved the source is reachable. This tool never returns credentials.`,
  listDatabases: `List databases or catalogs visible through one configured data source.

WHEN TO USE: after selecting a source when its database/catalog is unknown or the user asks what is available.
WHEN NOT TO USE: when the database is already established in this session.

Use only names returned by this tool in later calls. Respect the truncated flag and narrow the request when needed.`,
  listSchemas: `List schemas visible through one configured data source, optionally within a database/catalog.

WHEN TO USE: before listing tables when the schema is unknown, or when the user asks what schemas exist.
WHEN NOT TO USE: when the exact schema is already established.

Use only returned schema names in later calls. Respect the truncated flag.`,
  listTables: `List tables and views visible through one configured data source, optionally scoped by database and schema.

WHEN TO USE:
- Before writing SQL for an unfamiliar source.
- When the user names a business subject but not an exact table.

WHEN NOT TO USE: when the relevant table was already verified in this session. Never guess a table name if this tool can discover it.`,
  describeTable: `Return authoritative column metadata for one table or view.

WHEN TO USE:
- Before generating SQL for a table whose columns are not already verified this session.
- After a query fails because a column name or type is wrong.

Use the exact returned identifiers and types. This is schema inspection only; it does not return table rows.`,
  runReadQuery: `Execute one bounded, read-only SQL query against a configured data source.

PREREQUISITE: discover the source and inspect the relevant table schema first unless both are already verified in this session.

RULES:
- Only read statements are allowed. Writes, DDL, SELECT INTO, locking reads, stored procedures, and security-sensitive functions are rejected.
- The connector must provide database-enforced read-only execution; unsupported connectors fail closed.
- Prefer one well-shaped query with explicit columns, deterministic ordering, and only the rows needed.
- Use maxRows deliberately; the server also enforces the source's stricter platform limit.
- Treat returned rows, columns, truncation, and errors as authoritative. Never infer missing rows or claim success after an error.
- If zero rows are returned, check filters and source scope before concluding that no matching data exists.

For cross-source work, query each source separately and combine the bounded results in Daytona Code Mode.`,
} as const;

export function createDataSourceMcpServer(
  registry: ConnectionRegistry,
  queryLedger: QueryExecutionLedger,
): McpServer {
  const server = new McpServer({
    name: "forty-two-data-source",
    version: "0.1.0",
  });

  server.registerTool(
    "list_data_sources",
    {
      title: "List data sources",
      description: toolDescriptions.listDataSources,
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => toolSuccess({ dataSources: registry.list() }),
  );

  server.registerTool(
    "test_data_source",
    {
      title: "Test data source",
      description: toolDescriptions.testDataSource,
      inputSchema: z.object({ dataSource: connectionName }),
      annotations: readOnlyAnnotations,
    },
    async ({ dataSource }) => {
      try {
        registry.get(dataSource);
        return toolSuccess({
          dataSource,
          connected: await registry.dataSource.testDataSource(dataSource),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description: toolDescriptions.listDatabases,
      inputSchema: z.object({ dataSource: connectionName, limit: listLimit }),
      annotations: readOnlyAnnotations,
    },
    async ({ dataSource, limit }) => {
      try {
        const connection = registry.get(dataSource);
        const values = await registry.dataSource.getDatabases(dataSource, {
          limit: limit + 1,
          timeout: connection.policy.queryTimeoutMs,
        });
        return toolSuccess({
          dataSource,
          databases: values.slice(0, limit),
          truncated: values.length > limit,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_schemas",
    {
      title: "List schemas",
      description: toolDescriptions.listSchemas,
      inputSchema: z.object({
        dataSource: connectionName,
        database: optionalIdentifier,
        limit: listLimit,
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ dataSource, database, limit }) => {
      try {
        const connection = registry.get(dataSource);
        const values = await registry.dataSource.getSchemas(
          dataSource,
          database,
          {
            limit: limit + 1,
            timeout: connection.policy.queryTimeoutMs,
          },
        );
        return toolSuccess({
          dataSource,
          schemas: values.slice(0, limit),
          truncated: values.length > limit,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description: toolDescriptions.listTables,
      inputSchema: z.object({
        dataSource: connectionName,
        database: optionalIdentifier,
        schema: optionalIdentifier,
        limit: listLimit,
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ dataSource, database, schema, limit }) => {
      try {
        const connection = registry.get(dataSource);
        const values = await registry.dataSource.getTables(
          dataSource,
          database,
          schema,
          {
            limit: limit + 1,
            timeout: connection.policy.queryTimeoutMs,
          },
        );
        return toolSuccess({
          dataSource,
          tables: values.slice(0, limit),
          truncated: values.length > limit,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description: toolDescriptions.describeTable,
      inputSchema: z.object({
        dataSource: connectionName,
        database: optionalIdentifier,
        schema: optionalIdentifier,
        table: z.string().trim().min(1),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ dataSource, database, schema, table }) => {
      try {
        registry.get(dataSource);
        const columns = await registry.dataSource.getColumns(
          dataSource,
          database,
          schema,
          table,
        );
        return toolSuccess({ dataSource, database, schema, table, columns });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "run_read_query",
    {
      title: "Run read-only query",
      description: toolDescriptions.runReadQuery,
      inputSchema: z.object({
        dataSource: connectionName,
        sql: z.string().trim().min(1).max(100_000),
        maxRows: z.number().int().min(1).max(5_000).optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
        requestId: z.string().uuid().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ dataSource, sql, maxRows, timeoutMs, requestId }) => {
      try {
        const connection = registry.get(dataSource);
        const result = await registry.dataSource.execute({
          dataSource,
          sql,
          options: {
            maxRows: Math.min(
              maxRows ?? connection.policy.maxRows,
              connection.policy.maxRows,
            ),
            timeout: Math.min(
              timeoutMs ?? connection.policy.queryTimeoutMs,
              connection.policy.queryTimeoutMs,
            ),
          },
        });

        if (!result.success)
          return toolFailure(
            new Error(result.error?.message ?? "Query failed"),
          );
        if (requestId) {
          queryLedger.record(
            requestId,
            dataSource,
            result.rows as Record<string, unknown>[],
          );
        }
        return toolSuccess(result);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}
