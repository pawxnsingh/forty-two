import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { z } from "zod";

import { getDatabase } from "./database.js";

const MigrateDatabaseOptionsSchema = z.object({
  migrationsFolder: z.string().min(1).optional(),
});

export type MigrateDatabaseOptions = z.input<
  typeof MigrateDatabaseOptionsSchema
>;

function defaultMigrationsFolder(): string {
  // Build the filesystem path at runtime. A literal directory URL is treated
  // as an asset import by server bundlers even though Drizzle expects a path.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
}

export async function migrateDatabase(
  options: MigrateDatabaseOptions = {},
): Promise<void> {
  const parsed = MigrateDatabaseOptionsSchema.parse(options);
  await migrate(getDatabase(), {
    migrationsFolder: parsed.migrationsFolder ?? defaultMigrationsFolder(),
  });
}
