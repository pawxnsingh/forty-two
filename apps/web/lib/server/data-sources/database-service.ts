import {
  createDatabaseDataSource,
  CreateDatabaseDataSourceInputSchema,
  DatabaseMutationAllowlistSchema,
  DatabaseConnectorTypeSchema,
  DatabaseSecretSchema,
  databaseConfigSchemaFor,
  encryptDatabaseSecret,
  generateDataSourceId,
  getDataSource,
  initializeDatabase,
  migrateDatabase,
  MutationModeSchema,
  updateDataSourceLifecycle,
  type CredentialEnvelope,
} from "@forty-two/db";
import { z } from "zod";

import {
  DataSourceApiError,
  publicDataSource,
  type PublicDataSource,
} from "./file-service";

const DatabaseRegistrationSchema = z
  .object({
    connectorType: DatabaseConnectorTypeSchema,
    name: z.string().trim().min(1).max(255),
    mutationMode: MutationModeSchema.optional().default("disabled"),
    mutationAllowlist: DatabaseMutationAllowlistSchema,
    config: z.record(z.string(), z.unknown()),
    credentials: z.record(z.string(), z.unknown()),
  })
  .strict();

let databaseReadyPromise: Promise<void> | undefined;

export async function registerDatabaseDataSource(body: unknown): Promise<{
  data: PublicDataSource;
}> {
  const request = parseDatabaseDataSourceRegistration(body);
  const dataSourceId = generateDataSourceId();
  const encryptionKey = requiredEnvironment(
    "DATA_SOURCE_CREDENTIALS_ENCRYPTION_KEY",
  );
  const credentials = encryptDatabaseSecret({
    dataSourceId,
    connectorType: request.connectorType,
    secret: request.secret,
    encryptionKey,
  });

  await ensureDatabase();
  const created = await createDatabaseDataSource(
    buildDatabasePersistenceInput(dataSourceId, request, credentials),
  );

  let connected = false;
  try {
    connected = await validateWithMcp(
      dataSourceId,
      Math.min(request.config.connectionTimeoutMs + 5_000, 65_000),
    );
  } catch {
    connected = false;
  }

  const transitioned = await updateDataSourceLifecycle({
    dataSourceId,
    fromStatus: "testing",
    toStatus: connected ? "ready" : "failed",
    ...(connected
      ? {}
      : { processingMessage: "Database connection validation failed." }),
  });
  const finalDataSource =
    transitioned ?? (await getDataSource({ dataSourceId })) ?? created;
  return { data: publicDataSource(finalDataSource) };
}

export function parseDatabaseDataSourceRegistration(body: unknown) {
  const request = DatabaseRegistrationSchema.parse(body);
  if (
    "mutationMode" in request.config ||
    "mutationAllowlist" in request.config
  ) {
    throw new DataSourceApiError(
      400,
      "INVALID_DATABASE_CONFIG",
      "mutationMode and mutationAllowlist must be provided at the request top level.",
    );
  }

  const config = databaseConfigSchemaFor(request.connectorType).parse({
    ...request.config,
    mutationMode: request.mutationMode,
    mutationAllowlist: request.mutationAllowlist,
  });
  const secret = DatabaseSecretSchema.parse({
    connectorType: request.connectorType,
    ...request.credentials,
  });
  return {
    connectorType: request.connectorType,
    name: request.name,
    config,
    secret,
  };
}

export function buildDatabasePersistenceInput(
  dataSourceId: string,
  request: ReturnType<typeof parseDatabaseDataSourceRegistration>,
  credentials: CredentialEnvelope,
) {
  return CreateDatabaseDataSourceInputSchema.parse({
    dataSourceId,
    connectorType: request.connectorType,
    name: request.name,
    config: request.config,
    credentials,
  });
}

async function ensureDatabase(): Promise<void> {
  if (!databaseReadyPromise) {
    databaseReadyPromise = (async () => {
      initializeDatabase();
      await migrateDatabase();
    })().catch((error: unknown) => {
      databaseReadyPromise = undefined;
      throw error;
    });
  }
  await databaseReadyPromise;
}

async function validateWithMcp(
  dataSourceId: string,
  timeoutMs: number,
): Promise<boolean> {
  const baseUrl = requiredEnvironment("DATA_SOURCE_MCP_INTERNAL_URL");
  const authToken = requiredEnvironment("MCP_AUTH_TOKEN");
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/internal/data-sources/${encodeURIComponent(dataSourceId)}/validate`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) return false;
  const payload: unknown = await response.json();
  return (
    typeof payload === "object" &&
    payload !== null &&
    "data" in payload &&
    typeof payload.data === "object" &&
    payload.data !== null &&
    "dataSourceId" in payload.data &&
    payload.data.dataSourceId === dataSourceId &&
    "connected" in payload.data &&
    payload.data.connected === true
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new DataSourceApiError(
      503,
      "DATABASE_DATASOURCE_UNAVAILABLE",
      "Database datasource registration is not configured.",
    );
  }
  return value;
}
