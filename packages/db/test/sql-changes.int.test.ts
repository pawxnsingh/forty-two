import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import {
  activateChatSession,
  beginSqlChangeApply,
  closeDatabase,
  completeSqlChangeApply,
  CompleteSqlChangeApplyInputSchema,
  createChatSession,
  createDatabaseDataSource,
  createSqlChangeSet,
  generateDataSourceId,
  generateSqlChangeExecutionId,
  generateSqlChangeSetId,
  getSqlChangeSet,
  initializeDatabase,
  migrateDatabase,
  recordSqlChangeApplyProgress,
  recordSqlChangeApproval,
  SqlChangeConflictError,
  SqlChangeReplayError,
  updateDataSourceLifecycle,
} from "../src/index.js";

const CREDENTIALS = {
  ciphertext: "c3FsLWNoYW5nZS10ZXN0LWNpcGhlcnRleHQ=",
  iv: "c3FsLWNoYW5nZS1pdg==",
  authTag: "c3FsLWNoYW5nZS10YWc=",
  encryptionVersion: 1,
} as const;

function adminConnectionUrl(): URL {
  const url = process.env.DATABASE_URL
    ? new URL(process.env.DATABASE_URL)
    : new URL("postgresql://localhost/postgres");
  if (!process.env.DATABASE_URL) {
    const password = process.env.POSTGRES_PASSWORD;
    if (!password)
      throw new Error("DATABASE_URL or POSTGRES_PASSWORD is required.");
    url.username = process.env.POSTGRES_USER ?? "forty_two";
    url.password = password;
    url.hostname = process.env.POSTGRES_HOST ?? "127.0.0.1";
    url.port = process.env.POSTGRES_PORT ?? "5432";
  }
  url.pathname = "/postgres";
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) &&
    process.env.ALLOW_REMOTE_DB_INTEGRATION_TESTS !== "true"
  ) {
    throw new Error("Refusing to create a test database on a remote host.");
  }
  return url;
}

