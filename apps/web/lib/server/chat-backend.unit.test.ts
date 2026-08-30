import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatTurnRequestConflictError,
  type ChatSession,
  type ChatTurnRequest,
} from "@forty-two/db";
import { TrueForgeError } from "@truefoundry/trueforge-sdk";

import {
  ApiInputError,
  createApplicationTurn,
  createTrueForgeTurnOnce,
  createApplicationSession,
  deleteApplicationSession,
  deleteSessionResources,
  readTurnInput,
  recordApprovalThenContinue,
  runApprovalContinuationOnce,
  settledExistingApplicationSession,
  sqlApplyApprovalArguments,
  type ApplicationSessionCleanupDependencies,
  type ApplicationTurnDependencies,
  type TrueForgeSessionCleanupDependencies,
} from "./chat-backend";

const applicationSessionId = "sess_01HZX000000000000000000001";

function turnRequest(
  overrides: Partial<ChatTurnRequest> = {},
): ChatTurnRequest {
  const now = new Date();
  return {
    chatSessionId: applicationSessionId,
    idempotencyKey: "turn-key",
    requestHash: "a".repeat(64),
    state: "creating",
    trueforgeTurnId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function turnResponse(id: string) {
  return { data: { id } } as Awaited<
    ReturnType<ApplicationTurnDependencies["createTurn"]>
  >;
}

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

test("concurrent approval continuations share one side effect and reject decision drift", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = async () => {
    calls += 1;
    await blocked;
    return { data: { id: "turn-resumed" } } as unknown as Awaited<
      ReturnType<typeof runApprovalContinuationOnce>
    >;
  };
  const key = `approval-test-${Date.now()}`;
  const first = runApprovalContinuationOnce(key, "allow:", create);
  const retry = runApprovalContinuationOnce(key, "allow:", create);
  assert.throws(
    () => runApprovalContinuationOnce(key, "deny:no", create),
    /another decision/,
  );
  release();
  assert.equal(await first, await retry);
  assert.equal(calls, 1);
});

test("records an approval decision durably before continuing the runtime", async () => {
  const order: string[] = [];
  assert.equal(
    await recordApprovalThenContinue(
      async () => {
        order.push("record");
      },
      async () => {
        order.push("continue");
        return "resumed";
      },
    ),
    "resumed",
  );
  assert.deepEqual(order, ["record", "continue"]);

  await assert.rejects(
    recordApprovalThenContinue(
      async () => {
        throw new Error("database unavailable");
      },
      async () => {
        order.push("must-not-continue");
        return "unreachable";
      },
    ),
    /database unavailable/,
  );
  assert.deepEqual(order, ["record", "continue"]);
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

test("turn creation disables SDK transport retries for the non-idempotent POST", async () => {
  let observedOptions: { maxRetries: number } | undefined;
  const response = turnResponse("turn-once");
  const returned = await createTrueForgeTurnOnce(
    {
      createTurn: async (_sessionId, _request, options) => {
        observedOptions = options;
        return response;
      },
    },
    "trueforge-session",
    { type: "user.message", content: "Analyze this" },
  );
  assert.equal(returned, response);
  assert.deepEqual(observedOptions, { maxRetries: 0 });
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

test("JSON input rejects declared and streamed bodies above the byte ceiling", async () => {
  const declared = {
    headers: new Headers({
      "content-type": "application/json",
      "content-length": String(64 * 1024 + 1),
    }),
    body: null,
  } as Request;
  for (const request of [
    declared,
    new Request("http://localhost/api/chat/sessions/example/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ message: "x".repeat(64 * 1024) }),
            ),
          );
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit),
  ]) {
    await assert.rejects(
      readTurnInput(request),
      (error: unknown) =>
        error instanceof ApiInputError &&
        error.status === 413 &&
        error.message === "Request body is too large.",
    );
  }
});

test("turn retries return the durable existing turn without another side effect", async () => {
  let stored: ChatTurnRequest | null = null;
  let createCalls = 0;
  let getCalls = 0;
  let beginCalls = 0;
  const dependencies: ApplicationTurnDependencies = {
    reserve: async (input) => {
      if (stored) {
        if (stored.requestHash !== input.requestHash) {
          throw new ChatTurnRequestConflictError();
        }
        return { request: stored, reserved: false };
      }
      stored = turnRequest({
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      });
      return { request: stored, reserved: true };
    },
    get: async () => stored,
    complete: async (input) => {
      stored = {
        ...stored!,
        state: "created",
        trueforgeTurnId: input.trueforgeTurnId,
      };
      return stored;
    },
    markIndeterminate: async () => {
      stored = { ...stored!, state: "indeterminate" };
      return stored;
    },
    beginQuestion: async () => {
      beginCalls += 1;
    },
    trueforgeSessionId: async () => "trueforge-session",
    createTurn: async () => {
      createCalls += 1;
      return turnResponse("turn-one");
    },
    getTurn: async (_sessionId, turnId) => {
      getCalls += 1;
      return turnResponse(turnId);
    },
    wait: async () => undefined,
  };
  const request = new Request("http://localhost/turns", {
    headers: { "Idempotency-Key": "turn-key" },
  });
  const message = { type: "user.message", content: "Analyze this" } as const;

  const first = await createApplicationTurn(
    applicationSessionId,
    message,
    request,
    dependencies,
  );
  const retry = await createApplicationTurn(
    applicationSessionId,
    message,
    request,
    dependencies,
  );

  assert.equal(first.data.id, "turn-one");
  assert.equal(retry.data.id, "turn-one");
  assert.equal(createCalls, 1);
  assert.equal(getCalls, 1);
  assert.equal(beginCalls, 1);
});

test("concurrent turn retries single-flight through the durable reservation", async () => {
  let stored: ChatTurnRequest | null = null;
  let createCalls = 0;
  let releaseCreate!: () => void;
  let settleWait!: () => void;
  const createBlocked = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const requestSettled = new Promise<void>((resolve) => {
    settleWait = resolve;
  });
  const dependencies: ApplicationTurnDependencies = {
    reserve: async (input) => {
      if (stored) return { request: stored, reserved: false };
      stored = turnRequest({
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      });
      return { request: stored, reserved: true };
    },
    get: async () => stored,
    complete: async (input) => {
      stored = {
        ...stored!,
        state: "created",
        trueforgeTurnId: input.trueforgeTurnId,
      };
      settleWait();
      return stored;
    },
    markIndeterminate: async () => {
      stored = { ...stored!, state: "indeterminate" };
      settleWait();
      return stored;
    },
    beginQuestion: async () => undefined,
    trueforgeSessionId: async () => "trueforge-session",
    createTurn: async () => {
      createCalls += 1;
      await createBlocked;
      return turnResponse("turn-concurrent");
    },
    getTurn: async (_sessionId, turnId) => turnResponse(turnId),
    wait: async () => requestSettled,
  };
  const request = new Request("http://localhost/turns", {
    headers: { "Idempotency-Key": "turn-key" },
  });
  const message = { type: "user.message", content: "Analyze this" } as const;

  const first = createApplicationTurn(
    applicationSessionId,
    message,
    request,
    dependencies,
  );
  while (createCalls === 0) await Promise.resolve();
  const retry = createApplicationTurn(
    applicationSessionId,
    message,
    request,
    dependencies,
  );
  releaseCreate();

  const [firstResult, retryResult] = await Promise.all([first, retry]);
  assert.equal(firstResult.data.id, "turn-concurrent");
  assert.equal(retryResult.data.id, "turn-concurrent");
  assert.equal(createCalls, 1);
});

test("turn idempotency rejects message drift and ambiguous retries", async () => {
  let stored: ChatTurnRequest | null = null;
  let createCalls = 0;
  const dependencies: ApplicationTurnDependencies = {
    reserve: async (input) => {
      if (stored) {
        if (stored.requestHash !== input.requestHash) {
          throw new ChatTurnRequestConflictError();
        }
        return { request: stored, reserved: false };
      }
      stored = turnRequest({
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      });
      return { request: stored, reserved: true };
    },
    get: async () => stored,
    complete: async () => {
      throw new Error("unexpected completion");
    },
    markIndeterminate: async () => {
      stored = { ...stored!, state: "indeterminate" };
      return stored;
    },
    beginQuestion: async () => undefined,
    trueforgeSessionId: async () => "trueforge-session",
    createTurn: async () => {
      createCalls += 1;
      throw new Error("connection lost after request submission");
    },
    getTurn: async () => {
      throw new Error("unexpected get");
    },
    wait: async () => undefined,
  };
  const request = new Request("http://localhost/turns", {
    headers: { "Idempotency-Key": "turn-key" },
  });
  await assert.rejects(
    createApplicationTurn(
      applicationSessionId,
      { type: "user.message", content: "Analyze this" },
      request,
      dependencies,
    ),
    /connection lost/,
  );
  await assert.rejects(
    createApplicationTurn(
      applicationSessionId,
      { type: "user.message", content: "Analyze this" },
      request,
      dependencies,
    ),
    (error: unknown) => error instanceof ApiInputError && error.status === 409,
  );
  await assert.rejects(
    createApplicationTurn(
      applicationSessionId,
      { type: "user.message", content: "Different message" },
      request,
      dependencies,
    ),
    ChatTurnRequestConflictError,
  );
  assert.equal(createCalls, 1);
});

test("turn requests without an idempotency key remain distinct", async () => {
  let createCalls = 0;
  let beginCalls = 0;
  const dependencies = {
    reserve: async () => {
      throw new Error("unexpected reserve");
    },
    get: async () => null,
    complete: async () => {
      throw new Error("unexpected complete");
    },
    markIndeterminate: async () => {
      throw new Error("unexpected indeterminate");
    },
    beginQuestion: async () => {
      beginCalls += 1;
    },
    trueforgeSessionId: async () => "trueforge-session",
    createTurn: async () => turnResponse(`turn-${++createCalls}`),
    getTurn: async () => {
      throw new Error("unexpected get");
    },
    wait: async () => undefined,
  } satisfies ApplicationTurnDependencies;
  const request = new Request("http://localhost/turns");
  const message = { type: "user.message", content: "Analyze this" } as const;

  const first = await createApplicationTurn(
    applicationSessionId,
    message,
    request,
    dependencies,
  );
  const second = await createApplicationTurn(
    applicationSessionId,
    message,
    request,
    dependencies,
  );

  assert.equal(first.data.id, "turn-1");
  assert.equal(second.data.id, "turn-2");
  assert.equal(beginCalls, 2);
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

test("deleted idempotency winners fail immediately", () => {
  const now = new Date();
  const deleted: ChatSession = {
    id: "sess_01HZX000000000000000000001",
    trueforgeSessionId: "trueforge-session-deleted",
    mcpServerName: null,
    capabilityId: "capability-deleted",
    capabilityExpiresAt: new Date(now.getTime() + 60_000),
    capabilityRevokedAt: now,
    idempotencyKey: "deleted-key",
    idempotencyRequestHash: "a".repeat(64),
    status: "deleted",
    failureMessage: null,
    plan: null,
    planRevision: 0,
    planUpdatedAt: null,
    planQuestionKey: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
  };
  assert.throws(
    () => settledExistingApplicationSession(deleted),
    (error: unknown) => error instanceof ApiInputError && error.status === 409,
  );
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

test("runtime cleanup does not equate a missing session with deleted sandboxes", async () => {
  let listedTurns = 0;
  let trueforgeDeletes = 0;
  const missing = new TrueForgeError({ message: "missing", statusCode: 404 });
  const dependencies: TrueForgeSessionCleanupDependencies = {
    cancelSession: async () => {
      throw missing;
    },
    listTurns: async () => {
      listedTurns += 1;
      throw missing;
    },
    listEvents: async () => [],
    deleteDaytonaSandbox: async () => undefined,
    deleteTrueForgeSession: async () => {
      trueforgeDeletes += 1;
    },
    wait: async () => undefined,
  };

  await assert.rejects(
    deleteSessionResources("trueforge-missing", dependencies),
    /Session cleanup was incomplete/,
  );
  assert.equal(listedTurns, 1);
  assert.equal(trueforgeDeletes, 0);
});
