import type { DataSourceRow } from "../../schema/index.js";
import { DataSourceSchema, type DataSource } from "../../types.js";

export function parseDataSource(row: DataSourceRow): DataSource {
  return DataSourceSchema.parse(row);
}

export function parseReturnedDataSource(
  rows: DataSourceRow[],
  operation: string,
): DataSource {
  const row = rows[0];

  if (!row) {
    throw new Error(`${operation} did not return a datasource row.`);
  }

  return parseDataSource(row);
}
