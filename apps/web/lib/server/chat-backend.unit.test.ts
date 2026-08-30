import assert from "node:assert/strict";
import test from "node:test";

import type { ChatSession } from "@forty-two/db";

import {
  ApiInputError,
  createApplicationSession,
  deleteApplicationSession,
  deleteSessionResources,
  readTurnInput,
  sqlApplyApprovalArguments,
  type ApplicationSessionCleanupDependencies,
  type TrueForgeSessionCleanupDependencies,
} from "./chat-backend";

const approvalInput = {
  changeSetId: "change_01HZX000000000000000000001",
  sessionId: "sess_01HZX000000000000000000001",
  dataSourceId: "ds_01HZX000000000000000000001",
  connector: "postgresql",
  operation: "update",
  target: { catalog: null, schema: "public", table: "metrics" },
  canonicalSql: "UPDATE metrics SET value = 7 WHERE id = 2",
  statementHash: "a".repeat(64),
  expectedAffectedRows: 1,
  resourceEstimate: null,
};

test("approval provenance accepts only direct or exact scoped apply calls", () => {
  assert.deepEqual(
    sqlApplyApprovalArguments(
      {
        toolInfo: {
          type: "mcp",
          serverName: "forty-two-data-source",
          name: "apply_sql_change",
        },
        function: { arguments: JSON.stringify(approvalInput) },
      },
      "forty-two-data-source",
    ),
    approvalInput,
  );
  assert.deepEqual(
    sqlApplyApprovalArguments(
      {
        toolInfo: { type: "truefoundry-system", name: "call_tool" },
        function: {
          arguments: JSON.stringify({
            mcp_server: "forty-two-data-source",
            tool_name: "apply_sql_change",
            input: approvalInput,
          }),
        },
      },
      "forty-two-data-source",
    ),
    approvalInput,
  );
  for (const argumentsValue of [
    {
      mcp_server: "ft-session-other",
      tool_name: "apply_sql_change",
      input: approvalInput,
    },
    {
      mcp_server: "forty-two-data-source",
      tool_name: "prepare_sql_change",
      input: approvalInput,
    },
    {
      mcp_server: "ft-session-one",
      tool_name: "apply_sql_change",
      input: approvalInput,
      approved: true,
    },
  ]) {
    assert.throws(
      () =>
        sqlApplyApprovalArguments(
          {
            toolInfo: { type: "truefoundry-system", name: "call_tool" },
            function: { arguments: JSON.stringify(argumentsValue) },
          },
          "forty-two-data-source",
        ),
      ApiInputError,
    );
  }
  for (const toolInfo of [
    {
      type: "mcp",
      serverName: "ft-session-other",
      name: "apply_sql_change",
    },
    {
      type: "mcp",
      serverName: "forty-two-data-source",
      name: "prepare_sql_change",
    },
    {
      type: "mcp",
      serverName: "forty-two-data-source",
      name: "apply_sql_change",
      approved: true,
    },
  ]) {
    assert.throws(
      () =>
        sqlApplyApprovalArguments(
          {
            toolInfo,
            function: { arguments: JSON.stringify(approvalInput) },
          },
          "forty-two-data-source",
        ),
      ApiInputError,
    );
  }
  for (const malformed of ["not json", "[]", "null"]) {
    assert.throws(
      () =>
        sqlApplyApprovalArguments(
          {
            toolInfo: { type: "truefoundry-system", name: "call_tool" },
            function: { arguments: malformed },
          },
          "forty-two-data-source",
        ),
      ApiInputError,
    );
  }
  assert.throws(
    () =>
      sqlApplyApprovalArguments(
        {
          toolInfo: {
            type: "mcp",
            serverName: "forty-two-data-source",
            name: "apply_sql_change",
          },
          function: {
            arguments: JSON.stringify({ ...approvalInput, approved: true }),
          },
        },
        "forty-two-data-source",
      ),
    ApiInputError,
  );
  for (const toolInfo of [
    { type: "truefoundry-system", name: "call_tool", serverName: "attacker" },
    { type: "truefoundry-system", name: "call_tool", approved: true },
  ]) {
    assert.throws(
      () =>
        sqlApplyApprovalArguments(
          {
            toolInfo,
            function: {
              arguments: JSON.stringify({
                mcp_server: "forty-two-data-source",
                tool_name: "apply_sql_change",
                input: approvalInput,
              }),
            },
          },
          "forty-two-data-source",
        ),
      ApiInputError,
    );
  }
});

test("turns accept JSON messages only", async () => {
  const message = await readTurnInput(
    new Request("http://localhost/api/chat/sessions/example/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "  analyze the bound sources  " }),
    }),
  );
  assert.deepEqual(message, {
    type: "user.message",
    content: "analyze the bound sources",
  });

  await assert.rejects(
    readTurnInput(
      new Request("http://localhost/api/chat/sessions/example/turns", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "--x--",
      }),
    ),
    (error: unknown) =>
      error instanceof ApiInputError &&
      error.status === 415 &&
      error.message === "Content-Type must be application/json.",
  );
});

