import {
  DataSource,
  DataSourceType,
  type Credentials,
  type DataSourceConfig,
} from "@forty-two/data-source";
import {
  decryptDatabaseSecret,
  type DatabaseConnectorType,
  type DatabaseDataSourceConnection,
  type DatabaseDataSource,
  type DatabaseSecret,
  type DataSource as StoredDataSource,
} from "@forty-two/db";

import type { ConfiguredConnection } from "./config.js";

const DYNAMIC_CONNECTORS: DatabaseConnectorType[] = [
  "postgresql",
  "mysql",
  "sqlserver",
  "snowflake",
  "bigquery",
  "redshift",
];

export interface PublicConnection {
  name: string;
  type: string;
  description?: string;
  mutationMode?: "disabled" | "controlled";
  policy: ConfiguredConnection["policy"];
}

export interface DynamicConnectionStore {
  listReady(): Promise<DatabaseDataSource[]>;
  getReady(dataSourceId: string): Promise<DatabaseDataSourceConnection | null>;
  getTesting(
    dataSourceId: string,
  ): Promise<DatabaseDataSourceConnection | null>;
}

export interface DynamicConnectionOptions {
  encryptionKey: string;
  store: DynamicConnectionStore;
}

interface CachedDynamicConnection {
  signature: string;
  connection: ConfiguredConnection;
  availability: "testing" | "ready";
}

export class ConnectionRegistry {
  readonly dataSource: DataSource;
  private readonly staticConnections: Map<string, ConfiguredConnection>;
  private readonly dynamic?: DynamicConnectionOptions;
  private readonly dynamicConnections = new Map<
    string,
    CachedDynamicConnection
  >();
  private readonly resolutions = new Map<string, Promise<void>>();

  constructor(
    connections: ConfiguredConnection[],
    dynamic?: DynamicConnectionOptions,
  ) {
    this.staticConnections = new Map(
      connections.map((connection) => [connection.name, connection]),
    );
    this.dynamic = dynamic;
    this.dataSource = new DataSource({
      dataSources: connections.map(toDataSourceConfig),
    });
  }

  async list(): Promise<PublicConnection[]> {
    const staticConnections = Array.from(
      this.staticConnections.values(),
      toPublicConnection,
    );
    if (!this.dynamic) return staticConnections;

    const ready = await this.dynamic.store.listReady();
    const readyIds = new Set(ready.map((source) => source.id));
    await Promise.all(
      Array.from(this.dynamicConnections.keys(), (dataSourceId) =>
        readyIds.has(dataSourceId) ||
        this.dynamicConnections.get(dataSourceId)?.availability === "testing"
          ? Promise.resolve()
          : this.invalidateDynamic(dataSourceId),
      ),
    );
    return [
      ...staticConnections,
      ...ready.map((source) => ({
        name: source.id,
        type: source.connectorType,
        description: source.name,
        mutationMode: source.config.mutationMode,
        policy: policyFor(source),
      })),
    ];
  }

  get(name: string): Promise<ConfiguredConnection> {
    return this.resolve(name, false);
  }

  resolveTesting(dataSourceId: string): Promise<ConfiguredConnection> {
    return this.resolve(dataSourceId, true);
  }

  async invalidateDynamic(dataSourceId: string): Promise<void> {
    return this.enqueueResolution(dataSourceId, () =>
      this.invalidateDynamicNow(dataSourceId),
    );
  }

  private async invalidateDynamicNow(dataSourceId: string): Promise<void> {
    if (!this.dynamicConnections.has(dataSourceId)) return;
    this.dynamicConnections.delete(dataSourceId);
    await this.dataSource.removeDataSource(dataSourceId);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.resolutions.values());
    this.dynamicConnections.clear();
    this.resolutions.clear();
    await this.dataSource.close();
  }

  private resolve(
    name: string,
    allowTesting: boolean,
  ): Promise<ConfiguredConnection> {
    const staticConnection = this.staticConnections.get(name);
    if (staticConnection) return Promise.resolve(staticConnection);
    if (!this.dynamic || !/^ds_[0-9A-HJKMNP-TV-Z]{26}$/.test(name)) {
      return Promise.reject(
        new Error(`Data source '${name}' is not available`),
      );
    }

    return this.enqueueResolution(name, () =>
      this.resolveDynamic(name, allowTesting),
    );
  }

  private enqueueResolution<T>(
    dataSourceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.resolutions.get(dataSourceId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.resolutions.set(dataSourceId, tail);
    void tail.finally(() => {
      if (this.resolutions.get(dataSourceId) === tail) {
        this.resolutions.delete(dataSourceId);
      }
    });
    return result;
  }

  private async resolveDynamic(
    dataSourceId: string,
    allowTesting: boolean,
  ): Promise<ConfiguredConnection> {
    if (!this.dynamic) {
      throw new Error(`Data source '${dataSourceId}' is not available`);
    }
    const stored = allowTesting
      ? await this.dynamic.store.getTesting(dataSourceId)
      : await this.dynamic.store.getReady(dataSourceId);
    if (!stored) {
      await this.invalidateDynamicNow(dataSourceId);
      throw new Error(`Data source '${dataSourceId}' is not available`);
    }

    try {
      const signature = connectionSignature(stored);
      const cached = this.dynamicConnections.get(dataSourceId);
      if (cached?.signature === signature) {
        cached.availability = allowTesting ? "testing" : "ready";
        return cached.connection;
      }

      const secret = decryptDatabaseSecret({
        dataSourceId,
        connectorType: stored.dataSource.connectorType,
        credentials: stored.credentials,
        encryptionKey: this.dynamic.encryptionKey,
      });
      const connection = toDynamicConnection(
        stored.dataSource,
        secret,
        stored.credentials.revision,
      );
      if (cached) {
        await this.dataSource.updateDataSource(
          dataSourceId,
          toDataSourceConfig(connection),
        );
      } else {
        await this.dataSource.addDataSource(toDataSourceConfig(connection));
      }
      this.dynamicConnections.set(dataSourceId, {
        signature,
        connection,
        availability: allowTesting ? "testing" : "ready",
      });
      return connection;
    } catch {
      await this.invalidateDynamicNow(dataSourceId);
      throw new Error(`Data source '${dataSourceId}' is not available`);
    }
  }
}

