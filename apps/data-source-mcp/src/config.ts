import {
  DataSourceType,
  isValidCredentials,
  type Credentials,
  type DataSourceConfig,
} from "@forty-two/data-source";

const DEFAULT_PORT = 8791;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

export interface ConnectionPolicy {
  maxRows: number;
  queryTimeoutMs: number;
}

export interface ConfiguredConnection extends DataSourceConfig {
  description?: string;
  policy: ConnectionPolicy;
  mutation?: {
    mode: "disabled" | "controlled";
    connectorType:
      | "postgresql"
      | "mysql"
      | "sqlserver"
      | "snowflake"
      | "bigquery"
      | "redshift";
    credentialRevision: number;
    allowedCatalog: string | null;
    allowedSchema: string | null;
    allowedTargets: Array<{
      catalog: string | null;
      schema: string | null;
      table: string;
    }>;
  };
}

export interface ServerConfig {
  host: string;
  port: number;
  authToken: string;
  allowedOrigins: string[];
  shutdownTimeoutMs: number;
  connections: ConfiguredConnection[];
  fileDownloads?: FileDownloadConfig;
  dynamic?: {
    controlDatabaseUrl: string;
    encryptionKey: string;
  };
}

export interface ProductServerConfig extends ServerConfig {
  dynamic: NonNullable<ServerConfig["dynamic"]>;
}

export interface FileDownloadConfig {
  accountName: string;
  accountKey: string;
  container: string;
}

interface RawConnection {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  credentials?: unknown;
  policy?: {
    maxRows?: unknown;
    queryTimeoutMs?: unknown;
  };
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProductServerConfig {
  const authToken = environment.MCP_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error("MCP_AUTH_TOKEN is required");
  }

  const dynamic = resolveDynamicConfiguration(environment);
  const fileDownloads = resolveFileDownloadConfiguration(environment);
  return {
    host: environment.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(environment.PORT, DEFAULT_PORT, "PORT"),
    authToken,
    allowedOrigins: parseAllowedOrigins(environment.MCP_ALLOWED_ORIGINS),
    shutdownTimeoutMs: parseBoundedInteger(
      environment.SHUTDOWN_TIMEOUT_MS === undefined
        ? undefined
        : Number(environment.SHUTDOWN_TIMEOUT_MS),
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      1_000,
      20_000,
      "SHUTDOWN_TIMEOUT_MS",
    ),
    // Product traffic is authorized by persisted session bindings. Static
    // adapters remain injectable directly into ConnectionRegistry for isolated
    // tests, but are never loaded into the product server.
    connections: [],
    ...(fileDownloads ? { fileDownloads } : {}),
    dynamic,
  };
}

function resolveFileDownloadConfiguration(
  environment: NodeJS.ProcessEnv,
): FileDownloadConfig | undefined {
  const accountName = environment.AZURE_STORAGE_ACCOUNT_NAME?.trim();
  const accountKey = environment.AZURE_STORAGE_ACCOUNT_KEY?.trim();
  const container = environment.AZURE_STORAGE_CONTAINER?.trim();
  if (!accountName && !accountKey && !container) return undefined;
  if (!accountName || !accountKey || !container) {
    throw new Error(
      "AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_ACCOUNT_KEY, and AZURE_STORAGE_CONTAINER are all required for scoped file downloads",
    );
  }
  if (!/^[a-z0-9]{3,24}$/.test(accountName)) {
    throw new Error("AZURE_STORAGE_ACCOUNT_NAME is invalid");
  }
  if (
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(container) ||
    container.includes("--")
  ) {
    throw new Error("AZURE_STORAGE_CONTAINER is invalid");
  }
  return { accountName, accountKey, container };
}

function resolveDynamicConfiguration(
  environment: NodeJS.ProcessEnv,
): NonNullable<ServerConfig["dynamic"]> {
  const controlDatabaseUrl = environment.MCP_CONTROL_DATABASE_URL?.trim();
  const encryptionKey =
    environment.DATA_SOURCE_CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!controlDatabaseUrl || !encryptionKey) {
    throw new Error(
      "MCP_CONTROL_DATABASE_URL and DATA_SOURCE_CREDENTIALS_ENCRYPTION_KEY are required for session authorization and dynamic datasources",
    );
  }
  return { controlDatabaseUrl, encryptionKey };
}

export function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  return [
    ...new Set(
      value.split(",").map((rawOrigin) => {
        const candidate = rawOrigin.trim();
        if (!candidate)
          throw new Error("MCP_ALLOWED_ORIGINS contains an empty origin");

        let parsed: URL;
        try {
          parsed = new URL(candidate);
        } catch {
          throw new Error(
            `MCP_ALLOWED_ORIGINS contains an invalid origin: ${candidate}`,
          );
        }
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          parsed.origin === "null" ||
          parsed.pathname !== "/" ||
          parsed.search ||
          parsed.hash ||
          parsed.username ||
          parsed.password
        ) {
          throw new Error(
            `MCP_ALLOWED_ORIGINS contains an invalid origin: ${candidate}`,
          );
        }
        return parsed.origin;
      }),
    ),
  ];
}

export function parseConnections(
  value: string | undefined,
): ConfiguredConnection[] {
  if (!value?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `DATA_SOURCE_CONNECTIONS_JSON must be valid JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("DATA_SOURCE_CONNECTIONS_JSON must contain an array");
  }

  const names = new Set<string>();
  return parsed.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`Connection at index ${index} must be an object`);
    }

    const connection = raw as RawConnection;
    const name = requireNonEmptyString(
      connection.name,
      `connections[${index}].name`,
    );
    if (names.has(name)) throw new Error(`Duplicate connection name '${name}'`);
    names.add(name);

    if (
      !Object.values(DataSourceType).includes(connection.type as DataSourceType)
    ) {
      throw new Error(`Connection '${name}' has an unsupported type`);
    }
    if (!isValidCredentials(connection.credentials)) {
      throw new Error(`Connection '${name}' has invalid credentials`);
    }

    const credentials = connection.credentials as Credentials;
    if (credentials.type !== connection.type) {
      throw new Error(
        `Connection '${name}' type does not match its credentials`,
      );
    }

    return {
      name,
      type: connection.type as DataSourceType,
      credentials,
      ...(typeof connection.description === "string" &&
      connection.description.trim()
        ? { description: connection.description.trim() }
        : {}),
      policy: {
        maxRows: parseBoundedInteger(
          connection.policy?.maxRows,
          1_000,
          1,
          5_000,
          `connections[${index}].policy.maxRows`,
        ),
        queryTimeoutMs: parseBoundedInteger(
          connection.policy?.queryTimeoutMs,
          60_000,
          1_000,
          600_000,
          `connections[${index}].policy.queryTimeoutMs`,
        ),
      },
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  return parseBoundedInteger(Number(value), fallback, 1, 65_535, label);
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
