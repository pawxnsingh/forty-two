import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import {
  ChatSessionDataSourceLimitError,
  ChatSessionDataSourceUnavailableError,
  ChatSessionIdempotencyConflictError,
  ChatTurnRequestConflictError,
  activateChatSession,
  authorizeChatSessionCapability,
  closeDatabase,
  completeChatTurnRequest,
  completeFileDataSourceUpload,
  createChatSession,
  createFileDataSource,
  createPostgresqlDataSource,
  failChatSession,
  generateDataSourceId,
  getChatSession,
  getChatSessionByIdempotencyKey,
  getChatSessionForCleanup,
  getChatTurnRequest,
  initializeDatabase,
  listChatSessionDataSourceBindings,
  listChatSessionDataSourceIds,
  listChatSessionDataSources,
  migrateDatabase,
  markChatTurnRequestIndeterminate,
  revokeChatSessionCapability,
  reserveChatTurnRequest,
  softDeleteChatSession,
  updateDataSourceLifecycle,
  type ChatSession,
  type DataSource,
} from "../src/index.js";

const SYNTHETIC_CREDENTIALS = {
  ciphertext: "c2Vzc2lvbi10ZXN0LWNpcGhlcnRleHQ=",
  iv: "c2Vzc2lvbi10ZXN0LWl2",
  authTag: "c2Vzc2lvbi10ZXN0LXRhZw==",
  encryptionVersion: 1,
} as const;

let sequence = 0;