function toPublicConnection(
  connection: ConfiguredConnection,
): PublicConnection {
  return {
    name: connection.name,
    type: connection.type,
    ...(connection.description ? { description: connection.description } : {}),
    policy: connection.policy,
  };
}

function toDataSourceConfig(
  connection: ConfiguredConnection,
): DataSourceConfig {
  return {
    name: connection.name,
    type: connection.type,
    credentials: connection.credentials,
  };
}

function connectionSignature(stored: DatabaseDataSourceConnection): string {
  return JSON.stringify([
    stored.dataSource.connectorType,
    stored.dataSource.config,
    stored.dataSource.updatedAt.toISOString(),
    stored.credentials.encryptionVersion,
    stored.credentials.revision,
    stored.credentials.updatedAt.toISOString(),
  ]);
}

function toDynamicConnection(
  source: DatabaseDataSourceConnection["dataSource"],
  secret: DatabaseSecret,
  credentialRevision: number,
): ConfiguredConnection {
  const policy = policyFor(source);
  const credentials = toAdapterCredentials(source, secret);
  return {
    name: source.id,
    description: source.name,
    type: credentials.type,
    credentials,
    policy,
    mutation: mutationPolicyFor(source, credentialRevision),
  };
}

function mutationPolicyFor(
  source: DatabaseDataSourceConnection["dataSource"],
  credentialRevision: number,
): NonNullable<ConfiguredConnection["mutation"]> {
  switch (source.connectorType) {
    case "postgresql":
      return {
        mode: source.config.mutationMode,
        connectorType: source.connectorType,
        credentialRevision,
        allowedCatalog: source.config.database,
        allowedSchema: source.config.schema ?? null,
        allowedTargets: normalizedTargets(
          source.config.mutationAllowlist,
          source.config.database,
          source.config.schema ?? null,
        ),
      };
    case "mysql":
      return {
        mode: source.config.mutationMode,
        connectorType: source.connectorType,
        credentialRevision,
        allowedCatalog: source.config.database,
        allowedSchema: null,
        allowedTargets: normalizedTargets(
          source.config.mutationAllowlist,
          source.config.database,
          null,
        ),
      };
    case "sqlserver":
      return {
        mode: source.config.mutationMode,
        connectorType: source.connectorType,
        credentialRevision,
        allowedCatalog: source.config.database,
        allowedSchema: null,
        allowedTargets: normalizedTargets(
          source.config.mutationAllowlist,
          source.config.database,
          null,
        ),
      };
    case "snowflake":
      return {
        mode: source.config.mutationMode,
        connectorType: source.connectorType,
        credentialRevision,
        allowedCatalog: source.config.database,
        allowedSchema: source.config.schema ?? null,
        allowedTargets: normalizedTargets(
          source.config.mutationAllowlist,
          source.config.database,
          source.config.schema ?? null,
        ),
      };
    case "bigquery":
      return {
        mode: source.config.mutationMode,
        connectorType: source.connectorType,
        credentialRevision,
        allowedCatalog: source.config.projectId,
        allowedSchema: null,
        allowedTargets: normalizedTargets(
          source.config.mutationAllowlist,
          source.config.projectId,
          null,
        ),
      };
    case "redshift":
      return {
        mode: source.config.mutationMode,
        connectorType: source.connectorType,
        credentialRevision,
        allowedCatalog: source.config.database,
        allowedSchema: source.config.schema ?? null,
        allowedTargets: normalizedTargets(
          source.config.mutationAllowlist,
          source.config.database,
          source.config.schema ?? null,
        ),
      };
  }
}

