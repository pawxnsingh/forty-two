import test from "node:test";

import { DataSourceType } from "../src/types/credentials.js";

process.env.SQL_CHANGE_HELPER_ONLY = "1";
const { exerciseConnector } = await import("./sql-change-integration.js");

const snowflakeEnvironment = [
  "SNOWFLAKE_ACCOUNT_ID",
  "SNOWFLAKE_WAREHOUSE_ID",
  "SNOWFLAKE_DATABASE",
  "SNOWFLAKE_SQL_CHANGE_SCHEMA",
  "SNOWFLAKE_SQL_CHANGE_TABLE",
  "SNOWFLAKE_USERNAME",
  "SNOWFLAKE_PASSWORD",
] as const;

test(
  "Snowflake live controlled SQL change suite",
  { skip: missingCredentialReason("Snowflake", snowflakeEnvironment) },
  async () => {
    const database = requiredEnvironment("SNOWFLAKE_DATABASE");
    const schema = requiredEnvironment("SNOWFLAKE_SQL_CHANGE_SCHEMA");
    const table = requiredEnvironment("SNOWFLAKE_SQL_CHANGE_TABLE");
    await exerciseConnector({
      name: "snowflake-live-sql-change",
      dialect: "snowflake",
      target: { catalog: database, schema, table },
      targetSql: `${quoteIdentifier(database)}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
      config: {
        name: "snowflake-live-sql-change",
        type: DataSourceType.Snowflake,
        credentials: {
          type: DataSourceType.Snowflake,
          account_id: requiredEnvironment("SNOWFLAKE_ACCOUNT_ID"),
          warehouse_id: requiredEnvironment("SNOWFLAKE_WAREHOUSE_ID"),
          default_database: database,
          default_schema: schema,
          username: requiredEnvironment("SNOWFLAKE_USERNAME"),
          password: requiredEnvironment("SNOWFLAKE_PASSWORD"),
          ...(process.env.SNOWFLAKE_ROLE?.trim()
            ? { role: process.env.SNOWFLAKE_ROLE.trim() }
            : {}),
        },
      },
    });
  },
);

const bigQueryEnvironment = [
  "BIGQUERY_PROJECT_ID",
  "BIGQUERY_SERVICE_ACCOUNT_JSON",
  "BIGQUERY_SQL_CHANGE_DATASET",
  "BIGQUERY_SQL_CHANGE_TABLE",
] as const;

test(
  "BigQuery live controlled SQL change suite",
  { skip: missingCredentialReason("BigQuery", bigQueryEnvironment) },
  async () => {
    const project = requiredEnvironment("BIGQUERY_PROJECT_ID");
    const dataset = requiredEnvironment("BIGQUERY_SQL_CHANGE_DATASET");
    const table = requiredEnvironment("BIGQUERY_SQL_CHANGE_TABLE");
    await exerciseConnector({
      name: "bigquery-live-sql-change",
      dialect: "bigquery",
      target: { catalog: project, schema: dataset, table },
      targetSql: `\`${project}.${dataset}.${table}\``,
      config: {
        name: "bigquery-live-sql-change",
        type: DataSourceType.BigQuery,
        credentials: {
          type: DataSourceType.BigQuery,
          project_id: project,
          service_account_key: JSON.parse(
            requiredEnvironment("BIGQUERY_SERVICE_ACCOUNT_JSON"),
          ) as Record<string, unknown>,
          location: process.env.BIGQUERY_LOCATION?.trim() || "US",
        },
      },
    });
  },
);

const redshiftEnvironment = [
  "REDSHIFT_HOST",
  "REDSHIFT_DATABASE",
  "REDSHIFT_SQL_CHANGE_SCHEMA",
  "REDSHIFT_SQL_CHANGE_TABLE",
  "REDSHIFT_USERNAME",
  "REDSHIFT_PASSWORD",
] as const;

test(
  "Redshift live controlled SQL change suite",
  { skip: missingCredentialReason("Redshift", redshiftEnvironment) },
  async () => {
    const schema = requiredEnvironment("REDSHIFT_SQL_CHANGE_SCHEMA");
    const table = requiredEnvironment("REDSHIFT_SQL_CHANGE_TABLE");
    await exerciseConnector({
      name: "redshift-live-sql-change",
      dialect: "redshift",
      target: { catalog: null, schema, table },
      targetSql: `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
      config: {
        name: "redshift-live-sql-change",
        type: DataSourceType.Redshift,
        credentials: {
          type: DataSourceType.Redshift,
          host: requiredEnvironment("REDSHIFT_HOST"),
          port: numberEnvironment("REDSHIFT_PORT", 5439),
          default_database: requiredEnvironment("REDSHIFT_DATABASE"),
          default_schema: schema,
          username: requiredEnvironment("REDSHIFT_USERNAME"),
          password: requiredEnvironment("REDSHIFT_PASSWORD"),
          ssl: true,
        },
      },
    });
  },
);

function missingCredentialReason(
  connector: string,
  names: readonly string[],
): string | false {
  const missing = names.filter((name) => !process.env[name]?.trim());
  return missing.length > 0
    ? `${connector} live-cloud suite skipped: missing credential-gated configuration (${missing.join(", ")}).`
    : false;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live-cloud suite.`);
  return value;
}

function numberEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
