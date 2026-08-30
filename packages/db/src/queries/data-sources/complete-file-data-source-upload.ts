import { and, eq, inArray, isNull } from "drizzle-orm";

import { getDatabase } from "../../database.js";
import { dataSources } from "../../schema/index.js";
import {
  CompleteFileDataSourceUploadInputSchema,
  type CompleteFileDataSourceUploadInput,
  type DataSource,
} from "../../types.js";
import { parseDataSource } from "./shared.js";

export async function completeFileDataSourceUpload(
  input: CompleteFileDataSourceUploadInput,
): Promise<DataSource | null> {
  const parsed = CompleteFileDataSourceUploadInputSchema.parse(input);
  const rows = await getDatabase()
    .update(dataSources)
    .set({
      originalFilename: parsed.originalFilename,
      mimeType: parsed.mimeType,
      fileSizeBytes: parsed.fileSizeBytes,
      azureBlobName: parsed.azureBlobName,
      azureETag: parsed.azureETag,
      status: "ready",
      processingMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dataSources.id, parsed.dataSourceId),
        inArray(dataSources.connectorType, ["csv", "xlsx"]),
        eq(dataSources.status, "awaiting_upload"),
        isNull(dataSources.deletedAt),
      ),
    )
    .returning();

  return rows[0] ? parseDataSource(rows[0]) : null;
}