describe("approval-gated SQL change repositories", () => {
  const databaseName = `forty_two_sql_changes_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let testDatabaseUrl: URL;

  before(async () => {
    const adminUrl = adminConnectionUrl();
    admin = postgres(adminUrl.toString(), { max: 1 });
    await admin`create database ${admin(databaseName)}`;
    testDatabaseUrl = new URL(adminUrl);
    testDatabaseUrl.pathname = `/${databaseName}`;
    initializeDatabase({
      connectionString: testDatabaseUrl.toString(),
      maxConnections: 4,
    });
    await migrateDatabase();
  });

  after(async () => {
    await closeDatabase();
    if (admin) {
      await admin`drop database if exists ${admin(databaseName)} with (force)`;
      await admin.end({ timeout: 5 });
    }
  });

  it("stores immutable approval display, resumes one implicit execution, and blocks replay", async () => {
    const context = await activeControlledContext();
    const change = await createSqlChangeSet({
      id: generateSqlChangeSetId(),
      chatSessionId: context.sessionId,
      dataSourceId: context.dataSourceId,
      connectorType: "postgresql",
      sqlDialect: "postgresql",
      operation: "add_and_backfill_column",
      targetCatalog: null,
      targetSchema: "demo",
      targetTable: "metrics",
      canonicalSql:
        'ALTER TABLE "demo"."metrics" ADD COLUMN "copy" integer NULL; UPDATE "demo"."metrics" SET "copy" = "value"',
      boundParameters: [],
      structuredOperation: {
        operation: "add_and_backfill_column",
        target: { catalog: null, schema: "demo", table: "metrics" },
        columnName: "copy",
        columnType: "integer",
        expression: { kind: "column", column: "value" },
      },
      statementHash: "a".repeat(64),
      preview: { before: [], after: [] },
      preconditions: { schemaFingerprint: "b".repeat(64) },
      executionStrategy: {
        mode: "idempotent_implicit_commit",
        phases: ["column_added", "backfill_applied", "verified"],
      },
      resourceEstimate: null,
      expectedAffectedRows: 1,
      credentialRevision: 1,
    });
    assert.equal(change.status, "pending_approval");

    await assert.rejects(
      beginSqlChangeApply({
        ...approvalInput(change, context),
        executionId: generateSqlChangeExecutionId(),
      }),
      SqlChangeConflictError,
    );
    await recordSqlChangeApproval({
      changeSetId: change.id,
      chatSessionId: context.sessionId,
      trueforgeTurnId: "turn-1",
      trueforgeToolCallId: "call-1",
      decision: "allow",
    });
    const exact = approvalInput(change, context);
    await assert.rejects(
      beginSqlChangeApply({
        ...exact,
        executionId: generateSqlChangeExecutionId(),
        canonicalSql: `${change.canonicalSql} `,
      }),
      SqlChangeConflictError,
    );

    const firstExecutionId = generateSqlChangeExecutionId();
    const begun = await beginSqlChangeApply({
      ...exact,
      executionId: firstExecutionId,
    });
    assert.equal(begun.resumed, false);
    assert.equal(begun.executionId, firstExecutionId);
    await recordSqlChangeApplyProgress({
      executionId: firstExecutionId,
      changeSetId: change.id,
      verification: { phase: "resume_required" },
      errorCode: "PROVIDER_TIMEOUT",
    });

    const resumed = await beginSqlChangeApply({
      ...exact,
      executionId: generateSqlChangeExecutionId(),
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.executionId, firstExecutionId);
    const completed = await completeSqlChangeApply({
      executionId: firstExecutionId,
      changeSetId: change.id,
      outcome: "applied",
      providerExecutionId: "provider-job-1",
      actualAffectedRows: 1,
      verification: { phase: "verified", schemaFingerprint: "c".repeat(64) },
      errorCode: null,
    });
    assert.equal(completed.changeSet.status, "applied");
    assert.equal(completed.execution.outcome, "applied");
    assert.equal(completed.execution.trueforgeTurnId, "turn-1");
    assert.equal(completed.execution.trueforgeToolCallId, "call-1");
    const direct = postgres(testDatabaseUrl.toString(), { max: 1 });
    try {
      await assert.rejects(
        direct`
          UPDATE sql_change_executions
          SET outcome = NULL
          WHERE id = ${firstExecutionId}
        `,
        /sql_change_executions_completion_check/,
      );
    } finally {
      await direct.end({ timeout: 5 });
    }
    assert.equal(
      (
        await getSqlChangeSet({
          changeSetId: change.id,
          chatSessionId: context.sessionId,
        })
      )?.changeSet.status,
      "applied",
    );
    await assert.rejects(
      beginSqlChangeApply({
        ...exact,
        executionId: generateSqlChangeExecutionId(),
      }),
      SqlChangeReplayError,
    );
  });

  it("rolls back the execution audit when the parent status write fails", async () => {
    const context = await activeControlledContext();
    const change = await createSqlChangeSet({
      id: generateSqlChangeSetId(),
      chatSessionId: context.sessionId,
      dataSourceId: context.dataSourceId,
      connectorType: "postgresql",
      sqlDialect: "postgresql",
      operation: "update",
      targetCatalog: null,
      targetSchema: "demo",
      targetTable: "metrics",
      canonicalSql: "UPDATE demo.metrics SET value = 8 WHERE id = 1",
      boundParameters: [],
      structuredOperation: null,
      statementHash: "c".repeat(64),
      preview: { before: [{ id: 1, value: 7 }], after: [{ id: 1, value: 8 }] },
      preconditions: {
        selectSql: "SELECT id, value FROM demo.metrics WHERE id = 1",
        rowHashes: ["b".repeat(64)],
      },
      executionStrategy: { mode: "transactional" },
      resourceEstimate: null,
      expectedAffectedRows: 1,
      credentialRevision: 1,
    });
    await recordSqlChangeApproval({
      changeSetId: change.id,
      chatSessionId: context.sessionId,
      trueforgeTurnId: "turn-atomic",
      trueforgeToolCallId: "call-atomic",
      decision: "allow",
    });
    const executionId = generateSqlChangeExecutionId();
    await beginSqlChangeApply({
      ...approvalInput(change, context),
      executionId,
    });

    const direct = postgres(testDatabaseUrl.toString(), { max: 1 });
    try {
      await direct.unsafe(`
        CREATE FUNCTION reject_sql_change_parent_update()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF NEW.id = TG_ARGV[0] THEN
            RAISE EXCEPTION 'forced parent audit failure';
          END IF;
          RETURN NEW;
        END
        $function$
      `);
      await direct.unsafe(`
        CREATE TRIGGER reject_sql_change_parent_update_trigger
        BEFORE UPDATE ON sql_change_sets
        FOR EACH ROW
        EXECUTE FUNCTION reject_sql_change_parent_update('${change.id}')
      `);
      await assert.rejects(
        completeSqlChangeApply({
          executionId,
          changeSetId: change.id,
          outcome: "applied",
          providerExecutionId: "provider-atomic-proof",
          actualAffectedRows: 1,
          verification: { phase: "verified" },
          errorCode: null,
        }),
        (error) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          /forced parent audit failure/.test(error.cause.message),
      );
    } finally {
      await direct.unsafe(
        "DROP TRIGGER IF EXISTS reject_sql_change_parent_update_trigger ON sql_change_sets",
      );
      await direct.unsafe(
        "DROP FUNCTION IF EXISTS reject_sql_change_parent_update()",
      );
      await direct.end({ timeout: 5 });
    }

    const rolledBack = await getSqlChangeSet({
      changeSetId: change.id,
      chatSessionId: context.sessionId,
    });
    assert.equal(rolledBack?.changeSet.status, "pending_approval");
    assert.equal(rolledBack?.execution?.outcome, null);
    assert.equal(rolledBack?.execution?.executedAt, null);
    assert.equal(rolledBack?.execution?.providerExecutionId, null);
  });

  it("persists provider-evidenced partial DDL as an explicit terminal state", async () => {
    const context = await activeControlledContext();
    const change = await createSqlChangeSet({
      id: generateSqlChangeSetId(),
      chatSessionId: context.sessionId,
      dataSourceId: context.dataSourceId,
      connectorType: "postgresql",
      sqlDialect: "postgresql",
      operation: "add_and_backfill_column",
      targetCatalog: null,
      targetSchema: "demo",
      targetTable: "metrics",
      canonicalSql:
        'ALTER TABLE "demo"."metrics" ADD COLUMN "copy" integer NULL; UPDATE "demo"."metrics" SET "copy" = "value"',
      boundParameters: [],
      structuredOperation: {
        operation: "add_and_backfill_column",
        target: { catalog: null, schema: "demo", table: "metrics" },
        columnName: "copy",
        columnType: "integer",
        expression: { kind: "column", column: "value" },
      },
      statementHash: "d".repeat(64),
      preview: { before: [], after: [] },
      preconditions: { schemaFingerprint: "e".repeat(64) },
      executionStrategy: {
        mode: "idempotent_implicit_commit",
        phases: ["column_added", "backfill_applied", "verified"],
      },
      resourceEstimate: null,
      expectedAffectedRows: 1,
      credentialRevision: 1,
    });
    await recordSqlChangeApproval({
      changeSetId: change.id,
      chatSessionId: context.sessionId,
      trueforgeTurnId: "turn-partial",
      trueforgeToolCallId: "call-partial",
      decision: "allow",
    });
    const executionId = generateSqlChangeExecutionId();
    await beginSqlChangeApply({
      ...approvalInput(change, context),
      executionId,
    });
    for (const invalid of [
      {
        providerExecutionId: null,
        verification: {},
        errorCode: null,
      },
      {
        providerExecutionId: "mysql:provider-ddl-token",
        verification: {
          phase: "partial_ddl_committed",
          ddlCommitted: true,
          resumable: true,
          freshApprovalRequired: true,
          terminal: true,
        },
        errorCode: "SqlChangePartialCommitError",
      },
      {
        providerExecutionId: "mysql:provider-ddl-token",
        verification: {
          phase: "partial_ddl_committed",
          ddlCommitted: true,
          terminal: true,
          freshApprovalRequired: true,
        },
        errorCode: "OTHER_ERROR",
      },
    ]) {
      assert.equal(
        CompleteSqlChangeApplyInputSchema.safeParse({
          executionId,
          changeSetId: change.id,
          outcome: "partial",
          providerExecutionId: invalid.providerExecutionId,
          actualAffectedRows: null,
          verification: invalid.verification,
          errorCode: invalid.errorCode,
        }).success,
        false,
      );
    }

    const direct = postgres(testDatabaseUrl.toString(), { max: 1 });
    try {
      await assert.rejects(
        direct`
          UPDATE sql_change_executions
          SET outcome = 'partial',
              provider_execution_id = NULL,
              actual_affected_rows = NULL,
              verification = '{}'::jsonb,
              error_code = NULL,
              executed_at = CURRENT_TIMESTAMP
          WHERE id = ${executionId}
        `,
        /sql_change_executions_partial_evidence_check/,
      );
    } finally {
      await direct.end({ timeout: 5 });
    }
    const partial = await completeSqlChangeApply({
      executionId,
      changeSetId: change.id,
      outcome: "partial",
      providerExecutionId: "mysql:provider-ddl-token",
      actualAffectedRows: null,
      verification: {
        phase: "partial_ddl_committed",
        ddlCommitted: true,
        terminal: true,
        freshApprovalRequired: true,
      },
      errorCode: "SqlChangePartialCommitError",
    });
    assert.equal(partial.changeSet.status, "partial");
    assert.equal(partial.execution.outcome, "partial");
    assert.equal(
      partial.execution.providerExecutionId,
      "mysql:provider-ddl-token",
    );
    assert.equal(partial.execution.verification.ddlCommitted, true);
    await assert.rejects(
      beginSqlChangeApply({
        ...approvalInput(change, context),
        executionId: generateSqlChangeExecutionId(),
      }),
      SqlChangeReplayError,
    );
  });

  it("expires an in-progress execution instead of resuming after the approval window", async () => {
    const context = await activeControlledContext();
    const change = await createSqlChangeSet({
      id: generateSqlChangeSetId(),
      chatSessionId: context.sessionId,
      dataSourceId: context.dataSourceId,
      connectorType: "postgresql",
      sqlDialect: "postgresql",
      operation: "update",
      targetCatalog: null,
      targetSchema: "demo",
      targetTable: "metrics",
      canonicalSql: "UPDATE demo.metrics SET value = 7 WHERE id = 1",
      boundParameters: [],
      structuredOperation: null,
      statementHash: "f".repeat(64),
      preview: { before: [{ id: 1, value: 6 }], after: [{ id: 1, value: 7 }] },
      preconditions: {
        selectSql: "SELECT id, value FROM demo.metrics WHERE id = 1",
        rowHashes: ["a".repeat(64)],
      },
      executionStrategy: { mode: "transactional" },
      resourceEstimate: null,
      expectedAffectedRows: 1,
      credentialRevision: 1,
    });
    await recordSqlChangeApproval({
      changeSetId: change.id,
      chatSessionId: context.sessionId,
      trueforgeTurnId: "turn-expiry",
      trueforgeToolCallId: "call-expiry",
      decision: "allow",
    });
    const executionId = generateSqlChangeExecutionId();
    const first = await beginSqlChangeApply({
      ...approvalInput(change, context),
      executionId,
    });
    assert.equal(first.resumed, false);

    const direct = postgres(testDatabaseUrl.toString(), { max: 1 });
    try {
      await direct`
        UPDATE sql_change_sets
        SET created_at = CURRENT_TIMESTAMP - interval '11 minutes',
            expires_at = CURRENT_TIMESTAMP - interval '1 minute',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${change.id}
      `;
    } finally {
      await direct.end({ timeout: 5 });
    }

    await assert.rejects(
      beginSqlChangeApply({
        ...approvalInput(change, context),
        executionId: generateSqlChangeExecutionId(),
      }),
      (error) =>
        error instanceof SqlChangeConflictError &&
        /expired/i.test(error.message),
    );
    const stored = await getSqlChangeSet({
      changeSetId: change.id,
      chatSessionId: context.sessionId,
    });
    assert.equal(stored?.changeSet.status, "expired");
    assert.equal(stored?.execution?.id, executionId);
    assert.equal(stored?.execution?.executedAt, null);
  });

  it("backfills only authoritative legacy outcomes and rejects ambiguous evidence", async () => {
    const context = await activeControlledContext();
    const change = await createSqlChangeSet({
      id: generateSqlChangeSetId(),
      chatSessionId: context.sessionId,
      dataSourceId: context.dataSourceId,
      connectorType: "postgresql",
      sqlDialect: "postgresql",
      operation: "update",
      targetCatalog: null,
      targetSchema: "demo",
      targetTable: "metrics",
      canonicalSql: "UPDATE demo.metrics SET value = 9 WHERE id = 1",
      boundParameters: [],
      structuredOperation: null,
      statementHash: "1".repeat(64),
      preview: { before: [], after: [] },
      preconditions: {
        selectSql: "SELECT id, value FROM demo.metrics WHERE id = 1",
        rowHashes: ["2".repeat(64)],
      },
      executionStrategy: { mode: "transactional" },
      resourceEstimate: null,
      expectedAffectedRows: 1,
      credentialRevision: 1,
    });
    await recordSqlChangeApproval({
      changeSetId: change.id,
      chatSessionId: context.sessionId,
      trueforgeTurnId: "turn-migration",
      trueforgeToolCallId: "call-migration",
      decision: "allow",
    });
    const executionId = generateSqlChangeExecutionId();
    await beginSqlChangeApply({
      ...approvalInput(change, context),
      executionId,
    });
    await completeSqlChangeApply({
      executionId,
      changeSetId: change.id,
      outcome: "failed",
      providerExecutionId: null,
      actualAffectedRows: null,
      verification: { phase: "failed" },
      errorCode: "LegacyFailure",
    });

    const direct = postgres(testDatabaseUrl.toString(), { max: 1 });
    const migrationSql = await readFile(
      new URL("../drizzle/0012_shiny_killer_shrike.sql", import.meta.url),
      "utf8",
    );
    try {
      await direct.unsafe(`
        ALTER TABLE sql_change_executions
        DROP CONSTRAINT sql_change_executions_completion_check;
        ALTER TABLE sql_change_executions
        ADD CONSTRAINT sql_change_executions_completion_check CHECK (
          (executed_at IS NULL AND outcome IS NULL AND actual_affected_rows IS NULL AND provider_execution_id IS NULL)
          OR (executed_at IS NOT NULL AND executed_at >= started_at
            AND outcome IN ('applied', 'stale', 'partial', 'failed'))
        );
        UPDATE sql_change_executions
        SET outcome = NULL, error_code = NULL
        WHERE id = '${executionId}'
      `);
      await assert.rejects(
        direct.unsafe(migrationSql),
        /Cannot infer SQL execution outcome from authoritative status and provider evidence/,
      );
      const ambiguous = await direct`
        SELECT outcome
        FROM sql_change_executions
        WHERE id = ${executionId}
      `;
      assert.equal(ambiguous[0]?.outcome, null);

      await direct`
        UPDATE sql_change_executions
        SET error_code = 'LegacyFailure',
            verification = '{"phase":"failed"}'::jsonb
        WHERE id = ${executionId}
      `;
      await direct.unsafe(migrationSql);
      const repaired = await direct`
        SELECT outcome
        FROM sql_change_executions
        WHERE id = ${executionId}
      `;
      assert.equal(repaired[0]?.outcome, "failed");
    } finally {
      await direct.end({ timeout: 5 });
    }
  });

  it("rejects mutation-disabled datasource state before persistence", async () => {
    const dataSourceId = generateDataSourceId();
    await createDatabaseDataSource({
      dataSourceId,
      connectorType: "postgresql",
      name: "disabled source",
      config: {
        host: "database.invalid",
        database: "analytics",
        sslMode: "require",
        mutationMode: "disabled",
      },
      credentials: CREDENTIALS,
    });
    await updateDataSourceLifecycle({
      dataSourceId,
      fromStatus: "testing",
      toStatus: "ready",
    });
    const session = await createChatSession({
      dataSourceIds: [dataSourceId],
      maxDataSources: 1,
      capabilityId: `cap-disabled-${Date.now()}`,
      capabilityExpiresAt: new Date(Date.now() + 60_000),
    });
    await activateChatSession({
      chatSessionId: session.chatSession.id,
      trueforgeSessionId: `tf-disabled-${Date.now()}`,
    });
    await assert.rejects(
      createSqlChangeSet({
        id: generateSqlChangeSetId(),
        chatSessionId: session.chatSession.id,
        dataSourceId,
        connectorType: "postgresql",
        sqlDialect: "postgresql",
        operation: "update",
        targetCatalog: null,
        targetSchema: "demo",
        targetTable: "metrics",
        canonicalSql: "UPDATE demo.metrics SET value = 7 WHERE id = 1",
        boundParameters: [],
        structuredOperation: null,
        statementHash: "d".repeat(64),
        preview: { before: [], after: [] },
        preconditions: { selectSql: "SELECT * FROM demo.metrics WHERE id = 1" },
        executionStrategy: { mode: "transaction" },
        resourceEstimate: null,
        expectedAffectedRows: 1,
        credentialRevision: 1,
      }),
      SqlChangeConflictError,
    );
  });

  it("rejects a controlled target outside the stored table allowlist", async () => {
    const context = await activeControlledContext();
    await assert.rejects(
      createSqlChangeSet({
        id: generateSqlChangeSetId(),
        chatSessionId: context.sessionId,
        dataSourceId: context.dataSourceId,
        connectorType: "postgresql",
        sqlDialect: "postgresql",
        operation: "update",
        targetCatalog: null,
        targetSchema: "demo",
        targetTable: "unrelated_table",
        canonicalSql: "UPDATE demo.unrelated_table SET value = 7 WHERE id = 1",
        boundParameters: [],
        structuredOperation: null,
        statementHash: "e".repeat(64),
        preview: { before: [], after: [] },
        preconditions: {
          selectSql: "SELECT * FROM demo.unrelated_table WHERE id = 1",
        },
        executionStrategy: { mode: "transaction" },
        resourceEstimate: null,
        expectedAffectedRows: 1,
        credentialRevision: 1,
      }),
      SqlChangeConflictError,
    );
  });
});

async function activeControlledContext() {
  const dataSourceId = generateDataSourceId();
  await createDatabaseDataSource({
    dataSourceId,
    connectorType: "postgresql",
    name: "controlled source",
    config: {
      host: "database.invalid",
      database: "analytics",
      schema: "demo",
      sslMode: "require",
      mutationMode: "controlled",
      mutationAllowlist: [{ schema: "demo", table: "metrics" }],
    },
    credentials: CREDENTIALS,
  });
  await updateDataSourceLifecycle({
    dataSourceId,
    fromStatus: "testing",
    toStatus: "ready",
  });
  const session = await createChatSession({
    dataSourceIds: [dataSourceId],
    maxDataSources: 1,
    capabilityId: `cap-${Date.now()}`,
    capabilityExpiresAt: new Date(Date.now() + 60_000),
  });
  await activateChatSession({
    chatSessionId: session.chatSession.id,
    trueforgeSessionId: `tf-${Date.now()}`,
  });
  return { dataSourceId, sessionId: session.chatSession.id };
}

function approvalInput(
  change: Awaited<ReturnType<typeof createSqlChangeSet>>,
  context: Awaited<ReturnType<typeof activeControlledContext>>,
) {
  return {
    changeSetId: change.id,
    chatSessionId: context.sessionId,
    dataSourceId: context.dataSourceId,
    connectorType: change.connectorType,
    operation: change.operation,
    targetCatalog: change.targetCatalog,
    targetSchema: change.targetSchema,
    targetTable: change.targetTable,
    canonicalSql: change.canonicalSql,
    statementHash: change.statementHash,
    expectedAffectedRows: change.expectedAffectedRows,
    resourceEstimate: change.resourceEstimate,
  };
}
