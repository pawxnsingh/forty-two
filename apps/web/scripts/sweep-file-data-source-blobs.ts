import { closeDatabase } from "@forty-two/db";
import { DataSourceIdSchema } from "@forty-two/db";

import { sweepPendingFileDataSourceBlobs } from "../lib/server/data-sources/blob-cleanup-service";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;

function batchSize(): number {
  const raw = process.env.FILE_DATASOURCE_CLEANUP_BATCH_SIZE;
  if (!raw) return DEFAULT_BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new Error(
      `FILE_DATASOURCE_CLEANUP_BATCH_SIZE must be an integer from 1 to ${MAX_BATCH_SIZE}.`,
    );
  }
  return parsed;
}

function exactDataSourceIds(): string[] | undefined {
  const raw = process.env.FILE_DATASOURCE_CLEANUP_DATA_SOURCE_IDS?.trim();
  if (!raw) return undefined;
  const ids = raw.split(",").map((value) => value.trim());
  if (ids.length > MAX_BATCH_SIZE) {
    throw new Error(
      `FILE_DATASOURCE_CLEANUP_DATA_SOURCE_IDS accepts at most ${MAX_BATCH_SIZE} IDs.`,
    );
  }
  return ids.map((value) => DataSourceIdSchema.parse(value));
}

try {
  const summary = await sweepPendingFileDataSourceBlobs({
    limit: batchSize(),
    dataSourceIds: exactDataSourceIds(),
  });
  console.log(JSON.stringify(summary));
} finally {
  await closeDatabase();
}
