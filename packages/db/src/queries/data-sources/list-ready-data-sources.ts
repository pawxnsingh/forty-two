import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { getDatabase } from "../../database.js";
import { dataSources } from "../../schema/index.js";
import {
  ListReadyDataSourcesInputSchema,
  type DataSource,
  type ListReadyDataSourcesInput,
} from "../../types.js";
import { parseDataSource } from "./shared.js";

export async function listReadyDataSources(
  input: ListReadyDataSourcesInput = {},
): Promise<DataSource[]> {
  const parsed = ListReadyDataSourcesInputSchema.parse(input);

  if (
    parsed.dataSourceIds?.length === 0 ||
    parsed.connectorTypes?.length === 0
  ) {
    return [];
  }

  const rows = await getDatabase()
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.status, "ready"),
        isNull(dataSources.deletedAt),
        parsed.dataSourceIds
          ? inArray(dataSources.id, parsed.dataSourceIds)
          : undefined,
        parsed.connectorTypes
          ? inArray(dataSources.connectorType, parsed.connectorTypes)
          : undefined,
      ),
    )
    .orderBy(asc(dataSources.createdAt), asc(dataSources.id));

  return rows.map(parseDataSource);
}
