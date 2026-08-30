import { closeDatabase } from "@forty-two/db";

import { loadTodoMcpConfig } from "./config.js";
import { createTodoHttpApp } from "./http-server.js";

const config = loadTodoMcpConfig();
const server = createTodoHttpApp(config).listen(
  config.port,
  config.host,
  () => {
    console.log(
      `Forty Two Todo MCP listening on ${config.host}:${config.port}.`,
    );
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void closeDatabase().finally(() => process.exit(0));
    });
  });
}
