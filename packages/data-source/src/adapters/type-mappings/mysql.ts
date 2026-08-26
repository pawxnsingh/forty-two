/**
 * MySQL type code to normalized type name mappings
 * These type codes are from the MySQL protocol
 * Reference: https://dev.mysql.com/doc/dev/mysql-server/latest/field__types_8h.html
 */

// MySQL type codes from mysql2 library
export const MYSQL_TYPE_CODE_MAP: Record<number, string> = {
  // Numeric types
  0: "decimal",
  1: "tinyint",
  2: "smallint",
  3: "integer",
  4: "float",
  5: "double",
  8: "bigint",
  9: "mediumint",
  246: "decimal", // NEWDECIMAL

  // Date and time types
  7: "timestamp",
  10: "date",
  11: "time",
  12: "datetime",
  13: "year",

  // String types
  15: "varchar", // VARCHAR
  16: "bit",
  247: "enum",
  248: "set",
  249: "tinyblob", // TINY_BLOB
  250: "mediumblob", // MEDIUM_BLOB
  251: "longblob", // LONG_BLOB
  252: "blob", // BLOB
  253: "varchar", // VAR_STRING
  254: "char", // STRING
  255: "geometry",

  // JSON type
  245: "json",
};

// Alternative mapping for text types that might appear differently
const TEXT_TYPE_ALIASES: Record<string, string> = {
  var_string: "varchar",
  string: "char",
  tiny_blob: "tinytext",
  medium_blob: "mediumtext",
  long_blob: "longtext",
  blob: "text",
  long: "integer", // LONG type is an integer type
};

/**
 * Maps MySQL type code or type string to a normalized type name
 * @param mysqlType - MySQL type as numeric code or string like "mysql_type_253"
 * @returns Normalized type name
 */
export function mapMySQLType(mysqlType: string | number): string {
  // Handle numeric type code
  if (typeof mysqlType === "number") {
    return MYSQL_TYPE_CODE_MAP[mysqlType] || "text";
  }

  // Handle string format "mysql_type_253"
  if (typeof mysqlType === "string") {
    const match = mysqlType.match(/^mysql_type_(\d+)$/);
    if (match?.[1]) {
      const typeCode = Number.parseInt(match[1], 10);
      return MYSQL_TYPE_CODE_MAP[typeCode] || "text";
    }

    // Check for text type aliases (handle both mysql_type_ prefix and plain types)
    const lowerType = mysqlType.toLowerCase();
    // Remove mysql_type_ prefix if present
    const cleanType = lowerType.replace(/^mysql_type_/, "");
    if (TEXT_TYPE_ALIASES[cleanType]) {
      return TEXT_TYPE_ALIASES[cleanType];
    }

    // If it's already a type name, return it
    return lowerType;
  }

  return "text";
}

/**
 * Determines the simple type category for metadata
 * @param normalizedType - The normalized MySQL type name
 * @returns Simple type category: 'number', 'text', or 'date'
 */
export function getMySQLSimpleType(
  normalizedType: string,
): "number" | "text" | "date" {
  const lowerType = normalizedType.toLowerCase();

  // Numeric types
  if (
    lowerType.includes("int") ||
    lowerType.includes("float") ||
    lowerType.includes("double") ||
    lowerType.includes("decimal") ||
    lowerType.includes("numeric") ||
    lowerType === "bit"
  ) {
    return "number";
  }

  // Date/time types
  if (
    lowerType.includes("date") ||
    lowerType.includes("time") ||
    lowerType === "year"
  ) {
    return "date";
  }

  // Everything else is text
  return "text";
}
