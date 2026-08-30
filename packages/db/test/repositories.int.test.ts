import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import {
  beginDataSourceDeletion,
  closeDatabase,
  completeFileDataSourceUpload,
  createFileDataSource,
  createPostgresqlDataSource,
  generateDataSourceId,
  getDataSource,
  getDataSourceCredentials,
  getReadyDatabaseDataSourceConnection,
  getTestingDatabaseDataSourceConnection,
  initializeDatabase,
  listReadyDatabaseDataSources,
  listReadyDataSources,
  migrateDatabase,
  pinDataSourceBlobCleanupETag,
  pingDatabase,
  recordDataSourceBlobCleanupAttempt,
  rotateDataSourceCredentials,
  sweepPendingDataSourceBlobCleanups,
  updateDataSourceLifecycle,
} from "../src/index.js";

const SYNTHETIC_CREDENTIALS = {
  ciphertext: "c3ludGhldGljLWNpcGhlcnRleHQ=",
  iv: "c3ludGhldGljLWl2",
  authTag: "c3ludGhldGljLWF1dGgtdGFn",
  encryptionVersion: 1,
} as const;

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

describe("datasource repositories against PostgreSQL", () => {
  const testDatabaseName = `forty_two_db_test_${process.pid}_${Date.now()}`;
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
      maxConnections: 2,
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

  it("applies committed migrations idempotently with enums, checks, and indexes", async () => {
    await migrateDatabase();
    assert.equal(await pingDatabase(), true);

    const tables = await testSql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('data_sources', 'data_source_credentials')
      order by table_name
    `;
    assert.deepEqual(
      tables.map((row) => row.table_name),
      ["data_source_credentials", "data_sources"],
    );

    const constraints = await testSql<{ conname: string }[]>`
      select conname
      from pg_constraint
      where conname in (
        'data_sources_connector_metadata_check',
        'data_sources_connector_status_check',
        'data_sources_deleted_state_check',
        'data_sources_file_size_check',
        'data_sources_ready_file_etag_check',
        'data_sources_azure_cleanup_attempts_check',
        'data_sources_azure_cleanup_state_check',
        'data_source_credentials_revision_check',
        'data_source_credentials_data_source_id_data_sources_id_fk'
      )
      order by conname
    `;
    assert.equal(constraints.length, 9);

    const enumValues = await testSql<{ enumlabel: string }[]>`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'data_source_status'
      order by pg_enum.enumsortorder
    `;
    assert.deepEqual(
      enumValues.map((row) => row.enumlabel),
      ["awaiting_upload", "testing", "ready", "failed", "deleted"],
    );

    const cleanupEnumValues = await testSql<{ enumlabel: string }[]>`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'data_source_blob_cleanup_status'
      order by pg_enum.enumsortorder
    `;
    assert.deepEqual(
      cleanupEnumValues.map((row) => row.enumlabel),
      ["pending", "deleted", "missing", "superseded"],
    );
  });

  it("persists CSV and XLSX metadata and makes completed files ready", async () => {
    const csv = await createFileDataSource({
      connectorType: "csv",
      name: "Quarterly sales",
      originalFilename: "sales.csv",
      mimeType: "text/csv",
      fileSizeBytes: 128,
      azureBlobName: "data-sources/csv/sales.csv",
      config: { delimiter: "," },
    });
    const xlsx = await createFileDataSource({
      connectorType: "xlsx",
      name: "Forecast",
      originalFilename: "forecast.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSizeBytes: 4096,
      azureBlobName: "data-sources/xlsx/forecast.xlsx",
    });

    assert.match(csv.id, /^ds_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(csv.status, "awaiting_upload");
    assert.equal(xlsx.connectorType, "xlsx");

    await assert.rejects(
      updateDataSourceLifecycle({
        dataSourceId: csv.id,
        fromStatus: "awaiting_upload",
        toStatus: "ready",
      }),
      /Invalid datasource lifecycle transition/,
    );
    await assert.rejects(
      testSql`update data_sources set status = 'ready' where id = ${csv.id}`,
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514",
    );

    const ready = await completeFileDataSourceUpload({
      dataSourceId: csv.id,
      originalFilename: csv.originalFilename!,
      mimeType: csv.mimeType!,
      fileSizeBytes: csv.fileSizeBytes!,
      azureBlobName: csv.azureBlobName!,
      azureETag: '"synthetic-etag"',
    });
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.azureETag, '"synthetic-etag"');
    assert.equal(
      await completeFileDataSourceUpload({
        dataSourceId: csv.id,
        originalFilename: csv.originalFilename!,
        mimeType: csv.mimeType!,
        fileSizeBytes: csv.fileSizeBytes!,
        azureBlobName: csv.azureBlobName!,
        azureETag: '"stale-etag"',
      }),
      null,
    );

    const readyFiles = await listReadyDataSources({
      dataSourceIds: [csv.id, xlsx.id],
      connectorTypes: ["csv", "xlsx"],
    });
    assert.deepEqual(
      readyFiles.map((source) => source.id),
      [csv.id],
    );
  });

  it("persists retryable exact blob cleanup state after local deletion", async () => {
    const source = await createFileDataSource({
      connectorType: "csv",
      name: "Cleanup source",
      originalFilename: "cleanup.csv",
      mimeType: "text/csv",
      fileSizeBytes: 42,
      azureBlobName: "data-sources/cleanup/source.csv",
    });
    const other = await createFileDataSource({
      connectorType: "csv",
      name: "Other cleanup source",
      originalFilename: "other.csv",
      mimeType: "text/csv",
      fileSizeBytes: 7,
      azureBlobName: "data-sources/cleanup/other.csv",
    });

    const deleted = await beginDataSourceDeletion({
      dataSourceId: source.id,
    });
    assert.equal(deleted?.status, "deleted");
    assert.equal(deleted?.azureCleanupStatus, "pending");
    assert.equal(deleted?.azureCleanupETag, null);
    assert.equal(deleted?.azureCleanupAttempts, 0);
    assert.equal(await getDataSource({ dataSourceId: source.id }), null);
    assert.equal(
      (await beginDataSourceDeletion({ dataSourceId: source.id }))
        ?.azureCleanupStatus,
      "pending",
    );

    const pinned = await pinDataSourceBlobCleanupETag({
      dataSourceId: source.id,
      azureBlobName: source.azureBlobName!,
      azureETag: '"cleanup-generation"',
    });
    assert.equal(pinned?.azureCleanupETag, '"cleanup-generation"');
    assert.equal(
      await pinDataSourceBlobCleanupETag({
        dataSourceId: source.id,
        azureBlobName: other.azureBlobName!,
        azureETag: '"other-generation"',
      }),
      null,
    );

    const pending = await recordDataSourceBlobCleanupAttempt({
      dataSourceId: source.id,
      azureBlobName: source.azureBlobName!,
      expectedAzureETag: '"cleanup-generation"',
      outcome: "pending",
      errorCode: "AZURE_STATUS_503",
    });
    assert.equal(pending?.azureCleanupAttempts, 1);
    assert.equal(pending?.azureCleanupErrorCode, "AZURE_STATUS_503");
    assert.equal(
      await recordDataSourceBlobCleanupAttempt({
        dataSourceId: source.id,
        azureBlobName: other.azureBlobName!,
        expectedAzureETag: '"cleanup-generation"',
        outcome: "deleted",
      }),
      null,
    );

    const completed = await recordDataSourceBlobCleanupAttempt({
      dataSourceId: source.id,
      azureBlobName: source.azureBlobName!,
      expectedAzureETag: '"cleanup-generation"',
      outcome: "deleted",
    });
    assert.equal(completed?.azureCleanupStatus, "deleted");
    assert.equal(completed?.azureCleanupAttempts, 2);
    assert.ok(completed?.azureCleanupCompletedAt instanceof Date);
    assert.equal(completed?.azureCleanupErrorCode, null);
    assert.equal(
      await recordDataSourceBlobCleanupAttempt({
        dataSourceId: source.id,
        azureBlobName: source.azureBlobName!,
        expectedAzureETag: '"cleanup-generation"',
        outcome: "deleted",
      }),
      null,
    );

    await assert.rejects(
      testSql`
        update data_sources
        set azure_cleanup_status = 'deleted',
            azure_cleanup_etag = null,
            azure_cleanup_attempts = 1,
            azure_cleanup_completed_at = current_timestamp
        where id = ${source.id}
      `,
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514",
    );
    assert.equal(
      (await getDataSource({ dataSourceId: other.id }))?.status,
      "awaiting_upload",
    );
  });

  it("claims cleanup rows safely across concurrent workers and restarts", async () => {
    const source = await createFileDataSource({
      connectorType: "csv",
      name: "Concurrent cleanup source",
      originalFilename: "concurrent.csv",
      mimeType: "text/csv",
      fileSizeBytes: 12,
      azureBlobName: "data-sources/cleanup/concurrent.csv",
    });
    await completeFileDataSourceUpload({
      dataSourceId: source.id,
      originalFilename: source.originalFilename!,
      mimeType: source.mimeType!,
      fileSizeBytes: source.fileSizeBytes!,
      azureBlobName: source.azureBlobName!,
      azureETag: '"concurrent-generation"',
    });
    await beginDataSourceDeletion({ dataSourceId: source.id });

    await assert.rejects(
      sweepPendingDataSourceBlobCleanups({
        limit: 1,
        dataSourceIds: [source.id],
        worker: async () => ({ outcome: "missing", azureETag: null }),
      }),
      /cannot change its pinned ETag/,
    );
    const afterInvalidGeneration = await getDataSource({
      dataSourceId: source.id,
      includeDeleted: true,
    });
    assert.equal(afterInvalidGeneration?.azureCleanupStatus, "pending");
    assert.equal(afterInvalidGeneration?.azureCleanupAttempts, 0);

    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let workerCalls = 0;
    const firstSweep = sweepPendingDataSourceBlobCleanups({
      limit: 1,
      dataSourceIds: [source.id],
      worker: async (cleanup) => {
        workerCalls += 1;
        assert.equal(cleanup.azureBlobName, source.azureBlobName);
        assert.equal(cleanup.azureCleanupETag, '"concurrent-generation"');
        markFirstEntered();
        await firstReleased;
        return {
          outcome: "deleted",
          azureETag: cleanup.azureCleanupETag,
        };
      },
    });
    await firstEntered;
    const concurrentSweep = await sweepPendingDataSourceBlobCleanups({
      limit: 1,
      dataSourceIds: [source.id],
      worker: async () => {
        workerCalls += 1;
        return { outcome: "missing", azureETag: null };
      },
    });
    assert.equal(concurrentSweep.processed, 0);
    assert.equal(concurrentSweep.skippedLockedOrChanged, 1);
    releaseFirst();
    const completedSweep = await firstSweep;
    assert.equal(completedSweep.outcomes.deleted, 1);
    assert.equal(workerCalls, 1);

    const terminal = await getDataSource({
      dataSourceId: source.id,
      includeDeleted: true,
    });
    assert.equal(terminal?.azureCleanupStatus, "deleted");
    assert.equal(terminal?.azureCleanupAttempts, 1);
    const idempotentSweep = await sweepPendingDataSourceBlobCleanups({
      limit: 1,
      dataSourceIds: [source.id],
      worker: async () => {
        throw new Error("terminal rows must not run");
      },
    });
    assert.equal(idempotentSweep.selected, 0);
    assert.equal(idempotentSweep.pendingRemaining, 0);

    const restartSource = await createFileDataSource({
      connectorType: "csv",
      name: "Restart cleanup source",
      originalFilename: "restart.csv",
      mimeType: "text/csv",
      fileSizeBytes: 13,
      azureBlobName: "data-sources/cleanup/restart.csv",
    });
    await beginDataSourceDeletion({ dataSourceId: restartSource.id });
    await assert.rejects(
      sweepPendingDataSourceBlobCleanups({
        limit: 1,
        dataSourceIds: [restartSource.id],
        worker: async () => {
          throw new Error("synthetic process interruption");
        },
      }),
      /synthetic process interruption/,
    );
    const afterInterruption = await getDataSource({
      dataSourceId: restartSource.id,
      includeDeleted: true,
    });
    assert.equal(afterInterruption?.azureCleanupStatus, "pending");
    assert.equal(afterInterruption?.azureCleanupAttempts, 0);

    const restarted = await sweepPendingDataSourceBlobCleanups({
      limit: 1,
      dataSourceIds: [restartSource.id],
      worker: async () => ({ outcome: "missing", azureETag: null }),
    });
    assert.equal(restarted.outcomes.missing, 1);
    assert.equal(restarted.pendingRemaining, 0);
    assert.equal(
      (
        await getDataSource({
          dataSourceId: restartSource.id,
          includeDeleted: true,
        })
      )?.azureCleanupAttempts,
      1,
    );
  });

  it("persists PostgreSQL config separately from a rotatable encrypted envelope", async () => {
    await assert.rejects(
      createPostgresqlDataSource({
        name: "Plaintext credential attempt",
        config: {
          url: "postgresql://reader:plaintext@db/demo",
          pwd: "plaintext",
        } as never,
        credentials: SYNTHETIC_CREDENTIALS,
      }),
      /unrecognized key/i,
    );

    const source = await createPostgresqlDataSource({
      name: "Analytics replica",
      config: {
        host: "analytics.internal",
        port: 5432,
        database: "analytics",
        sslMode: "require",
      },
      credentials: SYNTHETIC_CREDENTIALS,
    });

    assert.equal(source.status, "testing");
    assert.equal(source.connectorType, "postgresql");
    assert.equal(source.originalFilename, null);
    assert.equal("password" in source.config, false);
    let databaseCleanupCalls = 0;
    const databaseCleanup = await sweepPendingDataSourceBlobCleanups({
      limit: 1,
      dataSourceIds: [source.id],
      worker: async () => {
        databaseCleanupCalls += 1;
        return { outcome: "missing", azureETag: null };
      },
    });
    assert.equal(databaseCleanup.selected, 0);
    assert.equal(databaseCleanupCalls, 0);

    const testingConnection = await getTestingDatabaseDataSourceConnection(
      source.id,
    );
    assert.equal(testingConnection?.dataSource.id, source.id);
    assert.equal(testingConnection?.dataSource.azureCleanupStatus, null);
    assert.equal(testingConnection?.dataSource.azureCleanupETag, null);
    assert.equal(testingConnection?.dataSource.azureCleanupAttempts, 0);
    assert.equal(testingConnection?.dataSource.azureCleanupCompletedAt, null);
    assert.equal(testingConnection?.dataSource.azureCleanupErrorCode, null);

    const credentials = await getDataSourceCredentials({
      dataSourceId: source.id,
    });
    assert.equal(credentials?.dataSourceId, source.id);
    assert.equal(credentials?.revision, 1);
    assert.ok(credentials?.updatedAt instanceof Date);
    assert.deepEqual(
      credentials && {
        ciphertext: credentials.ciphertext,
        iv: credentials.iv,
        authTag: credentials.authTag,
        encryptionVersion: credentials.encryptionVersion,
      },
      SYNTHETIC_CREDENTIALS,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const competingEnvelopes = [
      {
        ciphertext: "cm90YXRpb24tYQ==",
        iv: "cm90YXRpb24tYS1pdg==",
        authTag: "cm90YXRpb24tYS10YWc=",
        encryptionVersion: 1,
      },
      {
        ciphertext: "cm90YXRpb24tYg==",
        iv: "cm90YXRpb24tYi1pdg==",
        authTag: "cm90YXRpb24tYi10YWc=",
        encryptionVersion: 1,
      },
    ] as const;
    const rotations = await Promise.all(
      competingEnvelopes.map((credentialEnvelope) =>
        rotateDataSourceCredentials({
          dataSourceId: source.id,
          expectedRevision: 1,
          credentials: credentialEnvelope,
        }),
      ),
    );
    const winners = rotations.filter((rotation) => rotation !== null);
    assert.equal(winners.length, 1);
    assert.equal(rotations.filter((rotation) => rotation === null).length, 1);
    assert.equal(winners[0]?.revision, 2);
    assert.equal(winners[0]?.encryptionVersion, 1);

    const afterRotation = await getDataSourceCredentials({
      dataSourceId: source.id,
    });
    assert.equal(afterRotation?.revision, 2);
    assert.equal(afterRotation?.ciphertext, winners[0]?.ciphertext);
    assert.equal(
      await rotateDataSourceCredentials({
        dataSourceId: source.id,
        expectedRevision: 1,
        credentials: SYNTHETIC_CREDENTIALS,
      }),
      null,
    );

    const parentAfterRotation = await getDataSource({
      dataSourceId: source.id,
    });
    assert.ok(parentAfterRotation);
    assert.ok(
      parentAfterRotation.updatedAt.getTime() > source.updatedAt.getTime(),
    );

    const ready = await updateDataSourceLifecycle({
      dataSourceId: source.id,
      fromStatus: "testing",
      toStatus: "ready",
    });
    assert.equal(ready?.status, "ready");

    const readyConnection = await getReadyDatabaseDataSourceConnection(
      source.id,
    );
    assert.equal(readyConnection?.dataSource.id, source.id);
    assert.equal(readyConnection?.dataSource.azureCleanupAttempts, 0);
    assert.deepEqual(
      (await listReadyDatabaseDataSources()).map((dataSource) => dataSource.id),
      [source.id],
    );

    const readyPostgresql = await listReadyDataSources({
      dataSourceIds: [source.id],
      connectorTypes: ["postgresql"],
    });
    assert.deepEqual(
      readyPostgresql.map((dataSource) => dataSource.id),
      [source.id],
    );
  });

  it("rejects file sizes above the JavaScript safe-integer bound in PostgreSQL", async () => {
    const source = await createFileDataSource({
      connectorType: "csv",
      name: "Safe file size",
      originalFilename: "safe.csv",
      mimeType: "text/csv",
      fileSizeBytes: 3,
      azureBlobName: "data-sources/file-size/safe.csv",
    });

    await assert.rejects(
      testSql`update data_sources set file_size_bytes = 9007199254740993 where id = ${source.id}`,
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514",
    );
    assert.equal(
      (await getDataSource({ dataSourceId: source.id }))?.fileSizeBytes,
      3,
    );
  });

  it("requires explicit optimistic lifecycle transitions", async () => {
    const source = await createPostgresqlDataSource({
      name: "Failing replica",
      config: { host: "invalid.internal", port: 5432, database: "missing" },
      credentials: SYNTHETIC_CREDENTIALS,
    });

    const failed = await updateDataSourceLifecycle({
      dataSourceId: source.id,
      fromStatus: "testing",
      toStatus: "failed",
      processingMessage: "Synthetic validation failure",
    });
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.processingMessage, "Synthetic validation failure");

    const staleUpdate = await updateDataSourceLifecycle({
      dataSourceId: source.id,
      fromStatus: "testing",
      toStatus: "ready",
    });
    assert.equal(staleUpdate, null);

    await assert.rejects(
      updateDataSourceLifecycle({
        dataSourceId: source.id,
        fromStatus: "failed",
        toStatus: "ready",
      }),
      /Invalid datasource lifecycle transition/,
    );

    const testingAgain = await updateDataSourceLifecycle({
      dataSourceId: source.id,
      fromStatus: "failed",
      toStatus: "testing",
    });
    assert.equal(testingAgain?.status, "testing");
    assert.equal(testingAgain?.processingMessage, null);
  });

  it("excludes soft-deleted rows and credentials by default", async () => {
    const source = await createPostgresqlDataSource({
      name: "Disposable source",
      config: { host: "db.internal", port: 5432, database: "demo" },
      credentials: SYNTHETIC_CREDENTIALS,
    });
    const deleted = await updateDataSourceLifecycle({
      dataSourceId: source.id,
      fromStatus: "testing",
      toStatus: "deleted",
    });

    assert.equal(deleted?.status, "deleted");
    assert.ok(deleted?.deletedAt instanceof Date);
    assert.equal(await getDataSource({ dataSourceId: source.id }), null);
    assert.equal(
      (await getDataSource({ dataSourceId: source.id, includeDeleted: true }))
        ?.status,
      "deleted",
    );
    assert.equal(
      await getDataSourceCredentials({ dataSourceId: source.id }),
      null,
    );
    assert.equal(
      (
        await getDataSourceCredentials({
          dataSourceId: source.id,
          includeDeleted: true,
        })
      )?.encryptionVersion,
      1,
    );
    assert.deepEqual(
      await listReadyDataSources({ dataSourceIds: [source.id] }),
      [],
    );
  });

  it("enforces credential foreign keys and cascades on physical parent deletion", async () => {
    const missingParentId = generateDataSourceId();
    await assert.rejects(
      testSql`
        insert into data_source_credentials (
          data_source_id,
          ciphertext,
          iv,
          auth_tag,
          encryption_version
        ) values (
          ${missingParentId},
          'synthetic',
          'synthetic',
          'synthetic',
          1
        )
      `,
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23503",
    );

    const source = await createPostgresqlDataSource({
      name: "Cascade proof",
      config: { host: "db.internal", port: 5432, database: "demo" },
      credentials: SYNTHETIC_CREDENTIALS,
    });
    await testSql`delete from data_sources where id = ${source.id}`;

    assert.equal(
      await getDataSourceCredentials({
        dataSourceId: source.id,
        includeDeleted: true,
      }),
      null,
    );
  });
});
