import assert from "node:assert/strict";
import test from "node:test";

import {
  encryptDatabaseSecret,
  generateDataSourceId,
  type DatabaseConnectorType,
  type DatabaseDataSource,
  type DatabaseDataSourceConnection,
  type DatabaseSecret,
} from "@forty-two/db";

import {
  ConnectionRegistry,
  type DynamicConnectionStore,
} from "../src/connection-registry.js";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");

test("testing sources are internal-only and become ready without restart", async () => {
  const stored = connection("postgresql", {
    connectorType: "postgresql",
    username: "reader",
    password: "never-return-this-password",
  });
  let status: "testing" | "ready" | "failed" = "testing";
  const store = fakeStore(
    () => stored,
    () => status,
  );
  const registry = new ConnectionRegistry([], { encryptionKey, store });
  const added: unknown[] = [];
  const removed: string[] = [];
  Object.assign(registry.dataSource, {
    addDataSource: async (value: unknown) => void added.push(value),
    removeDataSource: async (value: string) => void removed.push(value),
  });

  assert.deepEqual(await registry.list(), []);
  await assert.rejects(registry.get(stored.dataSource.id), /not available/);

  const testing = await registry.resolveTesting(stored.dataSource.id);
  assert.equal(testing.name, stored.dataSource.id);
  assert.equal(testing.type, "postgres");
  assert.equal(added.length, 1);

  status = "ready";
  const ready = await registry.get(stored.dataSource.id);
  assert.equal(ready, testing);
  const listed = await registry.list();
  assert.deepEqual(listed, [
    {
      name: stored.dataSource.id,
      type: "postgresql",
      description: "PostgreSQL test",
      mutationMode: "disabled",
      policy: { maxRows: 1_000, queryTimeoutMs: 10_000 },
    },
  ]);
  assert.equal(
    JSON.stringify(listed).includes("never-return-this-password"),
    false,
  );

  status = "failed";
  await assert.rejects(registry.get(stored.dataSource.id), /not available/);
  assert.deepEqual(removed, [stored.dataSource.id]);
  await registry.close();
});

test("credential revision changes replace the cached adapter configuration", async () => {
  let stored = connection("mysql", {
    connectorType: "mysql",
    username: "reader",
    password: "first-password",
  });
  const store = fakeStore(
    () => stored,
    () => "ready",
  );
  const registry = new ConnectionRegistry([], { encryptionKey, store });
  const added: unknown[] = [];
  const updated: unknown[] = [];
  Object.assign(registry.dataSource, {
    addDataSource: async (value: unknown) => void added.push(value),
    updateDataSource: async (name: string, value: unknown) =>
      void updated.push({ name, value }),
  });

  await registry.get(stored.dataSource.id);
  stored = connection(
    "mysql",
    {
      connectorType: "mysql",
      username: "rotated-reader",
      password: "second-password",
    },
    stored.dataSource.id,
    2,
  );
  await registry.get(stored.dataSource.id);

  assert.equal(added.length, 1);
  assert.equal(updated.length, 1);
  assert.equal(JSON.stringify(updated).includes("rotated-reader"), true);
  assert.equal(
    JSON.stringify(await registry.list()).includes("rotated-reader"),
    false,
  );
  await registry.close();
});

test("testing and ready resolutions serialize adapter mutations per datasource", async () => {
  const stored = connection("postgresql", {
    connectorType: "postgresql",
    username: "reader",
    password: "password",
  });
  let enterTesting!: () => void;
  let releaseTesting!: () => void;
  const testingEntered = new Promise<void>(
    (resolve) => (enterTesting = resolve),
  );
  const testingRelease = new Promise<void>(
    (resolve) => (releaseTesting = resolve),
  );
  let readyReads = 0;
  const store: DynamicConnectionStore = {
    listReady: async () => [stored.dataSource],
    getTesting: async () => {
      enterTesting();
      await testingRelease;
      return stored;
    },
    getReady: async () => {
      readyReads += 1;
      return stored;
    },
  };
  const registry = new ConnectionRegistry([], { encryptionKey, store });
  let additions = 0;
  Object.assign(registry.dataSource, {
    addDataSource: async () => {
      additions += 1;
    },
  });

  const testing = registry.resolveTesting(stored.dataSource.id);
  await testingEntered;
  const ready = registry.get(stored.dataSource.id);
  await Promise.resolve();
  assert.equal(readyReads, 0);

  releaseTesting();
  assert.equal((await testing).name, stored.dataSource.id);
  assert.equal((await ready).name, stored.dataSource.id);
  assert.equal(readyReads, 1);
  assert.equal(additions, 1);
  await registry.close();
});

