/**
 * Helper functions to fix BigQuery SQL syntax issues
 */

/**
 * Escapes BigQuery identifiers that contain special characters (like hyphens)
 * by wrapping them in backticks if not already escaped.
 *
 * BigQuery requires backticks for:
 * - Project IDs with hyphens (e.g., `analytics-project`)
 * - Reserved keywords used as identifiers
 * - Identifiers with special characters
 */
export function fixBigQueryTableReferences(sql: string): string {
  // Pattern to match table references in various formats:
  // 1. project.dataset.table (unquoted)
  // 2. project-with-hyphens.dataset.table (needs fixing)
  // 3. `project`.dataset.table (partially quoted)
  // 4. `project.dataset.table` (fully quoted - leave as is)

  // Pattern to match table references in various SQL contexts
  // Use word boundaries to avoid matching partial words
  const tableReferencePattern =
    /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([^\s,;()]+)/gi;

  let fixedSql = sql;
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
  }> = [];

  let match: RegExpExecArray | null = tableReferencePattern.exec(sql);
  while (match !== null) {
    const fullTableRef = match[1];
    if (!fullTableRef) {
      match = tableReferencePattern.exec(sql);
      continue; // Safety check
    }

    // Skip if already fully quoted with backticks
    if (fullTableRef.startsWith("`") && fullTableRef.endsWith("`")) {
      match = tableReferencePattern.exec(sql);
      continue;
    }

    // Check if this table reference needs escaping
    const fixedRef = escapeTableReference(fullTableRef);

    if (fixedRef !== fullTableRef) {
      const startIndex = match.index + match[0].indexOf(fullTableRef);
      const endIndex = startIndex + fullTableRef.length;
      replacements.push({
        start: startIndex,
        end: endIndex,
        replacement: fixedRef,
      });
    }

    match = tableReferencePattern.exec(sql);
  }

  // Apply replacements in reverse order to maintain correct indices
  for (let i = replacements.length - 1; i >= 0; i--) {
    const item = replacements[i];
    if (!item) continue; // Safety check
    const { start, end, replacement } = item;
    fixedSql =
      fixedSql.substring(0, start) + replacement + fixedSql.substring(end);
  }

  return fixedSql;
}

/**
 * Escapes a single table reference if needed
 */
function escapeTableReference(tableRef: string): string {
  // Remove any alias (e.g., "table_name alias" or "table_name AS alias")
  const aliasMatch = tableRef.match(/^([^\s]+)(?:\s+(?:AS\s+)?(\w+))?$/i);
  let tablePart = tableRef;
  let aliasPart = "";

  if (aliasMatch?.[1]) {
    tablePart = aliasMatch[1];
    aliasPart = aliasMatch[2] ? ` ${aliasMatch[2]}` : "";
  }

  // Check if it's a multi-part name (project.dataset.table or dataset.table)
  const parts = tablePart.split(".");

  if (parts.length >= 2) {
    // Check each part for special characters that need escaping
    const escapedParts = parts.map((part, index) => {
      // Remove existing backticks if any
      const cleanPart = part.replace(/^`|`$/g, "");

      // For BigQuery, we primarily need to escape identifiers with hyphens
      // Don't escape common table/dataset names unless they have special chars
      if (needsBackticks(cleanPart, index === parts.length - 1)) {
        return `\`${cleanPart}\``;
      }

      return cleanPart;
    });

    return escapedParts.join(".") + aliasPart;
  }

  // For single-part names, check if it needs escaping
  const cleanTableName = tablePart.replace(/^`|`$/g, "");
  if (needsBackticks(cleanTableName, true)) {
    return `\`${cleanTableName}\`${aliasPart}`;
  }

  return tableRef;
}

/**
 * Determines if an identifier needs backticks
 * @param identifier The identifier to check
 * @param isTableName Whether this is the table name (last part of the reference)
 */
function needsBackticks(identifier: string, isTableName = false): boolean {
  // Check for hyphens or other special characters (not underscore or alphanumeric)
  if (/[^a-zA-Z0-9_]/.test(identifier)) {
    return true;
  }

  // Check if starts with a number
  if (/^\d/.test(identifier)) {
    return true;
  }

  // Only check for reserved keywords if it's being used as a table/dataset name
  // and it exactly matches a reserved keyword (not just contains one)
  if (isTableName) {
    // Limited set of truly problematic reserved keywords when used as table names
    const problematicKeywords = [
      "SELECT",
      "FROM",
      "WHERE",
      "JOIN",
      "GROUP",
      "ORDER",
      "UNION",
      "WITH",
      "AS",
      "ON",
      "AND",
      "OR",
      "NOT",
      "NULL",
      "TRUE",
      "FALSE",
      "CASE",
      "WHEN",
      "THEN",
    ];

    if (problematicKeywords.includes(identifier.toUpperCase())) {
      return true;
    }
  }

  return false;
}
