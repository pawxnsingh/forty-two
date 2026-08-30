import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { getDatabase } from "../../database.js";
import { dataSources } from "../../schema/index.js";
import { DATABASE_CONNECTOR_TYPES } from "../../types.js";
import {
  databaseDataSourceSelection,
  type DatabaseDataSource,
  parseDatabaseDataSource,
} from "./get-database-data-source-connection.js";

export async function listReadyDatabaseDataSources(): Promise<
  DatabaseDataSource[]
> {
  const rows = await getDatabase()
    .select(databaseDataSourceSelection)
    .from(dataSources)
    .where(
      and(
        eq(dataSources.status, "ready"),
        isNull(dataSources.deletedAt),
        inArray(dataSources.connectorType, DATABASE_CONNECTOR_TYPES),
      ),
    )
    .orderBy(asc(dataSources.createdAt), asc(dataSources.id));

  return rows.map(parseDatabaseDataSource);
}
