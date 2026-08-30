import { and, eq, isNull } from "drizzle-orm";

import { getDatabase } from "../../database.js";
import { dataSourceCredentials, dataSources } from "../../schema/index.js";
import {
  DataSourceCredentialSchema,
  GetDataSourceInputSchema,
  type DataSourceCredential,
  type GetDataSourceInput,
} from "../../types.js";

export async function getDataSourceCredentials(
  input: GetDataSourceInput,
): Promise<DataSourceCredential | null> {
  const parsed = GetDataSourceInputSchema.parse(input);
  const rows = await getDatabase()
    .select({
      dataSourceId: dataSourceCredentials.dataSourceId,
      ciphertext: dataSourceCredentials.ciphertext,
      iv: dataSourceCredentials.iv,
      authTag: dataSourceCredentials.authTag,
      encryptionVersion: dataSourceCredentials.encryptionVersion,
      revision: dataSourceCredentials.revision,
      updatedAt: dataSourceCredentials.updatedAt,
    })
    .from(dataSourceCredentials)
    .innerJoin(
      dataSources,
      eq(dataSources.id, dataSourceCredentials.dataSourceId),
    )
    .where(
      and(
        eq(dataSourceCredentials.dataSourceId, parsed.dataSourceId),
        parsed.includeDeleted ? undefined : isNull(dataSources.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ? DataSourceCredentialSchema.parse(rows[0]) : null;
}
