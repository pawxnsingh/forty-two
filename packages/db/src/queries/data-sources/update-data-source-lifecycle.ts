import { and, eq, inArray, sql } from "drizzle-orm";

import { getDatabase } from "../../database.js";
import { dataSources, type NewDataSourceRow } from "../../schema/index.js";
import {
  UpdateDataSourceLifecycleInputSchema,
  type DataSource,
  type UpdateDataSourceLifecycleInput,
} from "../../types.js";
import { parseDataSource } from "./shared.js";

export async function updateDataSourceLifecycle(
  input: UpdateDataSourceLifecycleInput,
): Promise<DataSource | null> {
  const parsed = UpdateDataSourceLifecycleInputSchema.parse(input);
  const now = new Date();
  const updates: Partial<NewDataSourceRow> = {
    status: parsed.toStatus,
    updatedAt: now,
    deletedAt: parsed.toStatus === "deleted" ? now : null,
  };

  if (parsed.toStatus === "deleted") {
    updates.azureCleanupStatus =
      sql`CASE WHEN ${dataSources.connectorType} IN ('csv', 'xlsx') THEN 'pending'::data_source_blob_cleanup_status ELSE NULL END` as unknown as NewDataSourceRow["azureCleanupStatus"];
    updates.azureCleanupETag =
      sql`CASE WHEN ${dataSources.connectorType} IN ('csv', 'xlsx') THEN ${dataSources.azureETag} ELSE NULL END` as unknown as NewDataSourceRow["azureCleanupETag"];
    updates.azureCleanupAttempts = 0;
    updates.azureCleanupCompletedAt = null;
    updates.azureCleanupErrorCode = null;
  }

  if (parsed.processingMessage !== undefined) {
    updates.processingMessage = parsed.processingMessage;
  } else if (parsed.toStatus !== "failed") {
    updates.processingMessage = null;
  }

  const rows = await getDatabase()
    .update(dataSources)
    .set(updates)
    .where(
      and(
        eq(dataSources.id, parsed.dataSourceId),
        eq(dataSources.status, parsed.fromStatus),
        parsed.toStatus === "testing"
          ? inArray(dataSources.connectorType, [
              "postgresql",
              "mysql",
              "sqlserver",
              "snowflake",
              "bigquery",
              "redshift",
            ])
          : undefined,
      ),
    )
    .returning();

  return rows[0] ? parseDataSource(rows[0]) : null;
}
