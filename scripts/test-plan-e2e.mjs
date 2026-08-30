import assert from "node:assert/strict";

import { Client } from "../apps/todo-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../apps/todo-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import {
  mergeEventDelta,
  TrueForge,
} from "../apps/web/node_modules/@truefoundry/trueforge-sdk/dist/esm/index.mjs";
import {
  closeDatabase,
  createChatSession,
  failChatSession,
  getChatSession,
  getChatSessionForCleanup,
  softDeleteChatSession,
} from "../packages/db/dist/index.js";

const webUrl = normalizedUrl(process.env.WEB_URL ?? "http://127.0.0.1:3000");
const trueforgeUrl = normalizedUrl(
  process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790",
);
const todoMcpUrl = normalizedUrl(
  process.env.TODO_MCP_URL ?? "http://127.0.0.1:8792",
);
const todoToken = requiredSecret("TODO_MCP_AUTH_TOKEN");
const agentName =
  process.env.FORTY_TWO_AGENT_NAME?.trim() || "forty-two-data-agent";
const trueforge = new TrueForge({
  baseUrl: trueforgeUrl,
  timeoutInSeconds: 300,
  maxRetries: 2,
});
const sessions = new Map();
let directClient;
let fixtureDataSourceId;
let primaryError;

try {
  await proveRegistrationAndAgentContract();
  fixtureDataSourceId = await createPlanFixture();
  const application = await createApplicationSession();
  const sessionId = application.id;
  const runtimeSessionId = application.trueforgeSessionId;

  directClient = new Client({ name: "forty-two-plan-e2e", version: "0.1.0" });
  await directClient.connect(
    new StreamableHTTPClientTransport(new URL(`${todoMcpUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${todoToken}` },
      },
    }),
  );
  await proveProtocolNegatives(sessionId);
  await provePersistenceIdempotencyAndConcurrency(sessionId);
  await proveUnavailableSessionNegatives();

  const questionKey = crypto.randomUUID();
  const liveSteps = [
    {
      expected: "PLAN_SET_OK",
      message:
        "Call the forty-two-todo plan tool exactly once with action set. Use the exact application session ID from session context, title Live plan E2E, and exactly three pending items named Prepare evidence, Verify persistence, and Report result. Use no other tool and then answer exactly PLAN_SET_OK.",
    },
    ...[
      [0, "in_progress", undefined, "ITEM_0_STARTED"],
      [0, "completed", "Evidence prepared", "ITEM_0_DONE"],
      [1, "in_progress", undefined, "ITEM_1_STARTED"],
      [1, "completed", "Persistence verified", "ITEM_1_DONE"],
      [2, "in_progress", undefined, "ITEM_2_STARTED"],
      [2, "completed", "Result reported", "ITEM_2_DONE"],
    ].map(([itemIndex, status, summary, expected]) => ({
      expected,
      message: `Call the forty-two-todo plan tool exactly once with action update_item, the exact application session ID from session context, itemIndex ${itemIndex}, status ${status}${summary ? `, and summary ${summary}` : ", and omit summary"}. Use no other tool and then answer exactly ${expected}.`,
    })),
  ];
  const sdkEvents = [];
  const persistedEvents = [];
  const productPlanEvents = [];
  const persistedPlanEvents = [];
  let turnId;
  for (const step of liveSteps) {
    const result = await runLivePlanTurn({
      sessionId,
      runtimeSessionId,
      questionKey,
      ...step,
    });
    turnId = result.turnId;
    sdkEvents.push(...result.sdkEvents);
    persistedEvents.push(...result.persistedEvents);
    productPlanEvents.push(...result.productPlanEvents);
    persistedPlanEvents.push(...result.persistedPlanEvents);
  }
  assert.ok(turnId);
  const reload = await currentPlan(sessionId);
  proveLiveTurnEvents({
    liveEvents: sdkEvents,
    persistedEvents,
    productPlanEvents,
    persistedPlanEvents,
    databasePlan: reload,
    applicationSessionId: sessionId,
  });
  const history = await requestProduct(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`,
  );
  assert.ok(history.planEvents.length >= 2);
  assert.equal(reload.plan?.title, "Live plan E2E");
  assert.deepEqual(
    reload.plan?.items.map(({ status }) => status),
    ["completed", "completed", "completed"],
  );
  assert.deepEqual(
    reload.plan?.items.map(({ summary }) => summary),
    ["Evidence prepared", "Persistence verified", "Result reported"],
  );
  const reconciled = history.planEvents
    .filter(({ type }) => type === "plan.reconciled")
    .at(-1)?.snapshot;
  assert.deepEqual(reconciled, reload);

  const databaseState = await getChatSession({ chatSessionId: sessionId });
  assert.deepEqual(databaseState?.plan, reload.plan);
  assert.equal(databaseState?.planRevision, reload.revision);
  assert.equal(databaseState?.planUpdatedAt?.toISOString(), reload.updatedAt);

  const retryTurn = await createAndWaitTurn({
    sessionId,
    questionKey,
    message:
      "This is an idempotent submission retry. Do not call tools. Answer exactly RETRY_OK.",
  });
  assert.match(JSON.stringify(retryTurn.state?.output), /RETRY_OK/);
  const afterRetry = await currentPlan(sessionId);
  assert.deepEqual(afterRetry, reload);

  const resetTurn = await createAndWaitTurn({
    sessionId,
    questionKey: crypto.randomUUID(),
    message:
      "This is a genuinely new question. Do not call tools. Answer exactly RESET_OK.",
  });
  assert.match(JSON.stringify(resetTurn.state?.output), /RESET_OK/);
  const afterReset = await currentPlan(sessionId);
  assert.equal(afterReset.plan, null);
  assert.equal(afterReset.revision, reload.revision + 1);

  const runtimeSession = await trueforge.sessions.get(runtimeSessionId);
  const runtimeSerialized = JSON.stringify(runtimeSession.data);
  assert.ok(runtimeSerialized.includes(sessionId));
  assert.ok(runtimeSerialized.includes("forty-two-todo"));
  assert.equal(runtimeSerialized.includes(todoToken), false);
  assert.doesNotMatch(
    runtimeSerialized,
    /TODO_MCP_AUTH_TOKEN|MCP_AUTH_TOKEN|sk[-]proj-/i,
  );

  console.log(
    `Plan E2E passed (application session mapped, plan revisions ${reload.revision}->${afterReset.revision}, ${sdkEvents.length} SDK events, ${productPlanEvents.length} normalized live events).`,
  );
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  await directClient?.close().catch((error) => cleanupErrors.push(error));
  for (const [sessionId, runtimeSessionId] of sessions) {
    try {
      await deleteProductSessionAndAssertCleanup(sessionId, runtimeSessionId);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (fixtureDataSourceId) {
    try {
      const response = await fetch(
        `${webUrl}/api/data-sources/${encodeURIComponent(fixtureDataSourceId)}`,
        { method: "DELETE", signal: AbortSignal.timeout(60_000) },
      );
      assert.ok(
        response.status === 204 || response.status === 404,
        `Plan fixture cleanup returned ${response.status}.`,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await closeDatabase().catch((error) => cleanupErrors.push(error));
  if (primaryError || cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      "Plan E2E failed or cleanup was incomplete.",
    );
  }
}

async function proveRegistrationAndAgentContract() {
  const servers = await requestTrueforge("/api/v1/settings/mcp-servers");
  const todoServers = servers.data?.filter(
    ({ name }) => name === "forty-two-todo",
  );
  assert.equal(
    todoServers?.length,
    1,
    "Todo MCP was not registered exactly once.",
  );
  const tools = await requestTrueforge(
    "/api/v1/mcp-servers/forty-two-todo/tools",
  );
  assert.deepEqual(
    tools.data?.map(({ name }) => name),
    ["plan"],
  );

  const agents = await trueforge.agents.list();
  const agent = agents.data.find(({ name }) => name === agentName);
  assert.ok(agent, "The product agent was not registered.");
  const todo = agent.manifest.mcpServers?.find(
    ({ name }) => name === "forty-two-todo",
  );
  assert.deepEqual(todo?.enableTools, ["plan"]);
  assert.deepEqual(todo?.preloadTools, ["plan"]);
  assert.deepEqual(todo?.requireApprovalForTools, []);
  const datasource = agent.manifest.mcpServers?.find(
    ({ name }) => name === "forty-two-data-source",
  );
  assert.deepEqual(datasource?.requireApprovalForTools, ["apply_sql_change"]);
  assert.equal(agent.manifest.config?.generativeUi?.enabled, false);
  assert.match(
    agent.manifest.instructions ?? "",
    /Do not leave completed work in_progress/,
  );
  const serialized = JSON.stringify(agent.manifest);
  assert.equal(serialized.includes(todoToken), false);
  assert.doesNotMatch(
    serialized,
    /TODO_MCP_AUTH_TOKEN|MCP_AUTH_TOKEN|sk[-]proj-/i,
  );
}

async function createApplicationSession() {
  assert.match(fixtureDataSourceId, /^ds_[0-9A-HJKMNP-TV-Z]{26}$/);
  const response = await requestProduct("/api/chat/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ dataSourceIds: [fixtureDataSourceId] }),
  });
  const id = requiredString(response.data?.id, "application session id");
  assert.match(id, /^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
  const stored = await getChatSession({ chatSessionId: id });
  const trueforgeSessionId = requiredString(
    stored?.trueforgeSessionId,
    "TrueForge session id",
  );
  sessions.set(id, trueforgeSessionId);
  return { id, trueforgeSessionId };
}

async function createPlanFixture() {
  const bytes = Buffer.from("name,value\nplan,42\n", "utf8");
  const initiated = await requestProduct("/api/data-sources/files/initiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Plan E2E fixture",
      filename: "plan-e2e.csv",
      mimeType: "text/csv",
      fileSizeBytes: bytes.byteLength,
    }),
  });
  const uploaded = await fetch(initiated.upload.url, {
    method: "PUT",
    headers: initiated.upload.headers,
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(uploaded.status, 201);
  const completed = await requestProduct(
    `/api/data-sources/${encodeURIComponent(initiated.data.id)}/complete`,
    { method: "POST" },
  );
  assert.equal(completed.data.status, "ready");
  return completed.data.id;
}

async function proveProtocolNegatives(sessionId) {
  await expectToolError({
    sessionId,
    action: "update_item",
    itemIndex: 0,
    status: "completed",
  });
  await expectToolError({
    sessionId: "sess_01HZX000000000000000000000",
    action: "set",
    title: "Unknown",
    items: [{ text: "Rejected" }],
  });
  await expectToolError({
    sessionId,
    action: "set",
    title: "Oversized",
    items: Array.from({ length: 16 }, (_, index) => ({
      text: `Item ${index}`,
    })),
  });
  await expectToolError({
    sessionId,
    action: "update_item",
    itemIndex: 0,
    status: "not-a-status",
  });
}

async function provePersistenceIdempotencyAndConcurrency(sessionId) {
  const setResult = await callPlan({
    sessionId,
    action: "set",
    title: "Concurrency proof",
    items: [{ text: "First" }, { text: "Second" }],
  });
  assert.equal(setResult.revision, 1);
  const repeated = await callPlan({
    sessionId,
    action: "set",
    title: "Concurrency proof",
    items: [{ text: "First" }, { text: "Second" }],
  });
  assert.equal(repeated.revision, 1);
  const updates = await Promise.all([
    callPlan({
      sessionId,
      action: "update_item",
      itemIndex: 0,
      status: "completed",
      summary: "First done",
    }),
    callPlan({
      sessionId,
      action: "update_item",
      itemIndex: 1,
      status: "failed",
      summary: "Second failed",
    }),
  ]);
  assert.deepEqual(
    updates.map(({ revision }) => revision).sort((left, right) => left - right),
    [2, 3],
  );
  const canonical = await currentPlan(sessionId);
  assert.deepEqual(
    canonical.plan?.items.map(({ status }) => status),
    ["completed", "failed"],
  );
  assert.equal(canonical.revision, 3);
}

async function proveUnavailableSessionNegatives() {
  const creating = await createChatSession({
    dataSourceIds: [fixtureDataSourceId],
    maxDataSources: 1,
    capabilityId: `plan-e2e-creating-${crypto.randomUUID()}`,
    capabilityExpiresAt: new Date(Date.now() + 60_000),
  });
  await expectToolError({
    sessionId: creating.chatSession.id,
    action: "set",
    title: "Creating rejected",
    items: [{ text: "Rejected" }],
  });
  await softDeleteChatSession({ chatSessionId: creating.chatSession.id });
  await failChatSession({
    chatSessionId: creating.chatSession.id,
    failureMessage: "Expected plan E2E failure fixture",
  });
  await expectToolError({
    sessionId: creating.chatSession.id,
    action: "set",
    title: "Failed rejected",
    items: [{ text: "Rejected" }],
  });

  const deleted = await createApplicationSession();
  await deleteProductSessionAndAssertCleanup(
    deleted.id,
    deleted.trueforgeSessionId,
  );
  sessions.delete(deleted.id);
  await expectToolError({
    sessionId: deleted.id,
    action: "set",
    title: "Deleted rejected",
    items: [{ text: "Rejected" }],
  });
}

async function collectSdkEvents(sessionId, turnId) {
  const stream = await trueforge.sessions.subscribeToTurn(sessionId, turnId);
  const events = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "turn.done") break;
  }
  return events;
}

async function collectProductPlanEvents(sessionId, turnId) {
  const response = await fetch(
    `${webUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events/stream`,
    { signal: AbortSignal.timeout(330_000) },
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: plan\n"))
    .map((block) => JSON.parse(block.split("\ndata: ")[1]));
}

function proveLiveTurnEvents({
  liveEvents,
  persistedEvents,
  productPlanEvents,
  persistedPlanEvents,
  databasePlan,
  applicationSessionId,
}) {
  assert.equal(
    liveEvents.filter(({ type }) => type === "turn.done").length,
    7,
    "The live SDK stream did not complete all seven instructed turns.",
  );
  assert.equal(
    [...liveEvents, ...persistedEvents].some(
      ({ type }) => type === "tool.approval_required",
    ),
    false,
  );
  const planCalls = assembledModelMessages(persistedEvents).flatMap((event) =>
    (event.toolCalls ?? []).flatMap((call) => {
      const evidence = planCallEvidence(call);
      return evidence ? [evidence] : [];
    }),
  );
  assert.ok(
    planCalls.length >= 7,
    `Persisted TrueForge history contained only ${planCalls.length} scoped plan calls. Evidence: ${JSON.stringify(
      {
        live: eventInventory(liveEvents),
        persisted: eventInventory(persistedEvents),
        productPlanEventTypes: productPlanEvents.map(({ type }) => type),
        persistedPlanEventTypes: persistedPlanEvents.map(({ type }) => type),
        databasePlan: {
          revision: databasePlan.revision,
          title: databasePlan.plan?.title ?? null,
          statuses: databasePlan.plan?.items.map(({ status }) => status) ?? [],
        },
      },
    )}`,
  );
  const argumentsList = planCalls.map(({ argumentsValue }) => argumentsValue);
  assert.ok(argumentsList.some(({ action }) => action === "set"));
  assert.ok(argumentsList.some(({ action }) => action === "update_item"));
  assert.ok(argumentsList.some(({ status }) => status === "in_progress"));
  assert.ok(argumentsList.some(({ status }) => status === "completed"));
  assert.equal(
    argumentsList.every(({ sessionId }) => sessionId === applicationSessionId),
    true,
  );
  const callIds = new Set(planCalls.map(({ call }) => call.id));
  assert.equal(
    persistedEvents.filter(
      (event) =>
        event.type === "tool.response" && callIds.has(event.toolCallId),
    ).length,
    planCalls.length,
  );
  const livePlanCallIds = assembledModelMessages(liveEvents).flatMap((event) =>
    (event.toolCalls ?? []).flatMap((call) =>
      planCallEvidence(call) ? [call.id] : [],
    ),
  );
  assert.equal(
    livePlanCallIds.every((callId) => callIds.has(callId)),
    true,
    "The live SDK stream contained a plan call absent from persisted history.",
  );

  const optimistic = persistedPlanEvents.filter(
    ({ type }) => type === "plan.optimistic",
  );
  const reconciled = persistedPlanEvents.filter(
    ({ type }) => type === "plan.reconciled",
  );
  assert.equal(
    persistedPlanEvents.some(({ type }) => type === "plan.failed"),
    false,
  );
  assert.deepEqual(
    [...new Set(optimistic.map(({ toolCallId }) => toolCallId))].sort(),
    [...callIds].sort(),
  );
  assert.deepEqual(
    [...new Set(reconciled.map(({ toolCallId }) => toolCallId))].sort(),
    [...callIds].sort(),
  );
  assert.deepEqual(reconciled.at(-1)?.snapshot, databasePlan);
  assert.equal(
    productPlanEvents.every(({ toolCallId }) => callIds.has(toolCallId)),
    true,
    "The live product stream emitted a plan event absent from persisted history.",
  );
  assert.equal(
    productPlanEvents.some(({ type }) => type === "plan.failed"),
    false,
  );

  const serialized = JSON.stringify({ liveEvents, persistedEvents });
  assert.equal(serialized.includes(todoToken), false);
  assert.doesNotMatch(
    serialized,
    /TODO_MCP_AUTH_TOKEN|MCP_AUTH_TOKEN|sk[-]proj-/i,
  );
}

function planCallEvidence(call) {
  const parsed = parseJsonObject(call.function.arguments);
  if (
    call.toolInfo.type === "mcp" &&
    call.toolInfo.serverName === "forty-two-todo" &&
    call.toolInfo.name === "plan" &&
    isPlanArguments(parsed)
  ) {
    return { call, argumentsValue: parsed, transport: "direct" };
  }
  if (
    call.toolInfo.type !== "truefoundry-system" ||
    call.toolInfo.name !== "call_tool" ||
    !parsed ||
    Object.keys(parsed).length !== 3 ||
    Object.keys(parsed).some(
      (key) => !["mcp_server", "tool_name", "input"].includes(key),
    ) ||
    parsed.mcp_server !== "forty-two-todo" ||
    parsed.tool_name !== "plan" ||
    !isPlanArguments(parsed.input)
  ) {
    return undefined;
  }
  return { call, argumentsValue: parsed.input, transport: "wrapped" };
}

function isPlanArguments(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value.action === "set" || value.action === "update_item")
  );
}

function eventInventory(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return {
    counts,
    calls: assembledModelMessages(events).flatMap((event) =>
      (event.toolCalls ?? []).map((call) => {
        const parsed = parseJsonObject(call.function.arguments);
        const input = parseJsonObject(parsed?.input);
        return {
          id: call.id,
          toolInfoType: call.toolInfo.type,
          toolInfoName: call.toolInfo.name,
          serverName:
            call.toolInfo.type === "mcp" ? call.toolInfo.serverName : undefined,
          functionName: call.function.name,
          argumentKeys: parsed ? Object.keys(parsed).sort() : [],
          routedServer: parsed?.mcp_server,
          routedTool: parsed?.tool_name,
          inputKeys: input ? Object.keys(input).sort() : [],
          action: input?.action ?? parsed?.action,
        };
      }),
    ),
  };
}

function parseJsonObject(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function assembledModelMessages(events) {
  const messages = new Map();
  for (const event of events) {
    if (event.type === "model.message") {
      messages.set(event.id, structuredClone(event));
    } else if (event.type === "model.message.delta") {
      const message = messages.get(event.id);
      if (message) mergeEventDelta(message, event);
    }
  }
  return [...messages.values()];
}

async function runLivePlanTurn({
  sessionId,
  runtimeSessionId,
  questionKey,
  message,
  expected,
}) {
  const created = await requestProduct(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": questionKey,
      },
      body: JSON.stringify({ message }),
    },
  );
  const turnId = requiredString(created.data?.id, "turn id");
  const [sdkEvents, productPlanEvents] = await Promise.all([
    collectSdkEvents(runtimeSessionId, turnId),
    collectProductPlanEvents(sessionId, turnId),
  ]);
  const completed = await requestProduct(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/wait`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutSeconds: 300 }),
    },
  );
  assert.equal(completed.data?.state?.status, "done");
  assert.match(
    JSON.stringify(completed.data?.state?.output),
    new RegExp(expected),
  );
  const history = await requestProduct(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`,
  );
  const persistedEvents = [];
  const persistedPage = await trueforge.sessions.listTurnEvents(
    runtimeSessionId,
    turnId,
    { limit: 100, order: "asc" },
  );
  for await (const event of persistedPage) persistedEvents.push(event);
  return {
    turnId,
    sdkEvents,
    persistedEvents,
    productPlanEvents,
    persistedPlanEvents: history.planEvents,
  };
}

async function createAndWaitTurn({ sessionId, questionKey, message }) {
  const created = await requestProduct(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": questionKey,
      },
      body: JSON.stringify({ message }),
    },
  );
  const turnId = requiredString(created.data?.id, "turn id");
  const waited = await requestProduct(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/wait`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutSeconds: 300 }),
    },
  );
  assert.equal(waited.data?.state?.status, "done");
  return waited.data;
}

