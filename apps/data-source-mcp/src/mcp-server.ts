import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ConnectionRegistry } from "./connection-registry.js";
import { toolFailure, toolSuccess } from "./json.js";

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

export function createDataSourceMcpServer(
  registry: ConnectionRegistry,
): McpServer {
  const server = new McpServer({
    name: "forty-two-data-source",
    version: "0.1.0",
  });

  server.registerTool(
    "list_data_sources",
    {
      title: "List data sources",
      description:
        "List the configured data sources available to this agent. Credentials are never returned.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => toolSuccess({ dataSources: registry.list() }),
  );

  server.registerTool(
    "test_data_source",
    {
      title: "Test data source",
      description:
        "Verify that a configured data source can be reached with its server-side credentials.",
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
      description:
        "List databases or catalogs visible through a configured data source.",
      inputSchema: z.object({ dataSource: connectionName, limit: listLimit }),
      annotations: readOnlyAnnotations,
    },
    async ({ dataSource, limit }) => {
      try {
        registry.get(dataSource);
        const values = await registry.dataSource.getDatabases(dataSource);
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
      description:
        "List schemas visible in a configured data source, optionally within a database/catalog.",
      inputSchema: z.object({
        dataSource: connectionName,
        database: optionalIdentifier,
        limit: listLimit,
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ dataSource, database, limit }) => {
      try {
        registry.get(dataSource);
        const values = await registry.dataSource.getSchemas(
          dataSource,
          database,
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
      description:
        "List tables visible in a configured data source, optionally scoped by database and schema.",
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
        registry.get(dataSource);
        const values = await registry.dataSource.getTables(
          dataSource,
          database,
          schema,
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
      description:
        "Return column metadata for one table. Inspect the schema before generating SQL.",
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
      description:
        "Execute one bounded read-only SQL query. Writes, DDL, SELECT INTO, and locking reads are rejected.",
      inputSchema: z.object({
        dataSource: connectionName,
        sql: z.string().trim().min(1).max(100_000),
        maxRows: z.number().int().min(1).max(5_000).optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ dataSource, sql, maxRows, timeoutMs }) => {
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
        return toolSuccess(result);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}
