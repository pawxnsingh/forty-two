import {
  DataSourceType,
  isValidCredentials,
  type Credentials,
  type DataSourceConfig,
} from "@forty-two/data-source";

const DEFAULT_PORT = 8791;

export interface ConnectionPolicy {
  maxRows: number;
  queryTimeoutMs: number;
}

export interface ConfiguredConnection extends DataSourceConfig {
  description?: string;
  policy: ConnectionPolicy;
}

export interface ServerConfig {
  host: string;
  port: number;
  authToken: string;
  connections: ConfiguredConnection[];
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
): ServerConfig {
  const authToken = environment.MCP_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error("MCP_AUTH_TOKEN is required");
  }

  return {
    host: environment.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(environment.PORT, DEFAULT_PORT, "PORT"),
    authToken,
    connections: parseConnections(environment.DATA_SOURCE_CONNECTIONS_JSON),
  };
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
