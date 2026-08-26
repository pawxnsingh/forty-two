import { createServer } from "node:http";

import { loadServerConfig } from "./config.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { createHttpApp, HttpRequestLifecycle } from "./http-server.js";

const config = loadServerConfig();
const registry = new ConnectionRegistry(config.connections);
const lifecycle = new HttpRequestLifecycle();
const app = createHttpApp(config, registry, lifecycle);
const httpServer = createServer(app);

httpServer.listen(config.port, config.host, () => {
  console.log(
    `Forty Two data-source MCP listening on http://${config.host}:${config.port}/mcp with ${config.connections.length} configured connection(s)`,
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down data-source MCP`);

  const serverClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  const cleanup = Promise.all([
    lifecycle.beginShutdown(),
    registry.close(),
    serverClosed,
  ]).then(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Shutdown drain deadline exceeded")),
      config.shutdownTimeoutMs,
    );
  });

  try {
    await Promise.race([cleanup, deadline]);
    console.log("Data-source MCP shutdown complete");
  } catch (error) {
    httpServer.closeAllConnections();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error) => {
        console.error("Failed to shut down cleanly", error);
        process.exit(1);
      },
    );
  });
}
