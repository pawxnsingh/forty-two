/**
 * BigQuery type mappings
 * Reference: https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types
 */

/**
 * Maps BigQuery type names to normalized type names
 * BigQuery uses string type names rather than numeric codes
 */
export const BIGQUERY_TYPE_MAP: Record<string, string> = {
  // Numeric types
  INT64: "bigint",
  INTEGER: "bigint", // Alias for INT64
  FLOAT64: "float",
  FLOAT: "float", // Alias for FLOAT64
  NUMERIC: "decimal",
  DECIMAL: "decimal", // Alias for NUMERIC
  BIGNUMERIC: "decimal",
  BIGDECIMAL: "decimal", // Alias for BIGNUMERIC

  // Boolean type
  BOOL: "boolean",
  BOOLEAN: "boolean", // Alias for BOOL

  // String types
  STRING: "text",
  BYTES: "bytea",

  // Date/Time types
  DATE: "date",
  DATETIME: "datetime",
  TIME: "time",
  TIMESTAMP: "timestamp",

  // Complex types
  ARRAY: "array",
  STRUCT: "json", // Map STRUCT to json for simplicity
  GEOGRAPHY: "geography",
  JSON: "json",

  // Interval type
  INTERVAL: "interval",
};

/**
 * Maps BigQuery type to a normalized type name
 * @param bigqueryType - BigQuery type string
 * @returns Normalized type name
 */
export function mapBigQueryType(bigqueryType: string): string {
  if (!bigqueryType) {
    return "text";
  }

  // Convert to uppercase for case-insensitive matching
  const upperType = bigqueryType.toUpperCase();

  // Handle parameterized types like ARRAY<STRING> or STRUCT<...>
  if (upperType.startsWith("ARRAY<")) {
    return "array";
  }
  if (upperType.startsWith("STRUCT<")) {
    return "json";
  }

  // Look up in the type map
  return BIGQUERY_TYPE_MAP[upperType] || "text";
}

/**
 * Determines the simple type category for metadata
 * @param normalizedType - The normalized BigQuery type name
 * @returns Simple type category: 'number', 'text', or 'date'
 */
export function getBigQuerySimpleType(
  normalizedType: string,
): "number" | "text" | "date" {
  const lowerType = normalizedType.toLowerCase();

  // Numeric types
  if (
    lowerType.includes("int") ||
    lowerType.includes("float") ||
    lowerType.includes("decimal") ||
    lowerType.includes("numeric")
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
