import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ActiveChatSessionScope,
  ActiveSessionDataSource,
} from "@forty-two/db";
import { ChatSessionIdSchema, DataSourceIdSchema } from "@forty-two/db";
import { z } from "zod";

import type { ConnectionRegistry } from "./connection-registry.js";
import { toolFailure, toolSuccess } from "./json.js";
import type { QueryExecutionLedger } from "./query-execution-ledger.js";
import type { FileDownloadDescriptor } from "./file-download.js";
import {
  BeginTableArtifactUploadInputSchema,
  FinalizeChartArtifactInputSchema,
  FinalizeTableArtifactInputSchema,
  type ArtifactStore,
} from "./artifact-store.js";
import {
  ApplySqlChangeInputSchema,
  PrepareSqlChangeToolInputSchema,
  SqlChangeService,
} from "./sql-change-service.js";

const sessionIdSchema = ChatSessionIdSchema.describe(
  "Public Forty Two application session ID",
);
const dataSourceIdSchema = DataSourceIdSchema.describe(
  "Datasource ID from this session's immutable bindings",
);
const optionalIdentifier = z.string().trim().min(1).optional();
const listLimit = z.number().int().min(1).max(500).default(200);

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const platformWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const destructiveWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
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
  createQueryTableArtifact: `Execute one bounded read query and durably create a table.v1 artifact from its result. This tool writes an Azure blob and PostgreSQL metadata, so use it only when a durable table or chart source is needed. requestId is the operation identity: retry the same request with the same id, and use a new UUID for a distinct requested artifact. Full rows are stored server-side and only a bounded receipt is returned.`,
  getFileDownloadUrl: `Create a five-minute, read-only Azure Blob download descriptor for one file datasource bound to this application session.

WHEN TO USE:
- From Daytona Code Mode, immediately before materializing a bound CSV or XLSX file into the sandbox.
- Use the exact datasource id supplied in session context.

RULES:
- Download the URL directly from Daytona; never route file bytes through the model, TrueForge messages, or the Forty Two web server.
- Send the returned If-Match request header, verify the response ETag equals expectedETag, and verify the downloaded byte length equals sizeBytes before analysis.
- The URL is read-only, blob-scoped, and expires after five minutes. Request a new descriptor if it expires.

RETURNS: URL, expiry, exact expected ETag, filename, MIME type, byte size, and mandatory request headers.`,
  beginTableArtifactUpload: `Return a 60-second, create-only Azure upload descriptor for a canonical table.v1 payload. This is intended for the snapshot-installed forty_two_artifacts Daytona helper, but the current TrueForge connector cannot enforce caller origin: a direct model call exposes the descriptor in a model-visible tool response. Full rows must be uploaded directly to Azure and must never be included in this MCP request. The call is stateless and writes no database row.`,
  getTableArtifactDownloadUrl: `Return a 60-second, read-only, exact-ETag-bound Azure descriptor for one committed same-session table artifact. This is intended for the snapshot-installed forty_two_artifacts Daytona helper, but the current TrueForge connector cannot enforce caller origin: a direct model call exposes the descriptor in a model-visible tool response. Limited database artifacts are marked explicitly and must not drive joins, totals, averages, or completeness claims.`,
  finalizeTableArtifact: `Verify an uploaded canonical table artifact and commit immutable same-session metadata and lineage. The server independently streams Azure bytes and validates SHA-256, ETag, schema, rows, columns, cells, and size. Pass only the bounded receipt from emit_table; never pass rows.`,
  finalizeChartArtifact: `Authoritatively finalize an immutable chart.v1 artifact from the bounded receipt returned by the snapshot-installed Python visualize helper. The server reloads the exact committed source table and revalidates its hash, row count, canonical chart config, and receipt hash. Never pass rows.`,
  prepareSqlChange: `Prepare one immutable approval-gated database change without modifying the datasource. Row changes require exactly one simple dialect-valid INSERT, UPDATE, or DELETE. Column changes use only the structured add_column, rename_column, or add_and_backfill_column fields; never provide ALTER SQL. The result includes the exact approval object that must be copied unchanged into apply_sql_change. TrueForge and the Forty Two backend correlate the actual turn and tool-call evidence; never invent audit identifiers.`,
  applySqlChange: `Apply exactly one previously prepared immutable database change. This tool is destructive and always requires TrueForge approval. Copy every approval-display field exactly from prepare_sql_change; fresh SQL is never accepted. Never call this from Code Mode or a shell client.`,
} as const;

