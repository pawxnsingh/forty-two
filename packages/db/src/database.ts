import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

import * as schema from "./schema/index.js";

const DatabaseConnectionOptionsSchema = z.object({
  connectionString: z.string().min(1).optional(),
  maxConnections: z.number().int().positive().max(100).optional().default(10),
  idleTimeoutSeconds: z.number().int().nonnegative().optional().default(30),
  connectTimeoutSeconds: z.number().int().positive().optional().default(30),
  prepare: z.boolean().optional().default(true),
});

export type DatabaseConnectionOptions = z.input<
  typeof DatabaseConnectionOptionsSchema
>;

type Database = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql | null = null;
let database: Database | null = null;
let activeConnectionString: string | null = null;

function resolveConnectionString(connectionString?: string): string {
  const resolved = connectionString ?? process.env.DATABASE_URL;

  if (!resolved) {
    throw new Error(
      "DATABASE_URL is required. Pass connectionString or set DATABASE_URL.",
    );
  }

  return resolved;
}

export function initializeDatabase(
  options: DatabaseConnectionOptions = {},
): void {
  const parsed = DatabaseConnectionOptionsSchema.parse(options);
  const connectionString = resolveConnectionString(parsed.connectionString);

  if (database && activeConnectionString !== connectionString) {
    throw new Error(
      "The database is already initialized with a different connection string. Close it before reinitializing.",
    );
  }

  if (database) {
    return;
  }

  client = postgres(connectionString, {
    max: parsed.maxConnections,
    idle_timeout: parsed.idleTimeoutSeconds,
    connect_timeout: parsed.connectTimeoutSeconds,
    prepare: parsed.prepare,
  });
  database = drizzle(client, { schema });
  activeConnectionString = connectionString;
}

export function getDatabase(): Database {
  if (!database) {
    initializeDatabase();
  }

  if (!database) {
    throw new Error("Failed to initialize the database connection.");
  }

  return database;
}

export async function pingDatabase(): Promise<boolean> {
  try {
    const db = getDatabase();
    await db.execute("select 1");
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  const activeClient = client;
  client = null;
  database = null;
  activeConnectionString = null;

  if (activeClient) {
    await activeClient.end({ timeout: 5 });
  }
}
