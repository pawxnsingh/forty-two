import { closeDatabase, initializeDatabase } from "./database.js";
import { migrateDatabase } from "./migrations.js";

async function main(): Promise<void> {
  initializeDatabase();

  try {
    await migrateDatabase();
  } finally {
    await closeDatabase();
  }
}

await main();
