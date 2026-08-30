import { generateDataSourceId } from "../../ids.js";
import {
  CreatePostgresqlDataSourceInputSchema,
  type CreatePostgresqlDataSourceInput,
  type DataSource,
} from "../../types.js";
import { createDatabaseDataSource } from "./create-database-data-source.js";

export async function createPostgresqlDataSource(
  input: CreatePostgresqlDataSourceInput,
): Promise<DataSource> {
  const parsed = CreatePostgresqlDataSourceInputSchema.parse(input);
  return createDatabaseDataSource({
    dataSourceId: generateDataSourceId(),
    connectorType: "postgresql",
    name: parsed.name,
    config: parsed.config,
    credentials: parsed.credentials,
  });
}