function nextValue(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${sequence}`;
}

function futureExpiry(): Date {
  return new Date(Date.now() + 60_000);
}

function adminConnectionUrl(): URL {
  let url: URL;

  if (process.env.DATABASE_URL) {
    url = new URL(process.env.DATABASE_URL);
    url.pathname = "/postgres";
  } else {
    const username = process.env.POSTGRES_USER ?? "forty_two";
    const password = process.env.POSTGRES_PASSWORD;
    const databaseHost = process.env.POSTGRES_HOST ?? "127.0.0.1";
    const databasePort = process.env.POSTGRES_PORT ?? "5432";

    if (!password) {
      throw new Error(
        "Real PostgreSQL integration tests require DATABASE_URL or POSTGRES_PASSWORD.",
      );
    }

    url = new URL("postgresql://localhost/postgres");
    url.username = username;
    url.password = password;
    url.hostname = databaseHost;
    url.port = databasePort;
  }

  const isLocalHost =
    url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    !isLocalHost &&
    process.env.ALLOW_REMOTE_DB_INTEGRATION_TESTS !== "true"
  ) {
    throw new Error(
      "Refusing to create an integration-test database on a remote host. Set ALLOW_REMOTE_DB_INTEGRATION_TESTS=true to override.",
    );
  }

  return url;
}

async function createReadyFile(
  connectorType: "csv" | "xlsx" = "csv",
): Promise<DataSource> {
  const suffix = nextValue(connectorType);
  const source = await createFileDataSource({
    connectorType,
    name: `Ready ${connectorType}`,
    originalFilename: `${suffix}.${connectorType}`,
    mimeType:
      connectorType === "csv"
        ? "text/csv"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileSizeBytes: 128,
    azureBlobName: `data-sources/session-tests/${suffix}.${connectorType}`,
  });
  const ready = await completeFileDataSourceUpload({
    dataSourceId: source.id,
    originalFilename: source.originalFilename!,
    mimeType: source.mimeType!,
    fileSizeBytes: source.fileSizeBytes!,
    azureBlobName: source.azureBlobName!,
    azureETag: `"${suffix}-etag"`,
  });

  assert.ok(ready);
  return ready;
}

async function createReadyDatabase(): Promise<DataSource> {
  const suffix = nextValue("database");
  const source = await createPostgresqlDataSource({
    name: "Ready PostgreSQL",
    config: {
      host: "analytics.internal",
      database: `analytics_${sequence}`,
      sslMode: "require",
    },
    credentials: SYNTHETIC_CREDENTIALS,
  });
  const ready = await updateDataSourceLifecycle({
    dataSourceId: source.id,
    fromStatus: "testing",
    toStatus: "ready",
  });

  assert.ok(ready, suffix);
  return ready;
}

async function createSession(
  dataSourceIds: DataSource["id"][],
  options: {
    idempotencyKey?: string;
    maxDataSources?: number;
    capabilityId?: string;
    capabilityExpiresAt?: Date;
  } = {},
) {
  return createChatSession({
    dataSourceIds,
    maxDataSources: options.maxDataSources ?? 10,
    capabilityId: options.capabilityId ?? nextValue("capability"),
    capabilityExpiresAt: options.capabilityExpiresAt ?? futureExpiry(),
    idempotencyKey: options.idempotencyKey,
  });
}

async function activate(session: ChatSession): Promise<ChatSession> {
  const active = await activateChatSession({
    chatSessionId: session.id,
    trueforgeSessionId: nextValue("trueforge-session"),
  });

  assert.ok(active);
  return active;
}

function isPostgresError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

describe("chat session repositories against PostgreSQL", () => {
  const testDatabaseName = `forty_two_sessions_test_${process.pid}_${Date.now()}`;
  let adminSql: postgres.Sql;
  let testSql: postgres.Sql;

  before(async () => {
    const adminUrl = adminConnectionUrl();
    adminSql = postgres(adminUrl.toString(), { max: 1 });
    await adminSql`create database ${adminSql(testDatabaseName)}`;

    const testUrl = new URL(adminUrl);
    testUrl.pathname = `/${testDatabaseName}`;
    testSql = postgres(testUrl.toString(), { max: 1 });

    initializeDatabase({
      connectionString: testUrl.toString(),
      maxConnections: 4,
    });
    await migrateDatabase();
  });

  after(async () => {
    await closeDatabase();

    if (testSql) {
      await testSql.end({ timeout: 5 });
    }

    if (adminSql) {
      await adminSql`drop database if exists ${adminSql(testDatabaseName)} with (force)`;
      await adminSql.end({ timeout: 5 });
    }
  });

  it("applies the ordered additive session migration with relations and checks", async () => {
    await migrateDatabase();

    const tables = await testSql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'chat_sessions',
          'chat_session_data_sources',
          'chat_turn_requests'
        )
      order by table_name
    `;
    assert.deepEqual(
      tables.map((row) => row.table_name),
      ["chat_session_data_sources", "chat_sessions", "chat_turn_requests"],
    );

    const enumValues = await testSql<{ enumlabel: string }[]>`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'chat_session_status'
      order by pg_enum.enumsortorder
    `;
    assert.deepEqual(
      enumValues.map((row) => row.enumlabel),
      ["creating", "active", "failed", "deleted"],
    );

    const turnRequestEnumValues = await testSql<{ enumlabel: string }[]>`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'chat_turn_request_state'
      order by pg_enum.enumsortorder
    `;
    assert.deepEqual(
      turnRequestEnumValues.map((row) => row.enumlabel),
      ["creating", "created", "indeterminate"],
    );

    const constraints = await testSql<{ conname: string }[]>`
      select conname
      from pg_constraint
      where conname in (
        'chat_session_data_sources_pk',
        'chat_session_data_sources_chat_session_id_chat_sessions_id_fk',
        'chat_session_data_sources_data_source_id_data_sources_id_fk',
        'chat_sessions_active_identifiers_check',
        'chat_sessions_capability_expiry_check',
        'chat_sessions_deleted_state_check',
        'chat_sessions_failure_message_check',
        'chat_sessions_id_format_check',
        'chat_sessions_idempotency_hash_check',
        'chat_sessions_idempotency_pair_check',
        'chat_sessions_timestamp_order_check',
        'chat_turn_requests_pk',
        'chat_turn_requests_chat_session_id_chat_sessions_id_fk',
        'chat_turn_requests_key_check',
        'chat_turn_requests_hash_check',
        'chat_turn_requests_state_turn_check',
        'chat_turn_requests_timestamp_order_check'
      )
    `;
    assert.equal(constraints.length, 17);
  });

  it("creates a creating session with deduplicated mixed ready bindings", async () => {
    const file = await createReadyFile();
    const database = await createReadyDatabase();
    const result = await createSession([database.id, file.id, database.id], {
      maxDataSources: 2,
    });

    assert.equal(result.created, true);
    assert.equal(result.chatSession.status, "creating");
    assert.match(result.chatSession.id, /^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(result.chatSession.trueforgeSessionId, null);
    assert.equal(result.chatSession.mcpServerName, null);

    const expectedIds = [database.id, file.id].sort();
    assert.deepEqual(
      await listChatSessionDataSourceIds({
        chatSessionId: result.chatSession.id,
      }),
      expectedIds,
    );
    assert.deepEqual(
      (
        await listChatSessionDataSourceBindings({
          chatSessionId: result.chatSession.id,
        })
      ).map((binding) => binding.dataSourceId),
      expectedIds,
    );
    assert.deepEqual(
      (
        await listChatSessionDataSources({
          chatSessionId: result.chatSession.id,
        })
      ).map((source) => source.id),
      expectedIds,
    );

    await assert.rejects(
      testSql`
        insert into chat_session_data_sources (chat_session_id, data_source_id)
        values (${result.chatSession.id}, ${file.id})
      `,
      (error: unknown) => isPostgresError(error, "23505"),
    );
    await assert.rejects(
      testSql`
        update chat_session_data_sources
        set data_source_id = ${file.id}
        where chat_session_id = ${result.chatSession.id}
          and data_source_id = ${file.id}
      `,
      (error: unknown) => isPostgresError(error, "55000"),
    );
    await assert.rejects(
      testSql`
        delete from chat_session_data_sources
        where chat_session_id = ${result.chatSession.id}
          and data_source_id = ${file.id}
      `,
      (error: unknown) => isPostgresError(error, "55000"),
    );
  });

  it("rejects missing, non-ready, deleted, and excessive source sets atomically", async () => {
    const ready = await createReadyFile();
    const nonReady = await createFileDataSource({
      connectorType: "csv",
      name: "Awaiting file",
      originalFilename: "awaiting.csv",
      mimeType: "text/csv",
      fileSizeBytes: 12,
      azureBlobName: `data-sources/session-tests/${nextValue("awaiting")}.csv`,
    });
    const deleted = await createReadyDatabase();
    await updateDataSourceLifecycle({
      dataSourceId: deleted.id,
      fromStatus: "ready",
      toStatus: "deleted",
    });
    const countBefore = await testSql<{ count: number }[]>`
      select count(*)::int as count from chat_sessions
    `;

    for (const invalidId of [generateDataSourceId(), nonReady.id, deleted.id]) {
      await assert.rejects(
        createSession([ready.id, invalidId]),
        ChatSessionDataSourceUnavailableError,
      );
    }
    await assert.rejects(
      createSession([ready.id, nonReady.id], { maxDataSources: 1 }),
      ChatSessionDataSourceLimitError,
    );

    const countAfter = await testSql<{ count: number }[]>`
      select count(*)::int as count from chat_sessions
    `;
    assert.equal(countAfter[0]?.count, countBefore[0]?.count);

    const deduplicated = await createSession([ready.id, ready.id], {
      maxDataSources: 1,
    });
    assert.deepEqual(
      await listChatSessionDataSourceIds({
        chatSessionId: deduplicated.chatSession.id,
      }),
      [ready.id],
    );
  });

  it("returns idempotent retries and fails closed on canonical hash conflicts", async () => {
    const file = await createReadyFile("xlsx");
    const database = await createReadyDatabase();
    const other = await createReadyFile();
    const idempotencyKey = nextValue("idempotency-key");
    const capabilityId = nextValue("idempotent-capability");
    const capabilityExpiresAt = futureExpiry();
    const first = await createSession([file.id, database.id], {
      idempotencyKey,
      capabilityId,
      capabilityExpiresAt,
    });
    const retry = await createSession([database.id, file.id, file.id], {
      idempotencyKey,
      capabilityId,
      capabilityExpiresAt,
    });

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.chatSession.id, first.chatSession.id);
    assert.equal(
      (await getChatSessionByIdempotencyKey({ idempotencyKey }))?.id,
      first.chatSession.id,
    );
    assert.match(first.chatSession.idempotencyRequestHash!, /^[0-9a-f]{64}$/);

    await assert.rejects(
      createSession([file.id, other.id], {
        idempotencyKey,
        capabilityId,
        capabilityExpiresAt,
      }),
      ChatSessionIdempotencyConflictError,
    );
    await assert.rejects(
      createSession([file.id, database.id], {
        idempotencyKey,
        capabilityId: `${capabilityId}-changed`,
        capabilityExpiresAt,
      }),
      ChatSessionIdempotencyConflictError,
    );
    await assert.rejects(
      createSession([file.id, database.id], {
        idempotencyKey,
        maxDataSources: 9,
        capabilityId,
        capabilityExpiresAt,
      }),
      ChatSessionIdempotencyConflictError,
    );
    await assert.rejects(
      createSession([file.id, database.id], {
        idempotencyKey,
        capabilityId,
        capabilityExpiresAt: new Date(capabilityExpiresAt.getTime() + 1_000),
      }),
      ChatSessionIdempotencyConflictError,
    );
    assert.deepEqual(
      await listChatSessionDataSourceIds({
        chatSessionId: first.chatSession.id,
      }),
      [database.id, file.id].sort(),
    );

    const concurrentKey = nextValue("concurrent-idempotency-key");
    const concurrentCapabilityId = nextValue("concurrent-capability");
    const concurrentCapabilityExpiresAt = futureExpiry();
    const concurrentResults = await Promise.all([
      createSession([file.id, database.id], {
        idempotencyKey: concurrentKey,
        capabilityId: concurrentCapabilityId,
        capabilityExpiresAt: concurrentCapabilityExpiresAt,
      }),
      createSession([database.id, file.id], {
        idempotencyKey: concurrentKey,
        capabilityId: concurrentCapabilityId,
        capabilityExpiresAt: concurrentCapabilityExpiresAt,
      }),
    ]);
    assert.equal(
      new Set(concurrentResults.map((result) => result.chatSession.id)).size,
      1,
    );
    assert.deepEqual(concurrentResults.map((result) => result.created).sort(), [
      false,
      true,
    ]);
  });

  it("atomically reserves and terminalizes durable turn requests", async () => {
    const source = await createReadyDatabase();
    const active = await activate(
      (await createSession([source.id])).chatSession,
    );
    const idempotencyKey = nextValue("turn-idempotency");
    const requestHash = "a".repeat(64);

    const reservations = await Promise.all([
      reserveChatTurnRequest({
        chatSessionId: active.id,
        idempotencyKey,
        requestHash,
      }),
      reserveChatTurnRequest({
        chatSessionId: active.id,
        idempotencyKey,
        requestHash,
      }),
    ]);
    assert.deepEqual(
      reservations.map((reservation) => reservation.reserved).sort(),
      [false, true],
    );
    assert.equal(
      new Set(
        reservations.map((reservation) => reservation.request.requestHash),
      ).size,
      1,
    );
    await assert.rejects(
      reserveChatTurnRequest({
        chatSessionId: active.id,
        idempotencyKey,
        requestHash: "b".repeat(64),
      }),
      ChatTurnRequestConflictError,
    );

    const completed = await completeChatTurnRequest({
      chatSessionId: active.id,
      idempotencyKey,
      requestHash,
      trueforgeTurnId: nextValue("turn"),
    });
    assert.equal(completed.state, "created");
    assert.ok(completed.trueforgeTurnId);
    assert.deepEqual(
      await getChatTurnRequest({ chatSessionId: active.id, idempotencyKey }),
      completed,
    );
    assert.equal(
      (
        await markChatTurnRequestIndeterminate({
          chatSessionId: active.id,
          idempotencyKey,
          requestHash,
        })
      ).state,
      "created",
    );

    const uncertainKey = nextValue("turn-indeterminate");
    await reserveChatTurnRequest({
      chatSessionId: active.id,
      idempotencyKey: uncertainKey,
      requestHash,
    });
    const uncertain = await markChatTurnRequestIndeterminate({
      chatSessionId: active.id,
      idempotencyKey: uncertainKey,
      requestHash,
    });
    assert.equal(uncertain.state, "indeterminate");
    assert.equal(uncertain.trueforgeTurnId, null);
    assert.equal(
      (
        await reserveChatTurnRequest({
          chatSessionId: active.id,
          idempotencyKey: uncertainKey,
          requestHash,
        })
      ).request.state,
      "indeterminate",
    );

    await assert.rejects(
      testSql`
        update chat_turn_requests
        set state = 'created', trueforge_turn_id = null
        where chat_session_id = ${active.id}
          and idempotency_key = ${uncertainKey}
      `,
      (error: unknown) => isPostgresError(error, "23514"),
    );
  });

  it("optimistically activates or fails creating sessions and enforces invariants", async () => {
    const source = await createReadyFile();
    const activationCandidate = (await createSession([source.id])).chatSession;
    const active = await activate(activationCandidate);

    assert.equal(active.status, "active");
    assert.ok(active.trueforgeSessionId);
    assert.equal(active.mcpServerName, null);
    assert.equal(
      await activateChatSession({
        chatSessionId: active.id,
        trueforgeSessionId: nextValue("stale-trueforge"),
      }),
      null,
    );
    assert.equal(
      await failChatSession({
        chatSessionId: active.id,
        failureMessage: "Stale failure",
      }),
      null,
    );

    const failureCandidate = (await createSession([source.id])).chatSession;
    const failed = await failChatSession({
      chatSessionId: failureCandidate.id,
      failureMessage: "Sanitized upstream failure",
    });
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.failureMessage, "Sanitized upstream failure");
    assert.ok(failed?.capabilityRevokedAt);
    assert.equal(
      await failChatSession({
        chatSessionId: failureCandidate.id,
        failureMessage: "Second failure",
      }),
      null,
    );
    await assert.rejects(
      failChatSession({
        chatSessionId: (await createSession([source.id])).chatSession.id,
        failureMessage: "x".repeat(4001),
      }),
      /Too big|4000/i,
    );

    const invalidActive = (await createSession([source.id])).chatSession;
    await assert.rejects(
      testSql`
        update chat_sessions
        set status = 'active'
        where id = ${invalidActive.id}
      `,
      (error: unknown) => isPostgresError(error, "23514"),
    );
    const invalidFailure = (await createSession([source.id])).chatSession;
    await assert.rejects(
      testSql`
        update chat_sessions
        set status = 'failed', failure_message = ''
        where id = ${invalidFailure.id}
      `,
      (error: unknown) => isPostgresError(error, "23514"),
    );
    const invalidExpiry = (await createSession([source.id])).chatSession;
    await assert.rejects(
      testSql`
        update chat_sessions
        set capability_expires_at = created_at
        where id = ${invalidExpiry.id}
      `,
      (error: unknown) => isPostgresError(error, "23514"),
    );
  });

  it("authorizes only the exact active unexpired unrevoked session capability", async () => {
    const firstSource = await createReadyFile();
    const secondSource = await createReadyDatabase();
    const first = await activate(
      (await createSession([firstSource.id])).chatSession,
    );
    const second = await activate(
      (await createSession([secondSource.id])).chatSession,
    );

    assert.equal(
      (
        await authorizeChatSessionCapability({
          chatSessionId: first.id,
          capabilityId: first.capabilityId,
        })
      )?.id,
      first.id,
    );
    assert.equal(
      await authorizeChatSessionCapability({
        chatSessionId: first.id,
        capabilityId: second.capabilityId,
      }),
      null,
    );
    assert.equal(
      await authorizeChatSessionCapability({
        chatSessionId: second.id,
        capabilityId: first.capabilityId,
      }),
      null,
    );
    assert.deepEqual(
      await listChatSessionDataSourceIds({ chatSessionId: first.id }),
      [firstSource.id],
    );
    assert.deepEqual(
      await listChatSessionDataSourceIds({ chatSessionId: second.id }),
      [secondSource.id],
    );
    assert.equal(
      await revokeChatSessionCapability({
        chatSessionId: first.id,
        capabilityId: second.capabilityId,
      }),
      null,
    );

    const revoked = await revokeChatSessionCapability({
      chatSessionId: first.id,
      capabilityId: first.capabilityId,
    });
    assert.ok(revoked?.capabilityRevokedAt);
    assert.equal(
      await authorizeChatSessionCapability({
        chatSessionId: first.id,
        capabilityId: first.capabilityId,
      }),
      null,
    );
    assert.equal(
      await revokeChatSessionCapability({
        chatSessionId: first.id,
        capabilityId: first.capabilityId,
      }),
      null,
    );

    await testSql`
      update chat_sessions
      set capability_expires_at = CURRENT_TIMESTAMP + interval '20 milliseconds'
      where id = ${second.id}
    `;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      await authorizeChatSessionCapability({
        chatSessionId: second.id,
        capabilityId: second.capabilityId,
      }),
      null,
    );
  });

  it("soft-deletes sessions while retaining immutable bindings and datasources", async () => {
    const source = await createReadyDatabase();
    const active = await activate(
      (await createSession([source.id])).chatSession,
    );
    const deleted = await softDeleteChatSession({ chatSessionId: active.id });

    assert.equal(deleted?.status, "deleted");
    assert.ok(deleted?.deletedAt);
    assert.ok(deleted?.capabilityRevokedAt);
    assert.equal(await getChatSession({ chatSessionId: active.id }), null);
    assert.equal(
      (await getChatSessionForCleanup({ chatSessionId: active.id }))?.id,
      active.id,
    );
    assert.equal(
      await authorizeChatSessionCapability({
        chatSessionId: active.id,
        capabilityId: active.capabilityId,
      }),
      null,
    );
    assert.deepEqual(
      await listChatSessionDataSourceIds({ chatSessionId: active.id }),
      [],
    );
    assert.equal(
      await softDeleteChatSession({ chatSessionId: active.id }),
      null,
    );

    const bindings = await testSql<{ data_source_id: string }[]>`
      select data_source_id
      from chat_session_data_sources
      where chat_session_id = ${active.id}
    `;
    assert.deepEqual([...bindings], [{ data_source_id: source.id }]);
    const sources = await testSql<{ id: string; status: string }[]>`
      select id, status from data_sources where id = ${source.id}
    `;
    assert.deepEqual([...sources], [{ id: source.id, status: "ready" }]);

    await assert.rejects(
      testSql`delete from data_sources where id = ${source.id}`,
      (error: unknown) => isPostgresError(error, "23503"),
    );
    await assert.rejects(
      testSql`delete from chat_sessions where id = ${active.id}`,
      (error: unknown) => isPostgresError(error, "23503"),
    );
  });
});