async function currentPlan(sessionId) {
  const response = await requestProduct(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/plan`,
  );
  return response.data;
}

async function callPlan(argumentsValue) {
  const result = await directClient.callTool({
    name: "plan",
    arguments: argumentsValue,
  });
  assert.notEqual(result.isError, true, extractToolText(result));
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

async function expectToolError(argumentsValue) {
  try {
    const result = await directClient.callTool({
      name: "plan",
      arguments: argumentsValue,
    });
    assert.equal(
      result.isError,
      true,
      "Invalid plan operation unexpectedly succeeded.",
    );
  } catch (error) {
    assert.match(String(error), /invalid|error|-32602/i);
  }
}

function extractToolText(result) {
  return result.content
    ?.filter(({ type }) => type === "text")
    .map(({ text }) => text)
    .join("\n");
}

async function requestProduct(path, init = {}) {
  const response = await fetch(`${webUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(330_000),
  });
  const body =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `Product API failed (${response.status}): ${String(body?.error?.message ?? "unknown")}`,
    );
  }
  return body;
}

async function requestTrueforge(path) {
  const response = await fetch(`${trueforgeUrl}${path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`TrueForge API failed (${response.status}).`);
  }
  return body;
}

async function assertTrueForgeSessionDeleted(runtimeSessionId) {
  const response = await fetch(
    `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(runtimeSessionId)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(
    response.status,
    404,
    `TrueForge retained deleted product session ${runtimeSessionId}.`,
  );
}

async function deleteProductSessionAndAssertCleanup(
  applicationSessionId,
  runtimeSessionId,
) {
  for (const attempt of ["initial", "idempotent retry"]) {
    const response = await fetch(
      `${webUrl}/api/chat/sessions/${encodeURIComponent(applicationSessionId)}`,
      { method: "DELETE", signal: AbortSignal.timeout(60_000) },
    );
    assert.equal(
      response.status,
      204,
      `Plan session cleanup ${attempt} returned ${response.status}.`,
    );
    const deleted = await getChatSessionForCleanup({
      chatSessionId: applicationSessionId,
    });
    assert.equal(deleted?.status, "deleted");
    assert.ok(deleted?.deletedAt);
    assert.ok(deleted?.capabilityRevokedAt);
    await assertTrueForgeSessionDeleted(runtimeSessionId);
  }
}

function requiredSecret(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}.`);
  return value;
}

function normalizedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("E2E service URLs must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}
