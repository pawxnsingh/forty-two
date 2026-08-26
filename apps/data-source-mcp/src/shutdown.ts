import type { Server } from "node:http";

import type { ConnectionRegistry } from "./connection-registry.js";
import type { HttpRequestLifecycle } from "./http-server.js";

interface ShutdownResources {
  httpServer: Server;
  lifecycle: HttpRequestLifecycle;
  registry: Pick<ConnectionRegistry, "close">;
  timeoutMs: number;
}

export async function drainAndClose({
  httpServer,
  lifecycle,
  registry,
  timeoutMs,
}: ShutdownResources): Promise<void> {
  const cleanup = (async () => {
    await lifecycle.beginShutdown();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    await registry.close();
  })();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Shutdown drain deadline exceeded")),
      timeoutMs,
    );
  });

  try {
    await Promise.race([cleanup, deadline]);
  } catch (error) {
    httpServer.closeAllConnections();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
