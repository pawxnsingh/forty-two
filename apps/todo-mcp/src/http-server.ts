import { timingSafeEqual } from "node:crypto";

import { pingDatabase } from "@forty-two/db";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import type { TodoMcpConfig } from "./config.js";
import { createTodoMcpServer, type PlanStore } from "./mcp-server.js";

export function createTodoHttpApp(
  config: TodoMcpConfig,
  store?: PlanStore,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));

  app.get("/healthz", async (_request, response) => {
    const database = await pingDatabase();
    response.status(database ? 200 : 503).json({
      status: database ? "ok" : "unavailable",
      service: "forty-two-todo-mcp",
      database,
    });
  });

  app.use("/mcp", requireBearerToken(config.authToken));
  app.post("/mcp", async (request, response) => {
    const server = createTodoMcpServer(store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void Promise.allSettled([transport.close(), server.close()]);
    });
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
      console.error("Todo MCP request failed", error);
    }
  });
  app.all("/mcp", (_request, response) => {
    response
      .status(405)
      .set("Allow", "POST")
      .json({ error: "Method not allowed" });
  });
  return app;
}

function requireBearerToken(expectedToken: string) {
  const expected = Buffer.from(expectedToken);
  return (request: Request, response: Response, next: NextFunction): void => {
    const header = request.header("authorization");
    const supplied = Buffer.from(
      header?.startsWith("Bearer ") ? header.slice(7) : "",
    );
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.status(401).set("WWW-Authenticate", "Bearer").json({
        error: "Unauthorized",
      });
      return;
    }
    next();
  };
}
