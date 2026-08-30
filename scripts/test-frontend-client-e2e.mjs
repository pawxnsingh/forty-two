import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { parseCanonicalTableV1 } from "../packages/artifacts/dist/index.js";
import { ChartArtifactEnvelopeV1Schema } from "../packages/charting/dist/server/artifact-contracts.js";
import {
  closeDatabase,
  getChatSessionForCleanup,
  initializeDatabase,
} from "../packages/db/dist/index.js";
import pg from "../packages/data-source/node_modules/pg/lib/index.js";
import {
  assertSafeNormalizedEvents,
  createFrontendClient,
  reconcileFrontendHistory,
  reduceFrontendEvents,
  validateCanonicalTableDownload,
  validateChartEnvelope,
  validateTableDetail,
} from "./lib/frontend-client-contract.mjs";

const webUrl = normalizedUrl(process.env.WEB_URL ?? "http://127.0.0.1:3000");
const trueforgeUrl = normalizedUrl(
  process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790",
);
const nonce = `frontend-client-${Date.now()}-${process.pid}`;
const client = createFrontendClient({ baseUrl: webUrl });
const { Client: PgClient } = pg;
let sessionId;
let runtimeSessionId;
let dataSourceId;
let capability;
let target;
let targetConnected = false;
let audit;
let auditConnected = false;
let primaryError;
const cleanupEvidence = [];