test("turn JSON rejects empty and oversized messages", async () => {
  for (const message of ["   ", "x".repeat(20_001)]) {
    await assert.rejects(
      readTurnInput(
        new Request("http://localhost/api/chat/sessions/example/turns", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        }),
      ),
      ApiInputError,
    );
  }
});

test("public session creation rejects raw AgentSpecs and connector names", async () => {
  for (const body of [
    {
      agent: { spec: { mcp_servers: [{ name: "ft-session-victim" }] } },
    },
    { dataSourceIds: [], mcpServerName: "ft-session-victim" },
  ]) {
    await assert.rejects(
      createApplicationSession(
        new Request("http://localhost/api/chat/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
      (error: unknown) =>
        error instanceof ApiInputError &&
        error.status === 400 &&
        error.message === "Request body must contain only dataSourceIds.",
    );
  }
});

test("cleanup retries after immediate durable revocation", async () => {
  const createdAt = new Date(Date.now() - 1_000);
  const active: ChatSession = {
    id: "sess_01HZX000000000000000000001",
    trueforgeSessionId: "trueforge-session-1",
    mcpServerName: null,
    capabilityId: "capability-1",
    capabilityExpiresAt: new Date(Date.now() + 60_000),
    capabilityRevokedAt: null,
    idempotencyKey: null,
    idempotencyRequestHash: null,
    status: "active",
    failureMessage: null,
    plan: null,
    planRevision: 0,
    planUpdatedAt: null,
    planQuestionKey: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  let persisted = active;
  let revocationCalls = 0;
  let runtimeCleanupCalls = 0;
  const dependencies: ApplicationSessionCleanupDependencies = {
    getSession: async () => persisted,
    revokeSession: async () => {
      revocationCalls += 1;
      const revokedAt = new Date();
      persisted = {
        ...persisted,
        status: "deleted",
        capabilityRevokedAt: revokedAt,
        deletedAt: revokedAt,
        updatedAt: revokedAt,
      };
      return persisted;
    },
    deleteSessionResources: async () => {
      runtimeCleanupCalls += 1;
      assert.equal(persisted.status, "deleted");
      assert.ok(persisted.capabilityRevokedAt);
      if (runtimeCleanupCalls === 1) {
        throw new Error("transient runtime cleanup failure");
      }
    },
  };

  await assert.rejects(
    deleteApplicationSession(active.id, dependencies),
    /external cleanup was incomplete/,
  );
  assert.equal(persisted.status, "deleted");
  assert.ok(persisted.capabilityRevokedAt);

  await deleteApplicationSession(active.id, dependencies);
  assert.equal(revocationCalls, 1);
  assert.equal(runtimeCleanupCalls, 2);
});

test("runtime cleanup deletes a successfully enumerated sandbox-free session", async () => {
  const calls: string[] = [];
  let sandboxDeletes = 0;
  const dependencies: TrueForgeSessionCleanupDependencies = {
    cancelSession: async (sessionId) => {
      calls.push(`cancel:${sessionId}`);
    },
    listTurns: async (sessionId) => {
      calls.push(`turns:${sessionId}`);
      return [{ id: "turn-todo-or-approval-only" }];
    },
    listEvents: async (sessionId, lastTurnId) => {
      calls.push(`events:${sessionId}:${lastTurnId}`);
      return [];
    },
    deleteDaytonaSandbox: async () => {
      sandboxDeletes += 1;
    },
    deleteTrueForgeSession: async (sessionId) => {
      calls.push(`delete:${sessionId}`);
    },
    wait: async () => undefined,
  };

  await deleteSessionResources("trueforge-sandbox-free", dependencies);

  assert.equal(sandboxDeletes, 0);
  assert.deepEqual(calls, [
    "cancel:trueforge-sandbox-free",
    "turns:trueforge-sandbox-free",
    "events:trueforge-sandbox-free:turn-todo-or-approval-only",
    "delete:trueforge-sandbox-free",
  ]);
});

test("runtime cleanup retains a session when sandbox enumeration fails", async () => {
  let eventAttempts = 0;
  let trueforgeDeletes = 0;
  const dependencies: TrueForgeSessionCleanupDependencies = {
    cancelSession: async () => undefined,
    listTurns: async () => [{ id: "turn-unknown" }],
    listEvents: async () => {
      eventAttempts += 1;
      throw new Error("event enumeration unavailable");
    },
    deleteDaytonaSandbox: async () => undefined,
    deleteTrueForgeSession: async () => {
      trueforgeDeletes += 1;
    },
    wait: async () => undefined,
  };

  await assert.rejects(
    deleteSessionResources("trueforge-unknown", dependencies),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.message === "Session cleanup was incomplete." &&
      error.errors.some((cause) =>
        String(cause).includes("sandbox disposition is unknown"),
      ),
  );
  assert.equal(eventAttempts, 3);
  assert.equal(trueforgeDeletes, 0);
});
