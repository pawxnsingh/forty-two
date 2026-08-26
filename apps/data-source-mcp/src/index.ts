import { createServer } from "node:http";

import { loadServerConfig } from "./config.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { createHttpApp } from "./http-server.js";

const config = loadServerConfig();
const registry = new ConnectionRegistry(config.connections);
const app = createHttpApp(config, registry);
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

  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  await registry.close();
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
