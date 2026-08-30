import { getDatabase } from "../../database.js";
import { generateDataSourceId } from "../../ids.js";
import { dataSources } from "../../schema/index.js";
import {
  CreateFileDataSourceInputSchema,
  type CreateFileDataSourceInput,
  type DataSource,
} from "../../types.js";
import { parseReturnedDataSource } from "./shared.js";

export async function createFileDataSource(
  input: CreateFileDataSourceInput,
): Promise<DataSource> {
  const parsed = CreateFileDataSourceInputSchema.parse(input);
  const rows = await getDatabase()
    .insert(dataSources)
    .values({
      id: parsed.dataSourceId ?? generateDataSourceId(),
      connectorType: parsed.connectorType,
      name: parsed.name,
      status: "awaiting_upload",
      config: parsed.config,
      originalFilename: parsed.originalFilename,
      mimeType: parsed.mimeType,
      fileSizeBytes: parsed.fileSizeBytes,
      azureBlobName: parsed.azureBlobName,
    })
    .returning();

  return parseReturnedDataSource(rows, "Creating a file datasource");
}
