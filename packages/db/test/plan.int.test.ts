import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import {
  ChatSessionPlanUnavailableError,
  activateChatSession,
  beginChatSessionQuestion,
  closeDatabase,
  createChatSession,
  getChatSessionPlan,
  initializeDatabase,
  migrateDatabase,
  setChatSessionPlan,
  updateChatSessionPlanItem,
} from "../src/index.js";

function adminConnectionUrl(): URL {
  const configured = process.env.DATABASE_URL;
  const url = configured
    ? new URL(configured)
    : new URL(
        `postgresql://${process.env.POSTGRES_USER ?? "forty_two"}:${process.env.POSTGRES_PASSWORD ?? ""}@${process.env.POSTGRES_HOST ?? "127.0.0.1"}:${process.env.POSTGRES_PORT ?? "5432"}/postgres`,
      );
  url.pathname = "/postgres";
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) &&
    process.env.ALLOW_REMOTE_DB_INTEGRATION_TESTS !== "true"
  ) {
    throw new Error(
      "Plan integration tests require a local PostgreSQL server.",
    );
  }
  return url;
}

describe("session plan repositories against PostgreSQL", () => {
  const databaseName = `forty_two_plan_test_${process.pid}_${Date.now()}`;
  let adminSql: postgres.Sql;
  let testSql: postgres.Sql;

  before(async () => {
    const adminUrl = adminConnectionUrl();
    adminSql = postgres(adminUrl.toString(), { max: 1 });
    await adminSql`create database ${adminSql(databaseName)}`;
    const testUrl = new URL(adminUrl);
    testUrl.pathname = `/${databaseName}`;
    testSql = postgres(testUrl.toString(), { max: 1 });
    initializeDatabase({
      connectionString: testUrl.toString(),
      maxConnections: 8,
    });
    await migrateDatabase();
  });

  after(async () => {
    await closeDatabase();
    await testSql?.end({ timeout: 5 });
    if (adminSql) {
      await adminSql`drop database if exists ${adminSql(databaseName)} with (force)`;
      await adminSql.end({ timeout: 5 });
    }
  });

  async function createActiveSession() {
    const created = await createChatSession({
      dataSourceIds: [],
      maxDataSources: 10,
      capabilityId: `plan-capability-${crypto.randomUUID()}`,
      capabilityExpiresAt: new Date(Date.now() + 60_000),
    });
    const active = await activateChatSession({
      chatSessionId: created.chatSession.id,
      trueforgeSessionId: `tf-${crypto.randomUUID()}`,
    });
    assert.ok(active);
    return active;
  }

  it("persists canonical revisions and makes identical operations no-ops", async () => {
    const session = await createActiveSession();
    const first = await setChatSessionPlan({
      chatSessionId: session.id,
      title: "Review",
      items: [{ text: "Inspect" }, { text: "Report" }],
    });
    assert.equal(first.revision, 1);
    const repeated = await setChatSessionPlan({
      chatSessionId: session.id,
      title: "Review",
      items: [{ text: "Inspect" }, { text: "Report" }],
    });
    assert.equal(repeated.revision, 1);

    const updated = await updateChatSessionPlanItem({
      chatSessionId: session.id,
      itemIndex: 0,
      status: "completed",
      summary: "Verified",
    });
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.plan?.items[0], {
      text: "Inspect",
      status: "completed",
      summary: "Verified",
    });
    const repeatedUpdate = await updateChatSessionPlanItem({
      chatSessionId: session.id,
      itemIndex: 0,
      status: "completed",
      summary: "Verified",
    });
    assert.equal(repeatedUpdate.revision, 2);
  });

  it("serializes parallel item updates without losing unrelated state", async () => {
    const session = await createActiveSession();
    await setChatSessionPlan({
      chatSessionId: session.id,
      title: "Parallel",
      items: [{ text: "One" }, { text: "Two" }],
    });
    await Promise.all([
      updateChatSessionPlanItem({
        chatSessionId: session.id,
        itemIndex: 0,
        status: "completed",
      }),
      updateChatSessionPlanItem({
        chatSessionId: session.id,
        itemIndex: 1,
        status: "failed",
        summary: "Expected failure",
      }),
    ]);
    const snapshot = await getChatSessionPlan({ chatSessionId: session.id });
    assert.equal(snapshot?.revision, 3);
    assert.deepEqual(
      snapshot?.plan?.items.map(({ status }) => status),
      ["completed", "failed"],
    );
  });

  it("resets once for each question key and rejects unavailable sessions", async () => {
    const session = await createActiveSession();
    await setChatSessionPlan({
      chatSessionId: session.id,
      title: "Old question",
      items: [{ text: "Old work" }],
    });
    const reset = await beginChatSessionQuestion({
      chatSessionId: session.id,
      questionKey: "question-one",
    });
    assert.equal(reset.reset, true);
    assert.equal(reset.plan, null);
    assert.equal(reset.revision, 2);

    await setChatSessionPlan({
      chatSessionId: session.id,
      title: "Current question",
      items: [{ text: "Current work" }],
    });
    const retry = await beginChatSessionQuestion({
      chatSessionId: session.id,
      questionKey: "question-one",
    });
    assert.equal(retry.reset, false);
    assert.equal(retry.plan?.title, "Current question");
    assert.equal(retry.revision, 3);

    const creating = await createChatSession({
      dataSourceIds: [],
      maxDataSources: 10,
      capabilityId: `creating-${crypto.randomUUID()}`,
      capabilityExpiresAt: new Date(Date.now() + 60_000),
    });
    await assert.rejects(
      setChatSessionPlan({
        chatSessionId: creating.chatSession.id,
        title: "Rejected",
        items: [{ text: "Not active" }],
      }),
      ChatSessionPlanUnavailableError,
    );
  });
});
