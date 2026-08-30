import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import {
  activateChatSession,
  analysisArtifactBlobBindingExists,
  closeDatabase,
  commitChartArtifact,
  commitTableArtifact,
  createChatSession,
  deriveAnalysisArtifactId,
  getAnalysisArtifact,
  initializeDatabase,
  listAnalysisArtifactsDueForCleanup,
  listAnalysisArtifactParents,
  listAnalysisArtifacts,
  markAnalysisArtifactLeaseLost,
  markAnalysisArtifactCleanupCompleted,
  migrateDatabase,
  softDeleteChatSession,
} from "../src/index.js";

function adminConnectionUrl(): URL {
  const url = process.env.DATABASE_URL
    ? new URL(process.env.DATABASE_URL)
    : new URL(
        `postgresql://${process.env.POSTGRES_USER ?? "forty_two"}:${process.env.POSTGRES_PASSWORD ?? ""}@${process.env.POSTGRES_HOST ?? "127.0.0.1"}:${process.env.POSTGRES_PORT ?? "5432"}/postgres`,
      );
  url.pathname = "/postgres";
  if (
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost" &&
    process.env.ALLOW_REMOTE_DB_INTEGRATION_TESTS !== "true"
  ) {
    throw new Error("Refusing to create an artifact test database remotely.");
  }
  return url;
}

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${sequence}`;
}

describe("analysis artifact repositories against PostgreSQL", () => {
  const databaseName = `forty_two_artifacts_test_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let firstSessionId: string;
  let secondSessionId: string;

  before(async () => {
    const adminUrl = adminConnectionUrl();
    admin = postgres(adminUrl.toString(), { max: 1 });
    await admin`create database ${admin(databaseName)}`;
    const testUrl = new URL(adminUrl);
    testUrl.pathname = `/${databaseName}`;
    sql = postgres(testUrl.toString(), { max: 1 });
    initializeDatabase({
      connectionString: testUrl.toString(),
      maxConnections: 4,
    });
    await migrateDatabase();

    for (const target of ["first", "second"]) {
      const creating = await createChatSession({
        dataSourceIds: [],
        maxDataSources: 10,
        capabilityId: unique("capability"),
        capabilityExpiresAt: new Date(Date.now() + 60_000),
      });
      const active = await activateChatSession({
        chatSessionId: creating.chatSession.id,
        trueforgeSessionId: unique("tf"),
      });
      assert.ok(active);
      if (target === "first") firstSessionId = active.id;
      else secondSessionId = active.id;
    }
  });

  after(async () => {
    await closeDatabase();
    await sql.end({ timeout: 5 });
    await admin`drop database if exists ${admin(databaseName)} with (force)`;
    await admin.end({ timeout: 5 });
  });

  async function activeSession(): Promise<string> {
    const creating = await createChatSession({
      dataSourceIds: [],
      maxDataSources: 10,
      capabilityId: unique("capability"),
      capabilityExpiresAt: new Date(Date.now() + 60_000),
    });
    const active = await activateChatSession({
      chatSessionId: creating.chatSession.id,
      trueforgeSessionId: unique("tf"),
    });
    assert.ok(active);
    return active.id;
  }

  function tableInput(input: {
    sessionId: string;
    idSeed: string;
    contentSha256: string;
    operationKey: string;
    dataSourceId?: string;
    sqlSha256?: string;
  }) {
    const artifactId = deriveAnalysisArtifactId(input.idSeed);
    return {
      artifactId,
      chatSessionId: input.sessionId,
      azureBlobName: `artifacts/${input.sessionId}/${artifactId}/table.v1.jsonl`,
      azureETag: '"etag"',
      contentSha256: input.contentSha256,
      byteSize: 42,
      rowCount: 1,
      columns: [{ name: "value", type: "integer" as const, nullable: false }],
      preview: [{ value: 1 }],
      sourceLimited: false,
      sourceMaxRows: null,
      parentArtifactIds: [],
      provenance: {
        tool: "create_query_table_artifact",
        operationKey: input.operationKey,
        dataSourceIds: input.dataSourceId ? [input.dataSourceId] : [],
        sourceReferences: [],
        ...(input.sqlSha256 ? { sqlSha256: input.sqlSha256 } : {}),
        completedAt: new Date().toISOString(),
      },
    };
  }

  it("commits idempotent table/chart metadata, enforces lineage isolation, and stores no chart rows", async () => {
    const tableHash = "a".repeat(64);
    const tableId = deriveAnalysisArtifactId(`${firstSessionId}:${tableHash}`);
    const tableInput = {
      artifactId: tableId,
      chatSessionId: firstSessionId,
      title: "Coffee",
      azureBlobName: `artifacts/${firstSessionId}/${tableId}/table.v1.jsonl`,
      azureETag: '"etag"',
      contentSha256: tableHash,
      byteSize: 100,
      rowCount: 2,
      columns: [
        { name: "Sales", type: "number" as const, nullable: false },
        { name: "Profit", type: "number" as const, nullable: false },
      ],
      preview: [
        { Sales: 225, Profit: 75 },
        { Sales: 325, Profit: 122 },
      ],
      sourceLimited: false,
      sourceMaxRows: null,
      parentArtifactIds: [],
      provenance: {
        tool: "finalize_table_artifact",
        operationKey: `emit:${tableId}`,
        dataSourceIds: [],
        sourceReferences: [],
        completedAt: new Date().toISOString(),
      },
    };
    const table = await commitTableArtifact(tableInput);
    const retry = await commitTableArtifact(tableInput);
    assert.equal(retry.id, table.id);
    assert.equal(
      await getAnalysisArtifact({
        chatSessionId: secondSessionId,
        artifactId: table.id,
      }),
      null,
    );

    const chartHash = "b".repeat(64);
    const chartId = deriveAnalysisArtifactId(`${firstSessionId}:${chartHash}`);
    const chart = await commitChartArtifact({
      artifactId: chartId,
      chatSessionId: firstSessionId,
      inputArtifactId: table.id,
      title: "Sales vs profit",
      contentSha256: chartHash,
      byteSize: 80,
      chartConfig: {
        sourceArtifactId: table.id,
        sourceContentSha256: table.contentSha256,
        config: {
          selectedChartType: "scatter",
          scatterAxis: { x: ["Sales"], y: ["Profit"] },
        },
      },
      parentArtifactIds: [],
      provenance: {
        tool: "visualize",
        operationKey: `visualize:${chartId}`,
        dataSourceIds: [],
        sourceReferences: [`artifact:${table.id}`],
        completedAt: new Date().toISOString(),
      },
    });
    assert.equal(chart.preview, null);
    assert.equal(chart.columns, null);
    assert.equal(chart.azureBlobName, null);
    assert.deepEqual(
      await listAnalysisArtifactParents({
        chatSessionId: firstSessionId,
        artifactId: chart.id,
      }),
      [table.id],
    );
    const listed = await listAnalysisArtifacts({
      chatSessionId: firstSessionId,
      limit: 1,
    });
    assert.equal(listed.artifacts.length, 1);
    assert.ok(listed.nextPageToken);

    await assert.rejects(
      commitChartArtifact({
        artifactId: deriveAnalysisArtifactId("cross-session-chart"),
        chatSessionId: secondSessionId,
        inputArtifactId: table.id,
        title: "Cross session",
        contentSha256: "c".repeat(64),
        byteSize: 20,
        chartConfig: {},
        parentArtifactIds: [],
        provenance: {
          tool: "visualize",
          operationKey: "cross-session",
          dataSourceIds: [],
          sourceReferences: [],
          completedAt: new Date().toISOString(),
        },
      }),
      /parent artifacts are unavailable/,
    );
    await assert.rejects(
      sql`update analysis_artifacts set title = 'mutated' where id = ${table.id}`,
      /immutable/,
    );

    await softDeleteChatSession({ chatSessionId: firstSessionId });
    assert.equal(
      await getAnalysisArtifact({
        chatSessionId: firstSessionId,
        artifactId: table.id,
      }),
      null,
    );
    const deleted = await sql<{ status: string; retention_expires_at: Date }[]>`
      select status, retention_expires_at
      from analysis_artifacts
      where id = ${table.id}
    `;
    assert.equal(deleted[0]?.status, "deleted");
    assert.ok(deleted[0]?.retention_expires_at > new Date());

    const due = await listAnalysisArtifactsDueForCleanup({
      now: new Date(Date.now() + 8 * 24 * 60 * 60_000),
      limit: 100,
    });
    assert.ok(due.some((artifact) => artifact.id === table.id));
    assert.equal(
      await markAnalysisArtifactCleanupCompleted({ artifactId: table.id }),
      true,
    );
    assert.equal(
      await markAnalysisArtifactCleanupCompleted({ artifactId: table.id }),
      false,
    );
    const cleaned = await sql<{ cleanup_completed_at: Date | null }[]>`
      select cleanup_completed_at
      from analysis_artifacts
      where id = ${table.id}
    `;
    assert.ok(cleaned[0]?.cleanup_completed_at instanceof Date);
  });

  it("separates equal content from query operation identity", async () => {
    const sessionId = await activeSession();
    const hash = "d".repeat(64);
    const cases = [
      tableInput({
        sessionId,
        idSeed: "same-query-request-one",
        contentSha256: hash,
        operationKey: "query:11111111-1111-4111-8111-111111111111",
        dataSourceId: "ds_01HZX000000000000000000001",
        sqlSha256: "1".repeat(64),
      }),
      tableInput({
        sessionId,
        idSeed: "same-query-request-two",
        contentSha256: hash,
        operationKey: "query:22222222-2222-4222-8222-222222222222",
        dataSourceId: "ds_01HZX000000000000000000001",
        sqlSha256: "1".repeat(64),
      }),
      tableInput({
        sessionId,
        idSeed: "different-query-same-rows",
        contentSha256: hash,
        operationKey: "query:33333333-3333-4333-8333-333333333333",
        dataSourceId: "ds_01HZX000000000000000000001",
        sqlSha256: "2".repeat(64),
      }),
      tableInput({
        sessionId,
        idSeed: "different-datasource-same-rows",
        contentSha256: hash,
        operationKey: "query:44444444-4444-4444-8444-444444444444",
        dataSourceId: "ds_01HZX000000000000000000002",
        sqlSha256: "1".repeat(64),
      }),
    ];
    const committed = await Promise.all(
      cases.map((input) => commitTableArtifact(input)),
    );
    assert.equal(new Set(committed.map((artifact) => artifact.id)).size, 4);
    assert.equal(
      new Set(committed.map((artifact) => artifact.contentSha256)).size,
      1,
    );
    assert.equal((await commitTableArtifact(cases[0]!)).id, committed[0]!.id);
  });

  it("rolls back the ready artifact when external lease ownership is lost before commit", async () => {
    const sessionId = await activeSession();
    const input = tableInput({
      sessionId,
      idSeed: "lease-lost-before-commit",
      contentSha256: "7".repeat(64),
      operationKey: "query:77777777-7777-4777-8777-777777777777",
    });
    await assert.rejects(
      commitTableArtifact(input, {
        beforeTransactionCommit: async () => {
          throw new Error("Azure artifact lease was lost");
        },
      }),
      /lease was lost/,
    );
    assert.equal(
      await getAnalysisArtifact({
        chatSessionId: sessionId,
        artifactId: input.artifactId,
      }),
      null,
    );
    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count
      from analysis_artifacts
      where id = ${input.artifactId}
    `;
    assert.equal(rows[0]?.count, 0);
  });

  it("fail-closes committed metadata after post-COMMIT lease loss", async () => {
    const sessionId = await activeSession();
    const input = tableInput({
      sessionId,
      idSeed: "post-commit-lease-loss",
      contentSha256: "8".repeat(64),
      operationKey: "query:88888888-8888-4888-8888-888888888888",
    });
    const artifact = await commitTableArtifact(input);
    assert.equal(
      await analysisArtifactBlobBindingExists({
        artifactId: artifact.id,
        azureBlobName: input.azureBlobName,
        azureETag: input.azureETag,
      }),
      true,
    );
    assert.equal(
      await analysisArtifactBlobBindingExists({
        artifactId: artifact.id,
        azureBlobName: input.azureBlobName,
        azureETag: '"wrong-etag"',
      }),
      false,
    );
    assert.equal(
      await analysisArtifactBlobBindingExists({
        artifactId: deriveAnalysisArtifactId("wrong-binding-artifact"),
        azureBlobName: input.azureBlobName,
        azureETag: input.azureETag,
      }),
      false,
    );
    assert.equal(
      await markAnalysisArtifactLeaseLost({
        artifactId: artifact.id,
        azureBlobName: input.azureBlobName,
        azureETag: '"wrong-etag"',
      }),
      false,
    );
    assert.ok(
      await getAnalysisArtifact({
        chatSessionId: sessionId,
        artifactId: artifact.id,
      }),
    );
    assert.equal(
      await markAnalysisArtifactLeaseLost({
        artifactId: artifact.id,
        azureBlobName: input.azureBlobName,
        azureETag: input.azureETag,
      }),
      true,
    );
    assert.equal(
      await getAnalysisArtifact({
        chatSessionId: sessionId,
        artifactId: artifact.id,
      }),
      null,
    );
    const rows = await sql<
      { status: string; deletedAt: Date; retentionExpiresAt: Date }[]
    >`
      select status, deleted_at as "deletedAt", retention_expires_at as "retentionExpiresAt"
      from analysis_artifacts
      where id = ${artifact.id}
    `;
    assert.equal(rows[0]?.status, "deleted");
    assert.ok(rows[0]?.deletedAt instanceof Date);
    assert.ok(rows[0]?.retentionExpiresAt instanceof Date);
  });

  it("serializes commit-before-delete and leaves no ready artifact", async () => {
    const sessionId = await activeSession();
    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => (lockAcquired = resolve));
    const release = new Promise<void>((resolve) => (releaseLock = resolve));
    const input = tableInput({
      sessionId,
      idSeed: "commit-before-delete",
      contentSha256: "e".repeat(64),
      operationKey: "query:55555555-5555-4555-8555-555555555555",
    });
    const commit = commitTableArtifact(input, {
      afterSessionLock: async () => {
        lockAcquired();
        await release;
      },
    });
    await locked;
    let deletionSettled = false;
    const deletion = softDeleteChatSession({ chatSessionId: sessionId }).then(
      (value) => {
        deletionSettled = true;
        return value;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(deletionSettled, false);
    releaseLock();
    await commit;
    assert.ok(await deletion);
    assert.equal(
      await getAnalysisArtifact({
        chatSessionId: sessionId,
        artifactId: input.artifactId,
      }),
      null,
    );
  });

  it("serializes delete-before-commit and rejects the artifact", async () => {
    const sessionId = await activeSession();
    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => (lockAcquired = resolve));
    const release = new Promise<void>((resolve) => (releaseLock = resolve));
    const deletion = softDeleteChatSession(
      { chatSessionId: sessionId },
      {
        afterSessionLock: async () => {
          lockAcquired();
          await release;
        },
      },
    );
    await locked;
    const input = tableInput({
      sessionId,
      idSeed: "delete-before-commit",
      contentSha256: "f".repeat(64),
      operationKey: "query:66666666-6666-4666-8666-666666666666",
    });
    let commitSettled = false;
    const commit = commitTableArtifact(input).finally(() => {
      commitSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(commitSettled, false);
    releaseLock();
    assert.ok(await deletion);
    await assert.rejects(commit, /session is not active/i);
  });
});
