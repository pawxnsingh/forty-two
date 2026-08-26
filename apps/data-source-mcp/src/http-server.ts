import { timingSafeEqual } from "node:crypto";

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

interface ClosableSession {
  close(): Promise<void>;
}

export class HttpRequestLifecycle {
  private readonly sessions = new Set<ClosableSession>();
  private draining = false;

  get isDraining(): boolean {
    return this.draining;
  }

  add(session: ClosableSession): void {
    this.sessions.add(session);
  }

  delete(session: ClosableSession): void {
    this.sessions.delete(session);
  }

  async beginShutdown(): Promise<void> {
    this.draining = true;
    await Promise.allSettled(
      [...this.sessions].map((session) => session.close()),
    );
  }
}

export function createHttpApp(
  config: ServerConfig,
  registry: ConnectionRegistry,
  lifecycle = new HttpRequestLifecycle(),
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok", service: "forty-two-data-source-mcp" });
  });

  app.use("/mcp", requireAllowedOrigin(config.allowedOrigins));
  app.use("/mcp", rejectWhileDraining(lifecycle));
  app.use("/mcp", requireBearerToken(config.authToken));
  app.post("/mcp", async (request, response) => {
    const server = createDataSourceMcpServer(registry);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    let closed = false;
    const session: ClosableSession = {
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        lifecycle.delete(session);
        await Promise.allSettled([transport.close(), server.close()]);
      },
    };
    lifecycle.add(session);
    response.on("close", () => void session.close());

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
