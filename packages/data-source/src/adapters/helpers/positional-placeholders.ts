export interface PositionalPlaceholderConversion {
  sql: string;
  placeholderCount: number;
}

/**
 * Converts positional question-mark placeholders without touching SQL literals,
 * quoted identifiers, or comments.
 */
export function convertPositionalPlaceholders(
  sql: string,
  valueCount: number,
  replacement: (index: number) => string,
): PositionalPlaceholderConversion {
  let converted = "";
  let placeholderCount = 0;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === "-" && next === "-") {
      const end = findLineEnd(sql, index + 2);
      converted += sql.slice(index, end);
      index = end;
      continue;
    }

    // GoogleSQL accepts shell-style single-line comments.
    if (character === "#") {
      const end = findLineEnd(sql, index + 1);
      converted += sql.slice(index, end);
      index = end;
      continue;
    }

    if (character === "/" && next === "*") {
      const end = findBlockCommentEnd(sql, index);
      converted += sql.slice(index, end);
      index = end;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const end = findQuotedEnd(sql, index, character);
      converted += sql.slice(index, end);
      index = end;
      continue;
    }

    if (character === "[") {
      const end = findBracketIdentifierEnd(sql, index);
      converted += sql.slice(index, end);
      index = end;
      continue;
    }

    if (character === "?") {
      converted += replacement(placeholderCount);
      placeholderCount += 1;
      index += 1;
      continue;
    }

    converted += character;
    index += 1;
  }

  if (placeholderCount !== valueCount) {
    throw new Error(
      `SQL placeholder count (${placeholderCount}) does not match parameter count (${valueCount})`,
    );
  }

  return { sql: converted, placeholderCount };
}

function findLineEnd(sql: string, start: number): number {
  const lineEnd = sql.indexOf("\n", start);
  return lineEnd === -1 ? sql.length : lineEnd;
}

function findBlockCommentEnd(sql: string, start: number): number {
  let depth = 1;
  let index = start + 2;

  while (index < sql.length && depth > 0) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
      depth += 1;
      index += 2;
    } else if (sql[index] === "*" && sql[index + 1] === "/") {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }

  return index;
}

function findQuotedEnd(
  sql: string,
  start: number,
  quote: "'" | '"' | "`",
): number {
  let index = start + 1;

  while (index < sql.length) {
    if (sql[index] === "\\") {
      index = Math.min(index + 2, sql.length);
      continue;
    }

    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }

    index += 1;
  }

  return sql.length;
}

function findBracketIdentifierEnd(sql: string, start: number): number {
  let index = start + 1;

  while (index < sql.length) {
    if (sql[index] === "]") {
      if (sql[index + 1] === "]") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }

  return sql.length;
}
