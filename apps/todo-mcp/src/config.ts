const DEFAULT_PORT = 8792;

export interface TodoMcpConfig {
  host: string;
  port: number;
  authToken: string;
}

export function loadTodoMcpConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TodoMcpConfig {
  const authToken = environment.TODO_MCP_AUTH_TOKEN?.trim();
  if (!authToken) throw new Error("TODO_MCP_AUTH_TOKEN is required");
  if (!environment.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required");
  }
  return {
    host: environment.HOST?.trim() || "0.0.0.0",
    port: parsePort(environment.PORT),
    authToken,
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return port;
}
