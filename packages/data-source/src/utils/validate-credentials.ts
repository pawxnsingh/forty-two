import { type Credentials, DataSourceType } from "../types/credentials.js";
import { isValidBigQueryLocation } from "./bigquery-location.js";

export function isValidCredentials(obj: unknown): obj is Credentials {
  if (!isRecord(obj) || typeof obj.type !== "string") return false;

  switch (obj.type) {
    case DataSourceType.Snowflake:
      return validateSnowflakeCredentials(obj);
    case DataSourceType.BigQuery:
      return validateBigQueryCredentials(obj);
    case DataSourceType.PostgreSQL:
      return validatePostgreSQLCredentials(obj);
    case DataSourceType.MySQL:
      return validateMySQLCredentials(obj);
    case DataSourceType.SQLServer:
      return validateSQLServerCredentials(obj);
    case DataSourceType.Redshift:
      return validateRedshiftCredentials(obj);
    default:
      return false;
  }
}

function validateSnowflakeCredentials(obj: Record<string, unknown>): boolean {
  return (
    hasRequiredStrings(obj, [
      "account_id",
      "warehouse_id",
      "username",
      "password",
      "default_database",
    ]) && hasOptionalStrings(obj, ["role", "default_schema", "custom_host"])
  );
}

function validateBigQueryCredentials(obj: Record<string, unknown>): boolean {
  const hasKeyFile = isNonEmptyString(obj.key_file_path);
  const hasServiceAccount = isValidServiceAccount(obj.service_account_key);
  return (
    isNonEmptyString(obj.project_id) &&
    (hasKeyFile || hasServiceAccount) &&
    (obj.key_file_path === undefined || hasKeyFile) &&
    (obj.service_account_key === undefined || hasServiceAccount) &&
    isValidBigQueryLocation(obj.location)
  );
}

function validatePostgreSQLCredentials(obj: Record<string, unknown>): boolean {
  return (
    validateUserPasswordCredentials(obj, "host", false) &&
    (isNonEmptyString(obj.default_database) ||
      isNonEmptyString(obj.database)) &&
    hasOptionalStrings(obj, ["default_database", "database", "schema"]) &&
    isValidSsl(obj.ssl) &&
    isValidTimeout(obj.connection_timeout)
  );
}

function validateMySQLCredentials(obj: Record<string, unknown>): boolean {
  return (
    validateUserPasswordCredentials(obj, "host") &&
    hasOptionalStrings(obj, ["charset"]) &&
    isValidSsl(obj.ssl) &&
    isValidTimeout(obj.connection_timeout)
  );
}

function validateSQLServerCredentials(obj: Record<string, unknown>): boolean {
  return (
    validateUserPasswordCredentials(obj, "server") &&
    hasOptionalStrings(obj, ["domain", "instance"]) &&
    isOptionalBoolean(obj.encrypt) &&
    isOptionalBoolean(obj.trust_server_certificate) &&
    isValidTimeout(obj.connection_timeout) &&
    isValidTimeout(obj.request_timeout)
  );
}

function validateRedshiftCredentials(obj: Record<string, unknown>): boolean {
  return (
    validateUserPasswordCredentials(obj, "host") &&
    hasOptionalStrings(obj, ["default_schema", "cluster_identifier"]) &&
    isOptionalBoolean(obj.ssl) &&
    isValidTimeout(obj.connection_timeout)
  );
}

function validateUserPasswordCredentials(
  obj: Record<string, unknown>,
  hostField: "host" | "server",
  requireDefaultDatabase = true,
): boolean {
  return (
    hasRequiredStrings(obj, [
      hostField,
      "username",
      "password",
      ...(requireDefaultDatabase ? ["default_database"] : []),
    ]) && isValidPort(obj.port)
  );
}

function isValidServiceAccount(value: unknown): boolean {
  if (isRecord(value)) return isServiceAccountRecord(value);
  if (!isNonEmptyString(value)) return false;

  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && isServiceAccountRecord(parsed);
  } catch {
    return true;
  }
}

function isServiceAccountRecord(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.client_email) && isNonEmptyString(value.private_key)
  );
}

function isValidSsl(value: unknown): boolean {
  if (value === undefined || typeof value === "boolean") return true;
  if (!isRecord(value)) return false;
  return (
    isOptionalBoolean(value.rejectUnauthorized) &&
    hasOptionalStrings(value, ["ca", "cert", "key"])
  );
}

function hasRequiredStrings(
  obj: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => isNonEmptyString(obj[field]));
}

function hasOptionalStrings(
  obj: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(
    (field) => obj[field] === undefined || isNonEmptyString(obj[field]),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isValidTimeout(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value > 0 &&
      value <= 600_000)
  );
}

function isValidPort(port: unknown): boolean {
  return (
    port === undefined ||
    (typeof port === "number" &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toCredentials(obj: unknown): Credentials {
  if (isValidCredentials(obj)) return obj;

  const record = isRecord(obj) ? obj : {};
  const type = record.type as string | undefined;
  if (!type) throw new Error('Credentials missing required "type" field');

  switch (type) {
    case DataSourceType.Snowflake:
      throw new Error("Invalid Snowflake credentials");
    case DataSourceType.BigQuery:
      throw new Error(
        "Invalid BigQuery credentials: project_id and a valid service account key or key file are required",
      );
    case DataSourceType.PostgreSQL:
      throw new Error("Invalid PostgreSQL credentials");
    case DataSourceType.MySQL:
      throw new Error("Invalid MySQL credentials");
    case DataSourceType.SQLServer:
      throw new Error("Invalid SQL Server credentials");
    case DataSourceType.Redshift:
      throw new Error("Invalid Redshift credentials");
    default:
      throw new Error(`Unsupported data source type: ${type}`);
  }
}