function normalizedTargets(
  targets:
    | Array<{
        catalog: string | null;
        schema: string | null;
        table: string;
      }>
    | undefined,
  defaultCatalog: string | null,
  defaultSchema: string | null,
) {
  return (targets ?? []).map((target) => ({
    catalog: target.catalog ?? defaultCatalog,
    schema: target.schema ?? defaultSchema,
    table: target.table,
  }));
}

function policyFor(
  source: DatabaseDataSourceConnection["dataSource"],
): ConfiguredConnection["policy"] {
  return {
    maxRows: 1_000,
    queryTimeoutMs: source.config.connectionTimeoutMs,
  };
}

function toAdapterCredentials(
  source: DatabaseDataSourceConnection["dataSource"],
  secret: DatabaseSecret,
): Credentials {
  switch (source.connectorType) {
    case "postgresql": {
      const config = source.config;
      assertSecret(secret, "postgresql");
      return {
        type: DataSourceType.PostgreSQL,
        host: config.host,
        port: config.port,
        default_database: config.database,
        username: secret.username,
        password: secret.password,
        ...(config.schema ? { schema: config.schema } : {}),
        ssl: tlsConfiguration(config.sslMode, secret),
        connection_timeout: config.connectionTimeoutMs,
      };
    }
    case "mysql": {
      const config = source.config;
      assertSecret(secret, "mysql");
      return {
        type: DataSourceType.MySQL,
        host: config.host,
        port: config.port,
        default_database: config.database,
        username: secret.username,
        password: secret.password,
        ...(config.charset ? { charset: config.charset } : {}),
        ssl: tlsConfiguration(config.sslMode, secret),
        connection_timeout: config.connectionTimeoutMs,
      };
    }
    case "sqlserver": {
      const config = source.config;
      assertSecret(secret, "sqlserver");
      return {
        type: DataSourceType.SQLServer,
        server: config.host,
        port: config.port,
        default_database: config.database,
        username: secret.username,
        password: secret.password,
        ...(secret.domain ? { domain: secret.domain } : {}),
        ...(config.instance ? { instance: config.instance } : {}),
        encrypt: config.encrypt,
        trust_server_certificate: config.trustServerCertificate,
        connection_timeout: config.connectionTimeoutMs,
        request_timeout: config.requestTimeoutMs,
      };
    }
    case "snowflake": {
      const config = source.config;
      assertSecret(secret, "snowflake");
      return {
        type: DataSourceType.Snowflake,
        account_id: config.accountId,
        warehouse_id: config.warehouseId,
        default_database: config.database,
        username: secret.username,
        password: secret.password,
        ...(config.schema ? { default_schema: config.schema } : {}),
        ...(config.role ? { role: config.role } : {}),
        ...(config.customHost ? { custom_host: config.customHost } : {}),
      };
    }
    case "bigquery": {
      const config = source.config;
      assertSecret(secret, "bigquery");
      return {
        type: DataSourceType.BigQuery,
        project_id: config.projectId,
        location: config.location,
        service_account_key: {
          client_email: secret.serviceAccount.clientEmail,
          private_key: secret.serviceAccount.privateKey,
          ...(secret.serviceAccount.privateKeyId
            ? { private_key_id: secret.serviceAccount.privateKeyId }
            : {}),
          ...(secret.serviceAccount.clientId
            ? { client_id: secret.serviceAccount.clientId }
            : {}),
        },
      };
    }
    case "redshift": {
      const config = source.config;
      assertSecret(secret, "redshift");
      return {
        type: DataSourceType.Redshift,
        host: config.host,
        port: config.port,
        default_database: config.database,
        username: secret.username,
        password: secret.password,
        ...(config.schema ? { default_schema: config.schema } : {}),
        ssl: config.ssl,
        connection_timeout: config.connectionTimeoutMs,
        ...(config.clusterIdentifier
          ? { cluster_identifier: config.clusterIdentifier }
          : {}),
      };
    }
    default: {
      const exhaustive: never = source;
      throw new Error(
        `Unsupported datasource connector: ${(exhaustive as StoredDataSource).connectorType}`,
      );
    }
  }
}

function assertSecret<T extends DatabaseConnectorType>(
  secret: DatabaseSecret,
  connectorType: T,
): asserts secret is Extract<DatabaseSecret, { connectorType: T }> {
  if (secret.connectorType !== connectorType) {
    throw new Error("Credential connector mismatch.");
  }
}

function tlsConfiguration(
  sslMode: "disable" | "require" | "verify-ca" | "verify-full",
  secret: Extract<DatabaseSecret, { connectorType: "postgresql" | "mysql" }>,
):
  | boolean
  | {
      rejectUnauthorized?: boolean;
      ca?: string;
      cert?: string;
      key?: string;
    } {
  if (sslMode === "disable") return false;
  return {
    rejectUnauthorized: sslMode === "verify-ca" || sslMode === "verify-full",
    ...(secret.tlsCa ? { ca: secret.tlsCa } : {}),
    ...(secret.tlsCert ? { cert: secret.tlsCert } : {}),
    ...(secret.tlsKey ? { key: secret.tlsKey } : {}),
  };
}

export { DYNAMIC_CONNECTORS };
