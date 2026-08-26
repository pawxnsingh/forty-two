/**
 * Snowflake type mappings
 * Reference: https://docs.snowflake.com/en/sql-reference/data-types
 */

/**
 * Maps Snowflake type names to normalized type names
 * Snowflake returns type names as strings from the SDK
 */
export const SNOWFLAKE_TYPE_MAP: Record<string, string> = {
  // Numeric types
  NUMBER: "decimal",
  DECIMAL: "decimal",
  NUMERIC: "decimal",
  INT: "integer",
  INTEGER: "integer",
  BIGINT: "bigint",
  SMALLINT: "smallint",
  TINYINT: "smallint",
  BYTEINT: "smallint",

  // Floating point types
  FLOAT: "float",
  FLOAT4: "float",
  FLOAT8: "double",
  DOUBLE: "double",
  "DOUBLE PRECISION": "double",
  REAL: "float",

  // Fixed-point type (Snowflake internal representation)
  FIXED: "decimal", // Snowflake uses FIXED for NUMBER/DECIMAL internally

  // String types
  VARCHAR: "varchar",
  CHAR: "char",
  CHARACTER: "char",
  STRING: "text",
  TEXT: "text",

  // Binary types
  BINARY: "bytea",
  VARBINARY: "bytea",

  // Boolean type
  BOOLEAN: "boolean",

  // Date/Time types
  DATE: "date",
  DATETIME: "timestamp",
  TIME: "time",
  TIMESTAMP: "timestamp",
  TIMESTAMP_LTZ: "timestamptz",
  TIMESTAMP_NTZ: "timestamp",
  TIMESTAMP_TZ: "timestamptz",

  // Semi-structured types
  VARIANT: "json",
  OBJECT: "json",
  ARRAY: "array",

  // Geospatial types
  GEOGRAPHY: "geography",
  GEOMETRY: "geometry",
};

/**
 * Maps Snowflake type to a normalized type name
 * @param snowflakeType - Snowflake type string
 * @returns Normalized type name
 */
export function mapSnowflakeType(snowflakeType: string | number): string {
  if (!snowflakeType || typeof snowflakeType === "number") {
    return "text";
  }

  // Convert to uppercase for case-insensitive matching
  const upperType = snowflakeType.toUpperCase();

  // Handle parameterized types like NUMBER(38,0) or VARCHAR(100)
  const baseType = upperType.split("(")[0]?.trim() || upperType;

  // Look up in the type map
  return SNOWFLAKE_TYPE_MAP[baseType] || "text";
}

/**
 * Determines the simple type category for metadata
 * @param normalizedType - The normalized Snowflake type name
 * @returns Simple type category: 'number', 'text', or 'date'
 */
export function getSnowflakeSimpleType(
  normalizedType: string,
): "number" | "text" | "date" {
  const lowerType = normalizedType.toLowerCase();

  // Numeric types
  if (
    lowerType === "decimal" ||
    lowerType === "integer" ||
    lowerType === "bigint" ||
    lowerType === "smallint" ||
    lowerType === "float" ||
    lowerType === "double" ||
    lowerType.includes("int") ||
    lowerType.includes("numeric") ||
    lowerType.includes("number")
  ) {
    return "number";
  }

  // Date/time types
  if (
    lowerType.includes("date") ||
    lowerType.includes("time") ||
    lowerType.includes("timestamp")
  ) {
    return "date";
  }

  // Everything else is text
  return "text";
}
