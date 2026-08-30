import assert from "node:assert/strict";
import test from "node:test";

import { loadTodoMcpConfig } from "../src/config.js";

test("requires the dedicated platform token and database URL", () => {
  assert.throws(() => loadTodoMcpConfig({}), /TODO_MCP_AUTH_TOKEN/);
  assert.throws(
    () => loadTodoMcpConfig({ TODO_MCP_AUTH_TOKEN: "token" }),
    /DATABASE_URL/,
  );
  assert.deepEqual(
    loadTodoMcpConfig({
      TODO_MCP_AUTH_TOKEN: "token",
      DATABASE_URL: "postgresql://local/test",
    }),
    { host: "0.0.0.0", port: 8792, authToken: "token" },
  );
});
