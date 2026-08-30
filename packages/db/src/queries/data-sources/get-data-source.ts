import { and, eq, isNull } from "drizzle-orm";

import { getDatabase } from "../../database.js";
import { dataSources } from "../../schema/index.js";
import {
  GetDataSourceInputSchema,
  type DataSource,
  type GetDataSourceInput,
} from "../../types.js";
import { parseDataSource } from "./shared.js";

export async function getDataSource(
  input: GetDataSourceInput,
): Promise<DataSource | null> {
  const parsed = GetDataSourceInputSchema.parse(input);
  const rows = await getDatabase()
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.id, parsed.dataSourceId),
        parsed.includeDeleted ? undefined : isNull(dataSources.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ? parseDataSource(rows[0]) : null;
}
