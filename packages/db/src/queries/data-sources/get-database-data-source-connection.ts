import { and, eq, isNull, sql } from "drizzle-orm";

import { getDatabase } from "../../database.js";
import { dataSourceCredentials, dataSources } from "../../schema/index.js";
import {
  CredentialEnvelopeSchema,
  DataSourceSchema,
  type DataSource,
  type DataSourceCredential,
} from "../../types.js";
import { DataSourceIdSchema } from "../../ids.js";

export interface DatabaseDataSourceConnection {
  dataSource: DatabaseDataSource;
  credentials: DataSourceCredential;
}

export type DatabaseDataSource = Exclude<
  DataSource,
  { connectorType: "csv" | "xlsx" }
>;

export const databaseDataSourceSelection = {
  id: dataSources.id,
  connectorType: dataSources.connectorType,
  name: dataSources.name,
  status: dataSources.status,
  config: dataSources.config,
  originalFilename: sql<string | null>`null`,
  mimeType: sql<string | null>`null`,
  fileSizeBytes: sql<number | null>`null`,
  azureBlobName: sql<string | null>`null`,
  azureETag: sql<string | null>`null`,
  azureCleanupStatus: sql<null>`null`,
  azureCleanupETag: sql<string | null>`null`,
  azureCleanupAttempts: sql<number>`0`,
  azureCleanupCompletedAt: sql<Date | null>`null`,
  azureCleanupErrorCode: sql<string | null>`null`,
  processingMessage: sql<string | null>`null`,
  createdAt: dataSources.createdAt,
  updatedAt: dataSources.updatedAt,
  deletedAt: dataSources.deletedAt,
};

export function parseDatabaseDataSource(value: unknown): DatabaseDataSource {
  const dataSource = DataSourceSchema.parse(value);
  if (
    dataSource.connectorType === "csv" ||
    dataSource.connectorType === "xlsx"
  ) {
    throw new Error("Expected a database datasource.");
  }
  return dataSource;
}

async function getDatabaseDataSourceConnection(
  dataSourceId: string,
  status: "testing" | "ready",
): Promise<DatabaseDataSourceConnection | null> {
  const parsedId = DataSourceIdSchema.parse(dataSourceId);
  const rows = await getDatabase()
    .select({
      dataSource: databaseDataSourceSelection,
      ciphertext: dataSourceCredentials.ciphertext,
      iv: dataSourceCredentials.iv,
      authTag: dataSourceCredentials.authTag,
      encryptionVersion: dataSourceCredentials.encryptionVersion,
      revision: dataSourceCredentials.revision,
      credentialUpdatedAt: dataSourceCredentials.updatedAt,
    })
    .from(dataSources)
    .innerJoin(
      dataSourceCredentials,
      eq(dataSourceCredentials.dataSourceId, dataSources.id),
    )
    .where(
      and(
        eq(dataSources.id, parsedId),
        eq(dataSources.status, status),
        isNull(dataSources.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const dataSource = parseDatabaseDataSource(row.dataSource);
  const envelope = CredentialEnvelopeSchema.parse(row);
  return {
    dataSource,
    credentials: {
      dataSourceId: parsedId,
      ...envelope,
      revision: row.revision,
      updatedAt: row.credentialUpdatedAt,
    },
  };
}

export function getReadyDatabaseDataSourceConnection(
  dataSourceId: string,
): Promise<DatabaseDataSourceConnection | null> {
  return getDatabaseDataSourceConnection(dataSourceId, "ready");
}

export function getTestingDatabaseDataSourceConnection(
  dataSourceId: string,
): Promise<DatabaseDataSourceConnection | null> {
  return getDatabaseDataSourceConnection(dataSourceId, "testing");
}