test("all six stored connector names map through the production adapter contract", async () => {
  const cases: Array<[DatabaseConnectorType, DatabaseSecret, string]> = [
    [
      "postgresql",
      { connectorType: "postgresql", username: "u", password: "p" },
      "postgres",
    ],
    [
      "mysql",
      { connectorType: "mysql", username: "u", password: "p" },
      "mysql",
    ],
    [
      "sqlserver",
      { connectorType: "sqlserver", username: "u", password: "p" },
      "sqlserver",
    ],
    [
      "snowflake",
      { connectorType: "snowflake", username: "u", password: "p" },
      "snowflake",
    ],
    [
      "bigquery",
      {
        connectorType: "bigquery",
        serviceAccount: {
          clientEmail: "reader@example.test",
          privateKey: "not-real",
        },
      },
      "bigquery",
    ],
    [
      "redshift",
      { connectorType: "redshift", username: "u", password: "p" },
      "redshift",
    ],
  ];

  for (const [connectorType, secret, adapterType] of cases) {
    const stored = connection(connectorType, secret);
    const registry = new ConnectionRegistry([], {
      encryptionKey,
      store: fakeStore(
        () => stored,
        () => "testing",
      ),
    });
    const added: Array<{ type: string }> = [];
    Object.assign(registry.dataSource, {
      addDataSource: async (value: { type: string }) => void added.push(value),
    });
    const resolved = await registry.resolveTesting(stored.dataSource.id);
    assert.equal(resolved.type, adapterType);
    assert.equal(added[0]?.type, adapterType);
    await registry.close();
  }
});

function fakeStore(
  getConnection: () => DatabaseDataSourceConnection,
  getStatus: () => "testing" | "ready" | "failed",
): DynamicConnectionStore {
  return {
    listReady: async () =>
      getStatus() === "ready" ? [getConnection().dataSource] : [],
    getReady: async () => (getStatus() === "ready" ? getConnection() : null),
    getTesting: async () =>
      getStatus() === "testing" ? getConnection() : null,
  };
}

function connection(
  connectorType: DatabaseConnectorType,
  secret: DatabaseSecret,
  dataSourceId = generateDataSourceId(),
  revision = 1,
): DatabaseDataSourceConnection {
  const now = new Date("2026-08-28T00:00:00.000Z");
  const config = configFor(connectorType);
  return {
    dataSource: {
      id: dataSourceId,
      connectorType,
      name: `${connectorLabel(connectorType)} test`,
      status: "testing",
      config,
      originalFilename: null,
      mimeType: null,
      fileSizeBytes: null,
      azureBlobName: null,
      azureETag: null,
      processingMessage: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    } as DatabaseDataSource,
    credentials: {
      dataSourceId,
      ...encryptDatabaseSecret({
        dataSourceId,
        connectorType,
        secret,
        encryptionKey,
      }),
      revision,
      updatedAt: new Date(now.getTime() + revision),
    },
  };
}

function configFor(connectorType: DatabaseConnectorType) {
  switch (connectorType) {
    case "postgresql":
      return {
        host: "db",
        port: 5432,
        database: "app",
        sslMode: "disable",
        connectionTimeoutMs: 10_000,
        mutationMode: "disabled",
      };
    case "mysql":
      return {
        host: "db",
        port: 3306,
        database: "app",
        sslMode: "disable",
        connectionTimeoutMs: 10_000,
        mutationMode: "disabled",
      };
    case "sqlserver":
      return {
        host: "db",
        port: 1433,
        database: "app",
        encrypt: true,
        trustServerCertificate: false,
        connectionTimeoutMs: 10_000,
        requestTimeoutMs: 60_000,
        mutationMode: "disabled",
      };
    case "snowflake":
      return {
        accountId: "account",
        warehouseId: "warehouse",
        database: "app",
        connectionTimeoutMs: 10_000,
        mutationMode: "disabled",
      };
    case "bigquery":
      return {
        projectId: "project",
        location: "US",
        connectionTimeoutMs: 10_000,
        mutationMode: "disabled",
      };
    case "redshift":
      return {
        host: "db",
        port: 5439,
        database: "app",
        ssl: true,
        connectionTimeoutMs: 10_000,
        mutationMode: "disabled",
      };
  }
}

function connectorLabel(connectorType: DatabaseConnectorType): string {
  return connectorType === "postgresql" ? "PostgreSQL" : connectorType;
}
