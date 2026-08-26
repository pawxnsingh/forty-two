export type IdentifierDialect =
  "bigquery" | "mysql" | "postgresql" | "redshift" | "snowflake" | "sqlserver";

export function quoteIdentifier(
  identifier: string,
  dialect: IdentifierDialect,
): string {
  switch (dialect) {
    case "bigquery":
      return `\`${identifier.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
    case "mysql":
      return `\`${identifier.replace(/`/g, "``")}\``;
    case "sqlserver":
      return `[${identifier.replace(/]/g, () => "]]")}]`;
    case "postgresql":
    case "redshift":
    case "snowflake":
      return `"${identifier.replace(/"/g, '""')}"`;
  }
}

export function quoteQualifiedIdentifier(
  identifiers: readonly string[],
  dialect: IdentifierDialect,
): string {
  return identifiers
    .map((identifier) => quoteIdentifier(identifier, dialect))
    .join(".");
}

export function quoteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
