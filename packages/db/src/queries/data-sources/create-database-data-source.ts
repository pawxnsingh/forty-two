import { getDatabase } from "../../database.js";
import { dataSourceCredentials, dataSources } from "../../schema/index.js";
import {
  CreateDatabaseDataSourceInputSchema,
  databaseConfigSchemaFor,
  type CreateDatabaseDataSourceInput,
  type DataSource,
} from "../../types.js";
import { parseReturnedDataSource } from "./shared.js";

export async function createDatabaseDataSource(
  input: CreateDatabaseDataSourceInput,
): Promise<DataSource> {
  const parsed = CreateDatabaseDataSourceInputSchema.parse(input);
  const config = databaseConfigSchemaFor(parsed.connectorType).parse(
    parsed.config,
  );

  return getDatabase().transaction(async (transaction) => {
    const rows = await transaction
      .insert(dataSources)
      .values({
        id: parsed.dataSourceId,
        connectorType: parsed.connectorType,
        name: parsed.name,
        status: "testing",
        config,
      })
      .returning();

    await transaction.insert(dataSourceCredentials).values({
      dataSourceId: parsed.dataSourceId,
      ...parsed.credentials,
    });

    return parseReturnedDataSource(rows, "Creating a database datasource");
  });
}
