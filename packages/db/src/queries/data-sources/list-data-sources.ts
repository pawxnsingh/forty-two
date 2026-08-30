import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../database.js";
import { dataSources } from "../../schema/index.js";
import {
  DATA_SOURCE_TYPES,
  DataSourceTypeSchema,
  type DataSource,
} from "../../types.js";
import { DataSourceIdSchema } from "../../ids.js";
import { parseDataSource } from "./shared.js";

export const ListDataSourcesInputSchema = z.object({
  connectorTypes: z
    .array(DataSourceTypeSchema)
    .max(DATA_SOURCE_TYPES.length)
    .optional(),
  statuses: z
    .array(z.enum(["awaiting_upload", "testing", "ready", "failed"]))
    .max(4)
    .optional(),
  before: z
    .object({ createdAt: z.date(), id: DataSourceIdSchema })
    .strict()
    .optional(),
  limit: z.number().int().min(1).max(101).optional().default(50),
});

export type ListDataSourcesInput = z.input<typeof ListDataSourcesInputSchema>;

export async function listDataSources(
  input: ListDataSourcesInput = {},
): Promise<DataSource[]> {
  const parsed = ListDataSourcesInputSchema.parse(input);

  if (parsed.connectorTypes?.length === 0 || parsed.statuses?.length === 0) {
    return [];
  }

  const rows = await getDatabase()
    .select()
    .from(dataSources)
    .where(
      and(
        isNull(dataSources.deletedAt),
        parsed.connectorTypes
          ? inArray(dataSources.connectorType, parsed.connectorTypes)
          : undefined,
        parsed.statuses
          ? inArray(dataSources.status, parsed.statuses)
          : undefined,
        parsed.before
          ? or(
              lt(dataSources.createdAt, parsed.before.createdAt),
              and(
                eq(dataSources.createdAt, parsed.before.createdAt),
                lt(dataSources.id, parsed.before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(dataSources.createdAt), desc(dataSources.id))
    .limit(parsed.limit);

  return rows.map(parseDataSource);
}
