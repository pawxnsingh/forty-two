import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  beginSqlChangeApply,
  closeDatabase,
  completeSqlChangeApply,
  createSqlChangeSet,
  generateSqlChangeExecutionId,
  generateSqlChangeSetId,
  getChatSession,
  getChatSessionForCleanup,
  getSqlChangeSet,
  initializeDatabase,
  recordSqlChangeApproval,
} from "../packages/db/dist/index.js";
import pg from "../packages/data-source/node_modules/pg/lib/index.js";

const { Client: PgClient } = pg;

const webUrl = normalizeUrl(process.env.WEB_URL || "http://127.0.0.1:3000");
const trueforgeUrl = normalizeUrl(
  process.env.TRUEFORGE_URL || "http://127.0.0.1:8790",
);
const databaseUrl = requiredEnvironment("DATABASE_URL");
const mutationPassword = requiredEnvironment("POSTGRES_MUTATION_PASSWORD");
const nonce = `sql-approval-${Date.now()}-${process.pid}`;
let applicationSessionId;
let trueforgeSessionId;
let dataSourceId;
let target;
let targetConnected = false;
let primaryError;
const backfillColumn = `tf_copy_${Date.now()}_${process.pid}`;

try {
  initializeDatabase({
    connectionString: databaseUrl,
    maxConnections: 2,
  });
  target = new PgClient({
    host: process.env.E2E_POSTGRES_TARGET_HOST || "postgres",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "forty_two",
    user: "forty_two_mutation",
    password: mutationPassword,
  });
  await target.connect();
  targetConnected = true;
  await setTargetValue(42);

  const source = await registerControlledPostgres();
  dataSourceId = source.id;
  assert.equal(source.status, "ready");
  assert.equal(JSON.stringify(source).includes(mutationPassword), false);

  const session = await api("/api/chat/sessions", {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: { dataSourceIds: [dataSourceId] },
  });
  assert.equal(session.status, 201, JSON.stringify(session.body));
  applicationSessionId = session.body.data.id;
  const storedSession = await getChatSession({
    chatSessionId: applicationSessionId,
  });
  trueforgeSessionId = storedSession?.trueforgeSessionId;
  assert.ok(trueforgeSessionId, "SQL approval session was not activated.");

  const denied = await proposeUpdate(43);
  await assertPreparedAndUnchanged(denied, 42);
  const deniedResume = await resolveApproval(denied, "deny");
  await waitForTurn(deniedResume);
  assert.equal(await targetValue(), 42);
  const deniedRecord = await changeRecord(denied);
  assert.equal(deniedRecord.changeSet.status, "denied");
  assert.equal(deniedRecord.execution, null);
  assert.ok(deniedRecord.changeSet.approvalRecordedAt);
  assert.equal(deniedRecord.changeSet.approvalToolCallId, denied.toolCall.id);

  const allowed = await proposeUpdate(43);
  await assertPreparedAndUnchanged(allowed, 42);
  const allowedResume = await resolveApproval(allowed, "allow");
  await waitForTurn(allowedResume);
  assert.equal(await targetValue(), 43);
  const appliedRecord = await changeRecord(allowed);
  assert.equal(appliedRecord.changeSet.status, "applied");
  assert.equal(appliedRecord.execution?.outcome, "applied");
  assert.ok(appliedRecord.changeSet.approvalRecordedAt);
  assert.equal(appliedRecord.changeSet.approvalToolCallId, allowed.toolCall.id);
  assert.ok(appliedRecord.execution?.providerExecutionId);
  assert.equal(appliedRecord.execution?.actualAffectedRows, 1);
  assert.equal(appliedRecord.execution?.trueforgeTurnId, allowed.turnId);
  assert.equal(
    appliedRecord.execution?.trueforgeToolCallId,
    allowed.toolCall.id,
  );

  const replay = await resolveApproval(allowed, "allow");
  assert.equal(replay.status, 409);
  assert.equal(await targetValue(), 43);

  const backfill = await proposeBackfill(backfillColumn);
  assert.equal(await targetColumnExists(backfillColumn), false);
  await assertPendingChange(backfill);
  const backfillResume = await resolveApproval(backfill, "allow");
  await waitForTurn(backfillResume);
  assert.equal(await targetColumnExists(backfillColumn), true);
  assert.deepEqual(await targetColumnValues(backfillColumn), [44]);
  const backfillRecord = await changeRecord(backfill);
  assert.equal(backfillRecord.changeSet.status, "applied");
  assert.equal(backfillRecord.execution?.outcome, "applied");
  assert.equal(backfillRecord.execution?.actualAffectedRows, 1);
  assert.equal(backfillRecord.execution?.verification.verifiedRows, 1);
  assert.deepEqual(
    backfillRecord.execution?.verification.verifiedRowHashes,
    backfillRecord.changeSet.preconditions.rowHashes,
  );
  assert.ok(
    Array.isArray(backfillRecord.execution?.verification.verifiedSample),
  );
  await assertTerminalAuditOutcomes();

  console.log(
    "Live TrueForge SQL approval E2E passed: prepared state was unchanged, deny was inert, allow applied once, replay failed, structured backfill values were verified, provider/audit evidence correlated, terminal outcomes persisted, and direct NULL outcome writes were rejected.",
  );
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  if (target && targetConnected) {
    await target
      .query(
        `ALTER TABLE demo.metrics DROP COLUMN IF EXISTS "${backfillColumn}"`,
      )
      .catch((error) => cleanupErrors.push(error));
    await setTargetValue(42).catch((error) => cleanupErrors.push(error));
    await target.end().catch((error) => cleanupErrors.push(error));
  }
  if (applicationSessionId) {
    try {
      await deleteProductSessionAndAssertCleanup(
        applicationSessionId,
        trueforgeSessionId,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (dataSourceId) {
    try {
      const deleted = await api(`/api/data-sources/${dataSourceId}`, {
        method: "DELETE",
      });
      assert.ok(
        deleted.status === 204 || deleted.status === 404,
        JSON.stringify(deleted.body),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await closeDatabase().catch((error) => cleanupErrors.push(error));
  if (primaryError || cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      "SQL approval E2E failed or cleanup was incomplete.",
    );
  }
}

async function registerControlledPostgres() {
  const response = await api("/api/data-sources/databases", {
    method: "POST",
    body: {
      connectorType: "postgresql",
      name: `${nonce} PostgreSQL controlled`,
      mutationMode: "controlled",
      mutationAllowlist: [{ schema: "demo", table: "metrics" }],
      config: {
        host: process.env.E2E_POSTGRES_TARGET_HOST || "postgres",
        port: 5432,
        database: process.env.POSTGRES_DB || "forty_two",
        schema: "demo",
        sslMode: "disable",
      },
      credentials: {
        username: "forty_two_mutation",
        password: mutationPassword,
      },
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(JSON.stringify(response.body).includes(mutationPassword), false);
  return response.body.data;
}

async function proposeUpdate(nextValue) {
  const message = [
    `Use the scoped datasource MCP server and datasource ${dataSourceId}.`,
    "Call prepare_sql_change exactly once with operation update and SQL exactly:",
    `UPDATE demo.metrics SET value = ${nextValue} WHERE id = 1`,
    "Then immediately call apply_sql_change using the returned approval object byte-for-byte without changing or omitting any field.",
    "Calling apply_sql_change is how you request approval; it will pause before execution, so call it now rather than asking for approval in prose.",
    "Do not use Code Mode, shell, drivers, run_read_query, or any mutation path other than prepare_sql_change followed by apply_sql_change.",
    "This is one direct operation, so do not create a plan. Wait for approval and do not substitute any datasource, SQL, target, hash, or estimate.",
  ].join("\n");
  const response = await api(
    `/api/chat/sessions/${applicationSessionId}/turns`,
    { method: "POST", body: { message }, timeoutMs: 30_000 },
  );
  assert.equal(response.status, 202, JSON.stringify(response.body));
  const turnId = response.body.data.id;
  const approval = await waitForApproval(turnId);
  assert.equal(
    JSON.stringify(approval.events).includes(mutationPassword),
    false,
  );
  return { turnId, ...approval };
}

async function proposeBackfill(columnName) {
  const message = [
    `Use the scoped datasource MCP server and datasource ${dataSourceId}.`,
    "Call prepare_sql_change exactly once with operation add_and_backfill_column.",
    "Use target catalog null, schema demo, table metrics.",
    `Set columnName to ${columnName}, columnType integer, and expression exactly to {"kind":"binary","operator":"add","left":{"kind":"column","column":"value"},"right":{"kind":"literal","value":1}}.`,
    "Then immediately call apply_sql_change using the returned approval object byte-for-byte without changing or omitting any field.",
    "Calling apply_sql_change is how you request approval; do not ask in prose.",
    "Do not use shell, drivers, run_read_query, or any mutation path other than prepare_sql_change followed by apply_sql_change.",
    "This is one operation, so do not create a plan.",
  ].join("\n");
  const response = await api(
    `/api/chat/sessions/${applicationSessionId}/turns`,
    { method: "POST", body: { message }, timeoutMs: 30_000 },
  );
  assert.equal(response.status, 202, JSON.stringify(response.body));
  const turnId = response.body.data.id;
  const approval = await waitForApproval(turnId);
  assert.equal(approval.approvalArguments.operation, "add_and_backfill_column");
  assert.equal(approval.approvalArguments.target.table, "metrics");
  return { turnId, ...approval };
}

async function waitForApproval(turnId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const events = await publicTurnEvents(turnId);
    const approvalEvent = events.find(
      (event) => event.type === "approval.required",
    );
    if (approvalEvent) {
      assert.equal(
        approvalEvent.toolCalls.length,
        1,
        "Expected exactly one normalized SQL approval target.",
      );
      const callRef = approvalEvent.toolCalls[0];
      assert.deepEqual(callRef.tool, {
        kind: "mcp",
        name: "apply_sql_change",
        serverName: "forty-two-data-source",
      });
      const toolStarted = events.find(
        (event) =>
          event.type === "tool.started" &&
          event.toolCallId === callRef.toolCallId,
      );
      assert.ok(toolStarted, "Normalized approval is missing tool.started.");
      assert.equal(toolStarted.sourceMessageId, callRef.sourceMessageId);
      assert.deepEqual(toolStarted.tool, callRef.tool);
      const approvalArguments = await pendingApprovalDisplay();
      assert.match(
        approvalArguments.changeSetId,
        /^change_[0-9A-HJKMNP-TV-Z]{26}$/,
      );
      return {
        approvalEvent,
        toolCall: {
          id: callRef.toolCallId,
          sourceEventId: callRef.sourceMessageId,
          tool: callRef.tool,
        },
        approvalArguments,
        events,
      };
    }
    await delay(750);
  }
  throw new Error("Timed out waiting for a real TrueForge SQL approval event.");
}

async function assertPreparedAndUnchanged(proposal, expectedValue) {
  assert.equal(await targetValue(), expectedValue);
  await assertPendingChange(proposal);
}

async function assertPendingChange(proposal) {
  const record = await changeRecord(proposal);
  assert.equal(record.changeSet.status, "pending_approval");
  assert.equal(record.changeSet.approvalRecordedAt, null);
  assert.equal(record.execution, null);
  assert.equal(
    proposal.approvalArguments.canonicalSql,
    record.changeSet.canonicalSql,
  );
  assert.equal(
    proposal.approvalArguments.statementHash,
    record.changeSet.statementHash,
  );
  assert.equal(
    proposal.approvalArguments.expectedAffectedRows,
    record.changeSet.expectedAffectedRows,
  );
  assert.deepEqual(
    proposal.approvalArguments.resourceEstimate,
    record.changeSet.resourceEstimate,
  );
}

async function changeRecord(proposal) {
  const record = await getSqlChangeSet({
    changeSetId: proposal.approvalArguments.changeSetId,
    chatSessionId: applicationSessionId,
  });
  assert.ok(record);
  return record;
}

async function pendingApprovalDisplay() {
  const controlPlane = new PgClient({ connectionString: databaseUrl });
  await controlPlane.connect();
  try {
    const result = await controlPlane.query(
      `SELECT id
       FROM sql_change_sets
       WHERE chat_session_id = $1
         AND data_source_id = $2
         AND status = 'pending_approval'
         AND approval_recorded_at IS NULL
       ORDER BY created_at DESC
       LIMIT 2`,
      [applicationSessionId, dataSourceId],
    );
    assert.equal(
      result.rows.length,
      1,
      "Expected exactly one pending SQL change for the normalized approval.",
    );
    const record = await getSqlChangeSet({
      changeSetId: result.rows[0].id,
      chatSessionId: applicationSessionId,
    });
    assert.ok(record);
    const change = record.changeSet;
    return {
      changeSetId: change.id,
      sessionId: change.chatSessionId,
      dataSourceId: change.dataSourceId,
      connector: change.connectorType,
      operation: change.operation,
      target: {
        catalog: change.targetCatalog,
        schema: change.targetSchema,
        table: change.targetTable,
      },
      canonicalSql: change.canonicalSql,
      statementHash: change.statementHash,
      expectedAffectedRows: change.expectedAffectedRows,
      resourceEstimate: change.resourceEstimate,
    };
  } finally {
    await controlPlane.end();
  }
}

async function assertTerminalAuditOutcomes() {
  const partial = await createAuditProbeChange("partial");
  const partialExecutionId = await beginAuditProbe(partial, "partial");
  const partialResult = await completeSqlChangeApply({
    executionId: partialExecutionId,
    changeSetId: partial.id,
    outcome: "partial",
    providerExecutionId: `live-audit-partial-${nonce}`,
    actualAffectedRows: null,
    verification: {
      phase: "partial_ddl_committed",
      ddlCommitted: true,
      terminal: true,
      freshApprovalRequired: true,
    },
    errorCode: "SqlChangePartialCommitError",
  });
  assert.equal(partialResult.changeSet.status, "partial");
  assert.equal(partialResult.execution.outcome, "partial");

  const failed = await createAuditProbeChange("failed");
  const failedExecutionId = await beginAuditProbe(failed, "failed");
  const failedResult = await completeSqlChangeApply({
    executionId: failedExecutionId,
    changeSetId: failed.id,
    outcome: "failed",
    providerExecutionId: null,
    actualAffectedRows: null,
    verification: { phase: "failed", auditProbe: true },
    errorCode: "LiveAuditProbeError",
  });
  assert.equal(failedResult.changeSet.status, "failed");
  assert.equal(failedResult.execution.outcome, "failed");

  const controlPlane = new PgClient({
    connectionString: databaseUrl,
  });
  await controlPlane.connect();
  try {
    await assert.rejects(
      controlPlane.query(
        "UPDATE sql_change_executions SET outcome = NULL WHERE id = $1",
        [failedExecutionId],
      ),
      (error) => error?.constraint === "sql_change_executions_completion_check",
    );
  } finally {
    await controlPlane.end();
  }

  const storedPartial = await getSqlChangeSet({
    changeSetId: partial.id,
    chatSessionId: applicationSessionId,
  });
  const storedFailed = await getSqlChangeSet({
    changeSetId: failed.id,
    chatSessionId: applicationSessionId,
  });
  assert.equal(storedPartial?.execution?.outcome, "partial");
  assert.equal(storedFailed?.execution?.outcome, "failed");
}

async function createAuditProbeChange(outcome) {
  const partial = outcome === "partial";
  const columnName = `audit_partial_${Date.now()}_${process.pid}`;
  return createSqlChangeSet({
    id: generateSqlChangeSetId(),
    chatSessionId: applicationSessionId,
    dataSourceId,
    connectorType: "postgresql",
    sqlDialect: "postgresql",
    operation: partial ? "add_and_backfill_column" : "update",
    targetCatalog: null,
    targetSchema: "demo",
    targetTable: "metrics",
    canonicalSql: partial
      ? `ALTER TABLE demo.metrics ADD COLUMN ${columnName} integer NULL; UPDATE demo.metrics SET ${columnName} = value`
      : "UPDATE demo.metrics SET value = 999 WHERE id = 1",
    boundParameters: [],
    structuredOperation: partial
      ? {
          operation: "add_and_backfill_column",
          target: { catalog: null, schema: "demo", table: "metrics" },
          columnName,
          columnType: "integer",
          expression: { kind: "column", column: "value" },
        }
      : null,
    statementHash: (partial ? "7" : "8").repeat(64),
    preview: { before: [], after: [] },
    preconditions: partial
      ? { schemaFingerprint: "9".repeat(64) }
      : {
          selectSql: "SELECT id, value FROM demo.metrics WHERE id = 1",
          rowHashes: ["a".repeat(64)],
        },
    executionStrategy: partial
      ? {
          mode: "idempotent_implicit_commit",
          phases: ["column_added", "backfill_applied", "verified"],
        }
      : { mode: "transactional" },
    resourceEstimate: null,
    expectedAffectedRows: 1,
    credentialRevision: 1,
  });
}

async function beginAuditProbe(change, suffix) {
  const trueforgeTurnId = `${nonce}-${suffix}-turn`;
  const trueforgeToolCallId = `${nonce}-${suffix}-call`;
  await recordSqlChangeApproval({
    changeSetId: change.id,
    chatSessionId: applicationSessionId,
    trueforgeTurnId,
    trueforgeToolCallId,
    decision: "allow",
  });
  const executionId = generateSqlChangeExecutionId();
  await beginSqlChangeApply({
    changeSetId: change.id,
    chatSessionId: applicationSessionId,
    dataSourceId,
    connectorType: change.connectorType,
    operation: change.operation,
    targetCatalog: change.targetCatalog,
    targetSchema: change.targetSchema,
    targetTable: change.targetTable,
    canonicalSql: change.canonicalSql,
    statementHash: change.statementHash,
    expectedAffectedRows: change.expectedAffectedRows,
    resourceEstimate: change.resourceEstimate,
    executionId,
  });
  return executionId;
}

async function resolveApproval(proposal, decision) {
  return api(
    `/api/chat/sessions/${applicationSessionId}/turns/${proposal.turnId}/approval`,
    {
      method: "POST",
      body: {
        toolCallId: proposal.toolCall.id,
        decision,
        ...(decision === "deny" ? { reason: "E2E denial proof" } : {}),
      },
      timeoutMs: 30_000,
    },
  );
}

async function waitForTurn(response) {
  assert.equal(response.status, 202, JSON.stringify(response.body));
  const turnId = response.body.data.id;
  const waited = await api(
    `/api/chat/sessions/${applicationSessionId}/turns/${turnId}/wait`,
    {
      method: "POST",
      body: { timeoutSeconds: 180 },
      timeoutMs: 200_000,
    },
  );
  assert.equal(waited.status, 200, JSON.stringify(waited.body));
  assert.equal(
    waited.body.data.state?.status,
    "done",
    JSON.stringify(waited.body),
  );
}

async function targetValue() {
  const result = await target.query(
    "SELECT value FROM demo.metrics WHERE id = 1",
  );
  return Number(result.rows[0]?.value);
}

async function setTargetValue(value) {
  await target.query("UPDATE demo.metrics SET value = $1 WHERE id = 1", [
    value,
  ]);
}

async function targetColumnExists(columnName) {
  const result = await target.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'demo' AND table_name = 'metrics' AND column_name = $1) AS exists",
    [columnName],
  );
  return result.rows[0]?.exists === true;
}

async function targetColumnValues(columnName) {
  const result = await target.query(
    `SELECT "${columnName}" AS value FROM demo.metrics ORDER BY id`,
  );
  return result.rows.map((row) => Number(row.value));
}

async function api(
  path,
  { method = "GET", headers = {}, body, timeoutMs = 60_000 } = {},
) {
  const response = await fetch(`${webUrl}${path}`, {
    method,
    headers:
      body === undefined
        ? headers
        : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = response.status === 204 ? "" : await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
  };
}

async function publicTurnEvents(turnId) {
  const response = await api(
    `/api/chat/sessions/${applicationSessionId}/turns/${turnId}/events`,
    { timeoutMs: 30_000 },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(Array.isArray(response.body?.data));
  assert.deepEqual(response.body.data, response.body.normalizedEvents);
  assert.equal(
    response.body.data.every(
      (event) => typeof event?.type === "string" && !("event" in event),
    ),
    true,
    "Public approval history must contain normalized events only.",
  );
  return response.body.data;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertTrueForgeSessionDeleted(runtimeSessionId) {
  assert.ok(
    runtimeSessionId,
    "Missing TrueForge session id for cleanup proof.",
  );
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
  applicationId,
  runtimeSessionId,
) {
  for (const attempt of ["initial", "idempotent retry"]) {
    const deletedResponse = await api(`/api/chat/sessions/${applicationId}`, {
      method: "DELETE",
    });
    assert.equal(
      deletedResponse.status,
      204,
      `SQL approval session cleanup ${attempt} failed: ${JSON.stringify(deletedResponse.body)}`,
    );
    const deletedSession = await getChatSessionForCleanup({
      chatSessionId: applicationId,
    });
    assert.equal(deletedSession?.status, "deleted");
    assert.ok(deletedSession?.deletedAt);
    assert.ok(deletedSession?.capabilityRevokedAt);
    await assertTrueForgeSessionDeleted(runtimeSessionId);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("E2E URL must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}
