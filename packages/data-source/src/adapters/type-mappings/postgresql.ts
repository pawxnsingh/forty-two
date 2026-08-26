/**
 * PostgreSQL OID to normalized type name mappings
 * These OIDs are stable across PostgreSQL versions
 * Reference: https://github.com/postgres/postgres/blob/master/src/include/catalog/pg_type.dat
 */

// Common PostgreSQL type OIDs
export const POSTGRESQL_TYPE_OID_MAP: Record<number, string> = {
  // Boolean type
  16: "boolean",

  // Numeric types
  20: "bigint", // int8
  21: "smallint", // int2
  23: "integer", // int4
  700: "float4", // real
  701: "float8", // double precision
  1700: "numeric", // decimal

  // String types
  18: "char",
  19: "name",
  25: "text",
  1042: "char", // bpchar
  1043: "varchar",

  // Date/time types
  1082: "date",
  1083: "time",
  1114: "timestamp", // timestamp without timezone
  1184: "timestamptz", // timestamp with timezone
  1186: "interval",
  1266: "timetz", // time with timezone

  // UUID
  2950: "uuid",

  // JSON types
  114: "json",
  3802: "jsonb",

  // Binary
  17: "bytea",

  // Money
  790: "money",

  // Network types
  869: "inet",
  650: "cidr",
  774: "macaddr",
  829: "macaddr8",

  // Geometric types
  600: "point",
  601: "lseg",
  602: "path",
  603: "box",
  604: "polygon",
  628: "line",
  718: "circle",

  // Array types (common ones)
  1000: "_bool", // boolean array
  1001: "_bytea", // bytea array
  1002: "_char", // char array
  1003: "_name", // name array
  1005: "_int2", // smallint array
  1007: "_int4", // integer array
  1009: "_text", // text array
  1014: "_bpchar", // char array
  1015: "_varchar", // varchar array
  1016: "_int8", // bigint array
  1021: "_float4", // float4 array
  1022: "_float8", // float8 array
  1115: "_timestamp", // timestamp array
  1182: "_date", // date array
  1183: "_time", // time array
  1185: "_timestamptz", // timestamptz array
  1231: "_numeric", // numeric array
  2951: "_uuid", // uuid array
  3807: "_jsonb", // jsonb array
};

/**
 * Maps PostgreSQL type OID or type string to a normalized type name
 * @param pgType - PostgreSQL type as OID number or string like "pg_type_1043"
 * @returns Normalized type name
 */
export function mapPostgreSQLType(pgType: string | number): string {
  // Handle numeric OID
  if (typeof pgType === "number") {
    return POSTGRESQL_TYPE_OID_MAP[pgType] || "text";
  }

  // Handle string format "pg_type_1043"
  if (typeof pgType === "string") {
    const match = pgType.match(/^pg_type_(\d+)$/);
    if (match?.[1]) {
      const oid = Number.parseInt(match[1], 10);
      return POSTGRESQL_TYPE_OID_MAP[oid] || "text";
    }

    // If it's already a type name, return it
    return pgType.toLowerCase();
  }

  return "text";
}

/**
 * Determines the simple type category for metadata
 * @param normalizedType - The normalized PostgreSQL type name
 * @returns Simple type category: 'number', 'text', or 'date'
 */
export function getPostgreSQLSimpleType(
  normalizedType: string,
): "number" | "text" | "date" {
  const lowerType = normalizedType.toLowerCase();

  // Numeric types
  if (
    lowerType.includes("int") ||
    lowerType.includes("float") ||
    lowerType.includes("numeric") ||
    lowerType.includes("decimal") ||
    lowerType.includes("real") ||
    lowerType.includes("double") ||
    lowerType === "money" ||
    lowerType === "bigint" ||
    lowerType === "smallint"
  ) {
    return "number";
  }

  // Date/time types
  if (
    lowerType.includes("date") ||
    lowerType.includes("time") ||
    lowerType.includes("interval")
  ) {
    return "date";
  }

  // Everything else is text
  return "text";
}
