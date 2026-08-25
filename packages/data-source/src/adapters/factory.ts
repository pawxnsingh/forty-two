import { type Credentials, DataSourceType } from "../types/credentials.js";
import type { DatabaseAdapter } from "./base.js";
import { BigQueryAdapter } from "./bigquery.js";
import { MySQLAdapter } from "./mysql.js";
import { PostgreSQLAdapter } from "./postgresql.js";
import { RedshiftAdapter } from "./redshift.js";
import { SnowflakeAdapter } from "./snowflake.js";
import { SQLServerAdapter } from "./sqlserver.js";
import { toCredentials } from "../utils/validate-credentials.js";

/**
 * Create an adapter instance based on credentials
 */
export async function createAdapter(
  credentials: Credentials,
): Promise<DatabaseAdapter> {
  const validatedCredentials = toCredentials(credentials);
  const adapter = createAdapterInstance(validatedCredentials);

  // Initialize the adapter with credentials
  await adapter.initialize(validatedCredentials);
  return adapter;
}

/**
 * Create an adapter instance without initializing it (useful for testing)
 */
export function createAdapterInstance(
  credentials: Credentials,
): DatabaseAdapter {
  let adapter: DatabaseAdapter;

  switch (credentials.type) {
    case DataSourceType.Snowflake:
      adapter = new SnowflakeAdapter();
      break;

    case DataSourceType.BigQuery:
      adapter = new BigQueryAdapter();
      break;

    case DataSourceType.PostgreSQL:
      adapter = new PostgreSQLAdapter();
      break;

    case DataSourceType.MySQL:
      adapter = new MySQLAdapter();
      break;

    case DataSourceType.SQLServer:
      adapter = new SQLServerAdapter();
      break;

    case DataSourceType.Redshift:
      adapter = new RedshiftAdapter();
      break;

    default: {
      // Use never type for exhaustive checking
      const exhaustiveCheck: never = credentials;
      throw new Error(
        `Unsupported data source type: ${(exhaustiveCheck as Credentials).type}`,
      );
    }
  }

  return adapter;
}

/**
 * Get supported data source types
 */
export function getSupportedTypes(): DataSourceType[] {
  return Object.values(DataSourceType);
}

/**
 * Check if a data source type is supported
 */
export function isSupported(type: DataSourceType): boolean {
  return Object.values(DataSourceType).includes(type);
}
