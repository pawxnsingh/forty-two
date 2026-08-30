import { timingSafeEqual } from "node:crypto";

import {
  getActiveChatSessionScope,
  type ActiveChatSessionScope,
} from "@forty-two/db";

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { ServerConfig } from "./config.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { createDataSourceMcpServer } from "./mcp-server.js";
import { QueryExecutionLedger } from "./query-execution-ledger.js";
import { createFileDownloadDescriptor } from "./file-download.js";
import { ArtifactStore } from "./artifact-store.js";

interface ClosableSession {
  close(): Promise<void>;
}

export interface HttpAppDependencies {
  authorizeSession(input: {
    chatSessionId: string;
  }): Promise<ActiveChatSessionScope | null>;
  artifactStore?: ArtifactStore;
}

const defaultDependencies: HttpAppDependencies = {
  authorizeSession: getActiveChatSessionScope,
};

export class HttpRequestLifecycle {
  private readonly sessions = new Set<ClosableSession>();
  private readonly closingSessions = new Map<ClosableSession, Promise<void>>();
  private readonly activeRequests = new Set<Promise<void>>();
  private draining = false;

  get isDraining(): boolean {
    return this.draining;
  }

  add(session: ClosableSession): void {
    this.sessions.add(session);
  }

  close(session: ClosableSession): Promise<void> {
    const existing = this.closingSessions.get(session);
    if (existing) return existing;

    const closing = Promise.resolve()
      .then(() => session.close())
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.sessions.delete(session);
        this.closingSessions.delete(session);
      });
    this.closingSessions.set(session, closing);
    return closing;
  }

  async track<T>(operation: () => Promise<T>): Promise<T> {
    const request = operation();
    const completion = request.then(
      () => undefined,
      () => undefined,
    );
    this.activeRequests.add(completion);

    try {
      return await request;
    } finally {
      this.activeRequests.delete(completion);
    }
  }

  async beginShutdown(): Promise<void> {
    this.draining = true;
    while (this.activeRequests.size > 0) {
      await Promise.allSettled([...this.activeRequests]);
    }
    while (this.sessions.size > 0) {
      await Promise.allSettled(
        [...this.sessions].map((session) => this.close(session)),
      );
    }
  }
}

export function createHttpApp(
  config: ServerConfig,
  registry: ConnectionRegistry,
  lifecycle = new HttpRequestLifecycle(),
  dependencies: HttpAppDependencies = defaultDependencies,
): Express {
  const app = express();
  const queryLedger = new QueryExecutionLedger();
  const artifactStore =
    dependencies.artifactStore ??
    (config.fileDownloads && config.dynamic
      ? new ArtifactStore(config.fileDownloads)
      : undefined);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok", service: "forty-two-data-source-mcp" });
  });

  app.get(
    "/internal/query-executions/:requestId",
    requireBearerToken(config.authToken),
    (request, response) => {
      const requestId = request.params.requestId;
      const record =
        typeof requestId === "string" ? queryLedger.get(requestId) : undefined;
      if (!record) {
        response.status(404).json({ error: "Query execution not found" });
        return;
      }
      response.json({ data: record });
    },
  );

  app.post(
    "/internal/artifacts/cleanup",
    rejectWhileDraining(lifecycle),
    requireBearerToken(config.authToken),
    async (_request, response) => {
      if (!artifactStore) {
        response
          .status(503)
          .json({ error: "Artifact storage is not configured" });
        return;
      }
      await lifecycle.track(async () => {
        const limit = 100;
        const retained = await artifactStore.cleanupRetainedArtifacts(limit);
        const orphans = await artifactStore.cleanupOrphanUploads({
          limit,
        });
        response.json({ data: { retained, orphans } });
      });
    },
  );

  app.post(
    "/internal/data-sources/:dataSourceId/validate",
    rejectWhileDraining(lifecycle),
    requireBearerToken(config.authToken),
    async (request, response) => {
      await lifecycle.track(async () => {
        const dataSourceId = request.params.dataSourceId;
        if (typeof dataSourceId !== "string") {
          response.status(404).json({ error: "Datasource not found" });
          return;
        }

        let connected = false;
        try {
          await registry.resolveTesting(dataSourceId);
          connected = await registry.dataSource.testDataSource(dataSourceId);
        } catch {
          connected = false;
        }
        if (!connected) await registry.invalidateDynamic(dataSourceId);
        response.json({ data: { dataSourceId, connected } });
      });
    },
  );

  app.use("/mcp", requireAllowedOrigin(config.allowedOrigins));
  app.use("/mcp", rejectWhileDraining(lifecycle));
  app.use("/mcp", requireBearerToken(config.authToken));
  app.post("/mcp", async (request, response) => {
    await lifecycle.track(async () => {
      const server = createDataSourceMcpServer(registry, queryLedger, {
        authorizeSession: dependencies.authorizeSession,
        ...(config.fileDownloads
          ? {
              createFileDownloadDescriptor: (source) =>
                createFileDownloadDescriptor({
                  config: config.fileDownloads!,
                  source,
                }),
            }
          : {}),
        ...(artifactStore ? { artifactStore } : {}),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      const session: ClosableSession = {
        async close(): Promise<void> {
          await Promise.allSettled([transport.close(), server.close()]);
        },
      };
      lifecycle.add(session);
      response.on("close", () => void lifecycle.close(session));

      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal MCP server error" },
            id: null,
          });
        }
        console.error("MCP request failed", error);
      }
    });
  });

  app.get("/mcp", (_request, response) => {
    response
      .status(405)
      .set("Allow", "POST")
      .json({ error: "Method not allowed" });
  });
  app.delete("/mcp", (_request, response) => {
    response
      .status(405)
      .set("Allow", "POST")
      .json({ error: "Method not allowed" });
  });

  return app;
}

function requireAllowedOrigin(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.header("origin");
    if (origin !== undefined && !allowed.has(origin)) {
      response.status(403).json({ error: "Forbidden origin" });
      return;
    }
    next();
  };
}

function rejectWhileDraining(lifecycle: HttpRequestLifecycle) {
  return (_request: Request, response: Response, next: NextFunction): void => {
    if (lifecycle.isDraining) {
      response.status(503).set("Retry-After", "1").json({
        error: "Server is shutting down",
      });
      return;
    }
    next();
  };
}

function requireBearerToken(expectedToken: string) {
  const expected = Buffer.from(expectedToken);
  return (request: Request, response: Response, next: NextFunction): void => {
    const header = request.header("authorization");
    const suppliedToken = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const supplied = Buffer.from(suppliedToken);
    const valid =
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected);
    if (!valid) {
      response
        .status(401)
        .set("WWW-Authenticate", "Bearer")
        .json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
