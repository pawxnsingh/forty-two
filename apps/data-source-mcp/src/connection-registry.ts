import { DataSource, type DataSourceConfig } from "@forty-two/data-source";

import type { ConfiguredConnection } from "./config.js";

export interface PublicConnection {
  name: string;
  type: string;
  description?: string;
  policy: ConfiguredConnection["policy"];
}

export class ConnectionRegistry {
  readonly dataSource: DataSource;
  private readonly connections: Map<string, ConfiguredConnection>;

  constructor(connections: ConfiguredConnection[]) {
    this.connections = new Map(
      connections.map((connection) => [connection.name, connection]),
    );
    this.dataSource = new DataSource({
      dataSources: connections.map(toDataSourceConfig),
    });
  }

  list(): PublicConnection[] {
    return Array.from(this.connections.values(), (connection) => ({
      name: connection.name,
      type: connection.type,
      ...(connection.description
        ? { description: connection.description }
        : {}),
      policy: connection.policy,
    }));
  }

  get(name: string): ConfiguredConnection {
    const connection = this.connections.get(name);
    if (!connection) throw new Error(`Data source '${name}' is not available`);
    return connection;
  }

  async close(): Promise<void> {
    await this.dataSource.close();
  }
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