export type SharedMcpOptions = {
  authorizeSession(input: {
    chatSessionId: string;
  }): Promise<ActiveChatSessionScope | null>;
  createFileDownloadDescriptor?: (
    source: ScopedFileDataSource,
  ) => FileDownloadDescriptor;
  artifactStore?: ArtifactStore;
};

export type ScopedFileDataSource = ActiveSessionDataSource & {
  connectorType: "csv" | "xlsx";
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  azureBlobName: string;
  azureETag: string;
};

export function createDataSourceMcpServer(
  registry: ConnectionRegistry,
  queryLedger: QueryExecutionLedger,
  options: SharedMcpOptions,
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
      inputSchema: z.object({ sessionId: sessionIdSchema }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId }) => {
      const scope = await requireActiveScope(options, sessionId);
      const listed = await registry.list();
      const databasesById = new Map(
        listed.map((source) => [source.name, source] as const),
      );
      return toolSuccess({
        dataSources: scope.dataSources.map(
          (source) =>
            databasesById.get(source.id) ?? {
              name: source.id,
              type: source.connectorType,
              description: source.name,
            },
        ),
      });
    },
  );

  {
    server.registerTool(
      "prepare_sql_change",
      {
        title: "Prepare controlled SQL change",
        description: toolDescriptions.prepareSqlChange,
        inputSchema: PrepareSqlChangeToolInputSchema,
        annotations: readOnlyAnnotations,
      },
      async (request) => {
        try {
          const scope = await requireActiveScope(options, request.sessionId);
          const sqlChanges = new SqlChangeService(registry, scope);
          return toolSuccess(await sqlChanges.prepare(request));
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "apply_sql_change",
      {
        title: "Apply approved SQL change",
        description: toolDescriptions.applySqlChange,
        inputSchema: ApplySqlChangeInputSchema,
        annotations: destructiveWriteAnnotations,
      },
      async (request) => {
        try {
          const scope = await requireActiveScope(options, request.sessionId);
          const sqlChanges = new SqlChangeService(registry, scope);
          return toolSuccess(await sqlChanges.apply(request));
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "get_file_download_url",
      {
        title: "Get scoped file download URL",
        description: toolDescriptions.getFileDownloadUrl,
        inputSchema: z
          .object({
            sessionId: sessionIdSchema,
            dataSourceId: dataSourceIdSchema,
          })
          .strict(),
        annotations: readOnlyAnnotations,
      },
      async ({ sessionId, dataSourceId }) => {
        try {
          const scope = await requireActiveScope(options, sessionId);
          const source = requireScopedFile(scope, dataSourceId);
          if (!options.createFileDownloadDescriptor) {
            throw new Error("File downloads are not configured.");
          }
          return toolSuccess(options.createFileDownloadDescriptor(source));
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    if (options.artifactStore) {
      server.registerTool(
        "begin_table_artifact_upload",
        {
          title: "Begin table artifact upload",
          description: toolDescriptions.beginTableArtifactUpload,
          inputSchema: BeginTableArtifactUploadInputSchema.extend({
            sessionId: sessionIdSchema,
          }).strict(),
          annotations: readOnlyAnnotations,
        },
        async (request) => {
          try {
            const { sessionId, ...artifactRequest } = request;
            return toolSuccess(
              await options.artifactStore!.beginTableUpload({
                chatSessionId: (await requireActiveScope(options, sessionId))
                  .chatSessionId,
                request: artifactRequest,
              }),
            );
          } catch (error) {
            return toolFailure(error);
          }
        },
      );

      server.registerTool(
        "get_table_artifact_download_url",
        {
          title: "Get table artifact download URL",
          description: toolDescriptions.getTableArtifactDownloadUrl,
          inputSchema: z
            .object({ sessionId: sessionIdSchema, artifactId: z.string() })
            .strict(),
          annotations: readOnlyAnnotations,
        },
        async ({ sessionId, artifactId }) => {
          try {
            const scope = await requireActiveScope(options, sessionId);
            return toolSuccess(
              await options.artifactStore!.getTableDownloadDescriptor({
                chatSessionId: scope.chatSessionId,
                artifactId,
              }),
            );
          } catch (error) {
            return toolFailure(error);
          }
        },
      );

      server.registerTool(
        "finalize_table_artifact",
        {
          title: "Finalize table artifact",
          description: toolDescriptions.finalizeTableArtifact,
          inputSchema: FinalizeTableArtifactInputSchema.extend({
            sessionId: sessionIdSchema,
          }).strict(),
          annotations: platformWriteAnnotations,
        },
        async (request) => {
          try {
            const { sessionId, ...artifactRequest } = request;
            return toolSuccess(
              await options.artifactStore!.finalizeTable({
                chatSessionId: (await requireActiveScope(options, sessionId))
                  .chatSessionId,
                request: artifactRequest,
              }),
            );
          } catch (error) {
            return toolFailure(error);
          }
        },
      );

      server.registerTool(
        "finalize_chart_artifact",
        {
          title: "Finalize chart artifact",
          description: toolDescriptions.finalizeChartArtifact,
          inputSchema: FinalizeChartArtifactInputSchema.extend({
            sessionId: sessionIdSchema,
          }).strict(),
          annotations: platformWriteAnnotations,
        },
        async (request) => {
          try {
            const { sessionId, ...artifactRequest } = request;
            return toolSuccess(
              await options.artifactStore!.finalizeChartArtifact({
                chatSessionId: (await requireActiveScope(options, sessionId))
                  .chatSessionId,
                request: artifactRequest,
              }),
            );
          } catch (error) {
            return toolFailure(error);
          }
        },
      );
    }
  }

  server.registerTool(
    "test_data_source",
    {
      title: "Test data source",
      description: toolDescriptions.testDataSource,
      inputSchema: z
        .object({
          sessionId: sessionIdSchema,
          dataSourceId: dataSourceIdSchema,
        })
        .strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId, dataSourceId }) => {
      try {
        const scope = await requireActiveScope(options, sessionId);
        requireScopedDatabase(scope, dataSourceId);
        await registry.get(dataSourceId);
        return toolSuccess({
          dataSourceId,
          connected: await registry.dataSource.testDataSource(dataSourceId),
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
      inputSchema: scopedDataSourceInput({ limit: listLimit }),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId, dataSourceId, limit }) => {
      try {
        const scope = await requireActiveScope(options, sessionId);
        requireScopedDatabase(scope, dataSourceId);
        const connection = await registry.get(dataSourceId);
        const values = await registry.dataSource.getDatabases(dataSourceId, {
          limit: limit + 1,
          timeout: connection.policy.queryTimeoutMs,
        });
        return toolSuccess({
          dataSourceId,
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
      inputSchema: scopedDataSourceInput({
        database: optionalIdentifier,
        limit: listLimit,
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId, dataSourceId, database, limit }) => {
      try {
        const scope = await requireActiveScope(options, sessionId);
        requireScopedDatabase(scope, dataSourceId);
        const connection = await registry.get(dataSourceId);
        const values = await registry.dataSource.getSchemas(
          dataSourceId,
          database,
          {
            limit: limit + 1,
            timeout: connection.policy.queryTimeoutMs,
          },
        );
        return toolSuccess({
          dataSourceId,
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
      inputSchema: scopedDataSourceInput({
        database: optionalIdentifier,
        schema: optionalIdentifier,
        limit: listLimit,
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId, dataSourceId, database, schema, limit }) => {
      try {
        const scope = await requireActiveScope(options, sessionId);
        requireScopedDatabase(scope, dataSourceId);
        const connection = await registry.get(dataSourceId);
        const values = await registry.dataSource.getTables(
          dataSourceId,
          database,
          schema,
          {
            limit: limit + 1,
            timeout: connection.policy.queryTimeoutMs,
          },
        );
        return toolSuccess({
          dataSourceId,
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
      inputSchema: scopedDataSourceInput({
        database: optionalIdentifier,
        schema: optionalIdentifier,
        table: z.string().trim().min(1),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId, dataSourceId, database, schema, table }) => {
      try {
        const scope = await requireActiveScope(options, sessionId);
        requireScopedDatabase(scope, dataSourceId);
        await registry.get(dataSourceId);
        const columns = await registry.dataSource.getColumns(
          dataSourceId,
          database,
          schema,
          table,
        );
        return toolSuccess({ dataSourceId, database, schema, table, columns });
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
      inputSchema: scopedDataSourceInput({
        sql: z.string().trim().min(1).max(100_000),
        maxRows: z.number().int().min(1).max(5_000).optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
        requestId: z.string().uuid().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId, dataSourceId, sql, maxRows, timeoutMs, requestId }) => {
      try {
        const scope = await requireActiveScope(options, sessionId);
        requireScopedDatabase(scope, dataSourceId);
        const connection = await registry.get(dataSourceId);
        const effectiveMaxRows = Math.min(
          maxRows ?? connection.policy.maxRows,
          connection.policy.maxRows,
        );
        const result = await registry.dataSource.execute({
          dataSource: dataSourceId,
          sql,
          options: {
            maxRows: effectiveMaxRows,
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
            dataSourceId,
            sql,
            result.rows as Record<string, unknown>[],
          );
        }
        return toolSuccess(result);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  if (options.artifactStore) {
    server.registerTool(
      "create_query_table_artifact",
      {
        title: "Create query table artifact",
        description: toolDescriptions.createQueryTableArtifact,
        inputSchema: z
          .object({
            sessionId: sessionIdSchema,
            dataSourceId: dataSourceIdSchema,
            sql: z.string().trim().min(1).max(100_000),
            requestId: z.string().uuid(),
            maxRows: z.number().int().min(1).max(5_000).optional(),
            timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
          })
          .strict(),
        annotations: platformWriteAnnotations,
      },
      async ({
        sessionId,
        dataSourceId,
        sql,
        requestId,
        maxRows,
        timeoutMs,
      }) => {
        try {
          const scope = await requireActiveScope(options, sessionId);
          requireScopedDatabase(scope, dataSourceId);
          const connection = await registry.get(dataSourceId);
          const effectiveMaxRows = Math.min(
            maxRows ?? connection.policy.maxRows,
            connection.policy.maxRows,
          );
          const startedAt = new Date();
          const result = await registry.dataSource.execute({
            dataSource: dataSourceId,
            sql,
            options: {
              maxRows: effectiveMaxRows,
              timeout: Math.min(
                timeoutMs ?? connection.policy.queryTimeoutMs,
                connection.policy.queryTimeoutMs,
              ),
            },
          });
          if (!result.success) {
            return toolFailure(
              new Error(result.error?.message ?? "Query failed"),
            );
          }
          if (result.rows.length === 0) {
            return toolSuccess({
              artifact: null,
              storedRowCount: 0,
              sourceLimited: result.metadata?.limited === true,
              warning:
                "The query returned no rows, so no table artifact was created.",
            });
          }
          const artifact = await options.artifactStore!.persistQueryResult({
            chatSessionId: scope.chatSessionId,
            dataSourceId,
            sql,
            requestId,
            maxRows: effectiveMaxRows,
            columns: result.columns,
            rows: result.rows as Record<string, unknown>[],
            sourceLimited: result.metadata?.limited === true,
            ...(typeof result.metadata?.totalRowCount === "number"
              ? { sourceTotalRowCount: result.metadata.totalRowCount }
              : {}),
            startedAt,
          });
          return toolSuccess({
            artifact,
            storedRowCount: artifact?.rowCount ?? 0,
            sourceLimited: artifact?.sourceLimited ?? false,
            sourceMaxRows: artifact?.sourceMaxRows ?? null,
          });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  }

  return server;
}

const FILE_CONNECTORS = new Set(["csv", "xlsx"]);

function scopedDataSourceInput<T extends z.ZodRawShape>(extra?: T) {
  return z
    .object({
      sessionId: sessionIdSchema,
      dataSourceId: dataSourceIdSchema,
      ...(extra ?? ({} as T)),
    })
    .strict();
}

async function requireActiveScope(
  options: SharedMcpOptions,
  sessionId: string,
): Promise<ActiveChatSessionScope> {
  const scope = await options.authorizeSession({ chatSessionId: sessionId });
  if (!scope) throw new Error(`Session '${sessionId}' is not active`);
  return scope;
}

function scopedIds(scope: ActiveChatSessionScope): Set<string> {
  return new Set(scope.dataSources.map((source) => source.id));
}

function requireScopedDatabase(
  scope: ActiveChatSessionScope,
  dataSourceId: string,
): void {
  const source = scope.dataSources.find(
    (candidate) => candidate.id === dataSourceId,
  );
  if (!source || FILE_CONNECTORS.has(source.connectorType)) {
    throw new Error(`Data source '${dataSourceId}' is not available`);
  }
}

function requireScopedFile(
  scope: ActiveChatSessionScope,
  dataSourceId: string,
): ScopedFileDataSource {
  const source = scope.dataSources.find(
    (candidate) => candidate.id === dataSourceId,
  );
  if (
    !source ||
    !FILE_CONNECTORS.has(source.connectorType) ||
    !source.originalFilename ||
    !source.mimeType ||
    source.fileSizeBytes === null ||
    !source.azureBlobName ||
    !source.azureETag
  ) {
    throw new Error(`Data source '${dataSourceId}' is not available`);
  }
  return source as ScopedFileDataSource;
}
