import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDatabase } from "../../database.js";
import { dataSourceCredentials, dataSources } from "../../schema/index.js";
import {
  DataSourceCredentialSchema,
  RotateDataSourceCredentialsInputSchema,
  type DataSourceCredential,
  type RotateDataSourceCredentialsInput,
} from "../../types.js";

export async function rotateDataSourceCredentials(
  input: RotateDataSourceCredentialsInput,
): Promise<DataSourceCredential | null> {
  const parsed = RotateDataSourceCredentialsInputSchema.parse(input);

  return getDatabase().transaction(async (transaction) => {
    const parents = await transaction
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(
        and(
          eq(dataSources.id, parsed.dataSourceId),
          inArray(dataSources.connectorType, [
            "postgresql",
            "mysql",
            "sqlserver",
            "snowflake",
            "bigquery",
            "redshift",
          ]),
          isNull(dataSources.deletedAt),
        ),
      )
      .limit(1)
      .for("update");

    if (!parents[0]) {
      throw new Error(
        "Credentials can only be stored for an active PostgreSQL datasource.",
      );
    }

    const rows = await transaction
      .update(dataSourceCredentials)
      .set({
        ...parsed.credentials,
        revision: sql`${dataSourceCredentials.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dataSourceCredentials.dataSourceId, parsed.dataSourceId),
          eq(dataSourceCredentials.revision, parsed.expectedRevision),
        ),
      )
      .returning();
    const row = rows[0];

    if (!row) {
      return null;
    }

    await transaction
      .update(dataSources)
      .set({ updatedAt: row.updatedAt })
      .where(eq(dataSources.id, parsed.dataSourceId));

    return DataSourceCredentialSchema.parse(row);
  });
}

export const upsertDataSourceCredentials = rotateDataSourceCredentials;
