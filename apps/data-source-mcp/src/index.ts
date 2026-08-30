import { createServer } from "node:http";

import { closeDatabase, initializeDatabase } from "@forty-two/db";

import { loadServerConfig } from "./config.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { createHttpApp, HttpRequestLifecycle } from "./http-server.js";
import { createDynamicConnectionStore } from "./dynamic-store.js";
import { drainAndClose } from "./shutdown.js";

const config = loadServerConfig();
initializeDatabase({ connectionString: config.dynamic.controlDatabaseUrl });
const registry = new ConnectionRegistry(config.connections, {
  encryptionKey: config.dynamic.encryptionKey,
  store: createDynamicConnectionStore(),
});
const lifecycle = new HttpRequestLifecycle();
const app = createHttpApp(config, registry, lifecycle);
const httpServer = createServer(app);

httpServer.listen(config.port, config.host, () => {
  console.log(
    `Forty Two data-source MCP listening on http://${config.host}:${config.port}/mcp with dynamic datasource resolution enabled`,
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down data-source MCP`);

  await drainAndClose({
    httpServer,
    lifecycle,
    registry,
    timeoutMs: config.shutdownTimeoutMs,
  });
  await closeDatabase();
  console.log("Data-source MCP shutdown complete");
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
