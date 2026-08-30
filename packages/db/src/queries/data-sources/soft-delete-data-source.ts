import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import { DataSourceIdSchema } from "../../ids.js";
import { dataSources } from "../../schema/index.js";
import type { DataSource } from "../../types.js";
import { parseDataSource } from "./shared.js";

export const SoftDeleteDataSourceInputSchema = z.object({
  dataSourceId: DataSourceIdSchema,
});

export type SoftDeleteDataSourceInput = z.input<
  typeof SoftDeleteDataSourceInputSchema
>;

export async function softDeleteDataSource(
  input: SoftDeleteDataSourceInput,
): Promise<DataSource | null> {
  const parsed = SoftDeleteDataSourceInputSchema.parse(input);
  const now = new Date();
  const rows = await getDatabase()
    .update(dataSources)
    .set({
      status: "deleted",
      deletedAt: now,
      updatedAt: now,
      processingMessage: null,
      azureCleanupStatus: sql`CASE WHEN ${dataSources.connectorType} IN ('csv', 'xlsx') THEN 'pending'::data_source_blob_cleanup_status ELSE NULL END`,
      azureCleanupETag: sql`CASE WHEN ${dataSources.connectorType} IN ('csv', 'xlsx') THEN ${dataSources.azureETag} ELSE NULL END`,
      azureCleanupAttempts: 0,
      azureCleanupCompletedAt: null,
      azureCleanupErrorCode: null,
    })
    .where(
      and(
        eq(dataSources.id, parsed.dataSourceId),
        ne(dataSources.status, "deleted"),
        isNull(dataSources.deletedAt),
      ),
    )
    .returning();

  return rows[0] ? parseDataSource(rows[0]) : null;
}