try {
  initializeDatabase({
    connectionString: requiredEnvironment("DATABASE_URL"),
    maxConnections: 2,
  });
  target = new PgClient({
    host: process.env.E2E_POSTGRES_TARGET_HOST || "postgres",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "forty_two",
    user: "forty_two_mutation",
    password: requiredEnvironment("POSTGRES_MUTATION_PASSWORD"),
  });
  await target.connect();
  targetConnected = true;
  await setTargetValue(42);
  audit = new PgClient({
    connectionString: requiredEnvironment("DATABASE_URL"),
  });
  await audit.connect();
  auditConnected = true;
  dataSourceId = await registerPostgres();
  const session = await client.createSession(
    [dataSourceId],
    `${nonce}-session`,
  );
  sessionId = session.id;
  capability = session.artifactCapability;
  const stored = await getChatSessionForCleanup({ chatSessionId: sessionId });
  runtimeSessionId = stored?.trueforgeSessionId;
  assert.ok(
    runtimeSessionId,
    "The product session did not bind a runtime session.",
  );

  await assertPublishedSnapshotSession();
  const requestId = randomUUID();
  const title = `Hackathon browser chart ${nonce}`;
  const turn = await client.submitTurn(
    sessionId,
    livePrompt({ dataSourceId, requestId, title }),
    `${nonce}-turn`,
  );
  const streamed = await client.consumeTurnStream(sessionId, turn.id, {
    disconnectAfterEvents: 3,
    maxReconnects: 3,
    timeoutMs: 330_000,
  });
  assert.ok(
    streamed.reconnects >= 1,
    "The browser reconnect path was not exercised.",
  );
  assert.match(streamed.lastEventId ?? "", /^\d+:\d+$/);
  assertSafeNormalizedEvents(streamed.events);

  const liveState = reduceFrontendEvents(streamed.events);
  assert.equal(
    liveState.turn.status,
    "completed",
    JSON.stringify(liveState.turn),
  );
  assert.ok(liveState.assistant.order.length > 0);
  assert.ok(Object.keys(liveState.tools).length > 0);

  const history = await client.getTurnHistory(sessionId, turn.id);
  const reloadedState = reconcileFrontendHistory(
    liveState,
    history.normalizedEvents,
  );
  assert.equal(reloadedState.turn.status, "completed");

  const plan = await client.getPlan(sessionId);
  assert.ok(plan.data.revision >= 1, JSON.stringify(plan));
  assert.ok(
    plan.data.plan,
    "The live multi-stage flow did not persist a plan.",
  );
  assert.ok(
    plan.data.plan.items.every(({ status }) =>
      ["completed", "skipped"].includes(status),
    ),
    JSON.stringify(plan.data.plan),
  );

  const artifactList = await client.listArtifacts(sessionId, capability);
  const summaries = artifactList.data.artifacts;
  const tableSummary = summaries.find(({ kind }) => kind === "table");
  const chartSummary = summaries.find(({ kind }) => kind === "chart");
  assert.ok(tableSummary, JSON.stringify(artifactList));
  assert.ok(chartSummary, JSON.stringify(artifactList));

  const table = validateTableDetail(
    (await client.getArtifact(sessionId, tableSummary.id, capability)).data,
  );
  const downloaded = await client.downloadArtifact(
    sessionId,
    tableSummary.id,
    capability,
  );
  const rows = validateCanonicalTableDownload(downloaded.bytes, table);
  const parsedTable = parseCanonicalTableV1(downloaded.bytes, {
    contentSha256: table.contentSha256,
    byteSize: table.byteSize,
    rowCount: table.rowCount,
    columns: table.columns,
  });
  assert.deepEqual(parsedTable.rows, rows);
  assert.equal(table.sourceLimited, false);

  const chart = validateChartEnvelope(
    (await client.getArtifact(sessionId, chartSummary.id, capability)).data,
  );
  assert.equal(
    ChartArtifactEnvelopeV1Schema.safeParse(chart).success,
    true,
    JSON.stringify(chart),
  );
  assert.equal(chart.sourceArtifactId, table.id);
  assert.equal(chart.sourceContentSha256, table.contentSha256);

  const artifactEvents = history.normalizedEvents.filter(
    ({ type }) => type === "artifact.created",
  );
  assert.ok(
    artifactEvents.some(({ artifact }) => artifact.id === table.id),
    "Normalized history omitted the committed table receipt.",
  );
  assert.ok(
    artifactEvents.some(({ artifact }) => artifact.id === chart.id),
    "Normalized history omitted the committed chart receipt.",
  );

  const sessions = await client.listSessions({ limit: 25 });
  assert.ok(sessions.data.some(({ id }) => id === sessionId));
  const turns = await client.listTurns(sessionId, { limit: 25 });
  assert.ok(turns.data.some(({ id }) => id === turn.id));
  assert.equal(
    (await client.getTurn(sessionId, turn.id)).data.sessionId,
    sessionId,
  );
  await exerciseBrowserApprovals();

  console.log(
    `Frontend client live flow passed before cleanup (session=${sessionId}, turn=${turn.id}, reconnects=${streamed.reconnects}, normalizedEvents=${history.normalizedEvents.length}, table=${table.id}/${table.rowCount} rows, chart=${chart.id}).`,
  );
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  if (target && targetConnected) {
    await setTargetValue(42).catch((error) => cleanupErrors.push(error));
    await target.end().catch((error) => cleanupErrors.push(error));
    cleanupEvidence.push("demo.metrics value restored to 42");
  }
  if (audit && auditConnected) {
    await audit.end().catch((error) => cleanupErrors.push(error));
  }
  if (sessionId) {
    try {
      const status = await client.deleteSession(sessionId, {
        acceptMissing: false,
      });
      assert.equal(status, 204);
      cleanupEvidence.push(`product session ${sessionId} deleted`);
      const stored = await getChatSessionForCleanup({
        chatSessionId: sessionId,
      });
      assert.equal(stored?.status, "deleted");
      assert.ok(stored?.capabilityRevokedAt);
      cleanupEvidence.push("artifact browser capability revoked");
      const publicReload = await fetch(
        `${webUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      assert.equal(publicReload.status, 404);
      if (capability) {
        const artifactReload = await fetch(
          `${webUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}/artifacts`,
          {
            headers: { authorization: `Bearer ${capability}` },
            signal: AbortSignal.timeout(30_000),
          },
        );
        assert.equal(artifactReload.status, 404);
      }
      if (runtimeSessionId) {
        const runtimeReload = await fetch(
          `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(runtimeSessionId)}`,
          { signal: AbortSignal.timeout(30_000) },
        );
        assert.equal(runtimeReload.status, 404);
        cleanupEvidence.push(`runtime session ${runtimeSessionId} deleted`);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (dataSourceId) {
    try {
      const response = await productApi(`/api/data-sources/${dataSourceId}`, {
        method: "DELETE",
      });
      assert.ok(response.status === 204 || response.status === 404);
      const reload = await productApi(`/api/data-sources/${dataSourceId}`, {
        accept404: true,
      });
      assert.equal(reload.status, 404);
      cleanupEvidence.push(`datasource ${dataSourceId} deleted`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await closeDatabase().catch((error) => cleanupErrors.push(error));
  if (cleanupEvidence.length > 0) {
    console.log(
      `Frontend client cleanup evidence: ${cleanupEvidence.join("; ")}.`,
    );
  }
  if (primaryError || cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      "Frontend client live flow failed or cleanup was incomplete.",
    );
  }
}

async function registerPostgres() {
  const response = await productApi("/api/data-sources/databases", {
    method: "POST",
    body: {
      connectorType: "postgresql",
      name: `${nonce} PostgreSQL`,
      mutationMode: "controlled",
      mutationAllowlist: [{ schema: "demo", table: "metrics" }],
      config: {
        host: process.env.E2E_POSTGRES_TARGET_HOST || "postgres",
        port: Number(process.env.POSTGRES_PORT || 5432),
        database: process.env.POSTGRES_DB || "forty_two",
        schema: "demo",
        sslMode: "disable",
      },
      credentials: {
        username: "forty_two_mutation",
        password: requiredEnvironment("POSTGRES_MUTATION_PASSWORD"),
      },
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.status, "ready");
  assert.equal(
    JSON.stringify(response.body).includes(
      requiredEnvironment("POSTGRES_MUTATION_PASSWORD"),
    ),
    false,
  );
  return response.body.data.id;
}

async function exerciseBrowserApprovals() {
  const denied = await proposeUpdate(43, "deny");
  const deniedResume = await client.resolveApproval(sessionId, denied.turn.id, {
    toolCallId: denied.toolCallId,
    decision: "deny",
    reason: "Frontend acceptance denial",
  });
  await assertResolvedApprovalTurn(deniedResume.id);
  assert.deepEqual(await approvalAudit(denied.toolCallId), {
    status: "denied",
    outcome: null,
    actualAffectedRows: null,
  });

  const allowed = await proposeUpdate(43, "allow");
  const allowedResume = await client.resolveApproval(
    sessionId,
    allowed.turn.id,
    {
      toolCallId: allowed.toolCallId,
      decision: "allow",
    },
  );
  await assertResolvedApprovalTurn(allowedResume.id);
  assert.deepEqual(await approvalAudit(allowed.toolCallId), {
    status: "applied",
    outcome: "applied",
    actualAffectedRows: 1,
  });

  await assert.rejects(
    client.resolveApproval(sessionId, allowed.turn.id, {
      toolCallId: allowed.toolCallId,
      decision: "allow",
    }),
    /failed \(409\)/,
  );
  assert.deepEqual(await approvalAudit(allowed.toolCallId), {
    status: "applied",
    outcome: "applied",
    actualAffectedRows: 1,
  });
  cleanupEvidence.push("live SQL deny/allow/replay contract verified");
}

async function proposeUpdate(nextValue, decisionLabel) {
  const turn = await client.submitTurn(
    sessionId,
    [
      `Use the scoped datasource MCP server and datasource ${dataSourceId}.`,
      "Call prepare_sql_change exactly once with operation update and SQL exactly:",
      `UPDATE demo.metrics SET value = ${nextValue} WHERE id = 1`,
      "Then immediately call apply_sql_change using the returned approval object byte-for-byte without changing or omitting any field.",
      "Calling apply_sql_change is how you request approval; it will pause before execution, so call it now rather than asking for approval in prose.",
      "Do not use Code Mode, shell, drivers, run_read_query, or any mutation path other than prepare_sql_change followed by apply_sql_change.",
      `This is the frontend ${decisionLabel} probe. Do not create a plan and do not expose tool arguments, results, SQL change internals, reasoning, secrets, or URLs.`,
    ].join("\n"),
    `${nonce}-approval-${decisionLabel}`,
  );
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const history = await client.getTurnHistory(sessionId, turn.id);
    const approval = history.normalizedEvents.find(
      ({ type }) => type === "approval.required",
    );
    if (approval) {
      assert.equal(approval.toolCalls.length, 1);
      assert.equal(approval.toolCalls[0].tool?.name, "apply_sql_change");
      assert.equal(
        approval.toolCalls[0].tool?.serverName,
        "forty-two-data-source",
      );
      const state = reduceFrontendEvents(history.normalizedEvents);
      assert.equal(state.approval?.status, "pending");
      return { turn, toolCallId: approval.toolCalls[0].toolCallId };
    }
    await delay(750);
  }
  throw new Error(`Timed out waiting for the live ${decisionLabel} approval.`);
}

async function assertResolvedApprovalTurn(turnId) {
  const waited = await client.waitTurn(sessionId, turnId, 180);
  assert.equal(waited.data.state?.status, "done", JSON.stringify(waited));
  const history = await client.getTurnHistory(sessionId, turnId);
  assert.equal(
    reduceFrontendEvents(history.normalizedEvents).turn.status,
    "completed",
  );
}

async function approvalAudit(toolCallId) {
  const result = await audit.query(
    `SELECT c.status,
            e.outcome,
            e.actual_affected_rows AS "actualAffectedRows"
       FROM sql_change_sets c
       LEFT JOIN sql_change_executions e ON e.change_set_id = c.id
      WHERE c.chat_session_id = $1
        AND c.approval_tool_call_id = $2`,
    [sessionId, toolCallId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function setTargetValue(value) {
  await target.query("UPDATE demo.metrics SET value = $1 WHERE id = 1", [
    value,
  ]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertPublishedSnapshotSession() {
  const session = await client.getSession(sessionId);
  assert.equal(session.data.id, sessionId);
  assert.equal(session.data.agent?.type, "inline");
  const spec = session.data.agent?.spec;
  assert.match(
    spec?.instructions ?? "",
    /from forty_two_artifacts import emit_table, load_table, visualize/,
  );
  assert.equal(spec?.skills, undefined);
  const servers = spec?.mcp_servers ?? spec?.mcpServers;
  assert.equal(
    servers?.filter(({ name }) => name === "forty-two-data-source").length,
    1,
  );
  assert.equal(JSON.stringify(session).includes(runtimeSessionId), false);
  assert.doesNotMatch(
    JSON.stringify(session),
    /DAYTONA_API_KEY|MCP_AUTH_TOKEN|POSTGRES_READER_PASSWORD|sk[-]proj-/i,
  );
}

function livePrompt({ dataSourceId: sourceId, requestId, title }) {
  return [
    "Run this exact hackathon acceptance workflow and finish every stage; do not ask questions.",
    `Use the bound PostgreSQL datasource ${sourceId} and the exact application session ID from session context.`,
    "1. Set one plan titled Browser client acceptance with exactly three pending items: Commit table, Build chart, Verify result. Keep it current and complete every item.",
    "2. Call create_query_table_artifact exactly once with SQL exactly `SELECT id, value FROM demo.metrics ORDER BY id`, maxRows 100, and this requestId:",
    requestId,
    "Require a non-limited committed table receipt. create_query_table_artifact commits its table directly, so do not call finalize_table_artifact for this query artifact. Never print or place complete rows in a model message, plan, tool argument, or final answer.",
    "3. In Daytona Code Mode, import `visualize` only from the snapshot-installed `forty_two_artifacts` module; do not upload, recreate, or modify the helper. Call `visualize` on that already-committed query table using a scatter chart with id on x and value on y, the exact application session ID, and this title:",
    title,
    "Pass the returned bounded no-row receipt unchanged to finalize_chart_artifact. Do not call any MCP tool named visualize.",
    "4. Verify the query table commit and chart finalization, complete the plan, and answer with only the two committed artifact_ref tags. Never include raw rows, tool arguments/results, reasoning, credentials, URLs, SAS tokens, or bytes.",
  ].join("\n");
}

async function productApi(
  path,
  { method = "GET", body, accept404 = false, timeoutMs = 60_000 } = {},
) {
  const response = await fetch(`${webUrl}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = response.status === 204 ? "" : await response.text();
  if (!response.ok && !(accept404 && response.status === 404)) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function normalizedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Service URL must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
