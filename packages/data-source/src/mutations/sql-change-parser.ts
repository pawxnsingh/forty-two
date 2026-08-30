import { createHash } from "node:crypto";

import pkg from "node-sql-parser";

import type { QueryParameter } from "../types/query.js";
import type {
  ParsedSqlChange,
  SqlChangeDialect,
  SqlChangeOperation,
  SqlChangeTarget,
} from "./types.js";

const { Parser } = pkg;

type SqlLiteral = null | boolean | number | string;

const DIALECTS: Record<SqlChangeDialect, string> = {
  postgresql: "postgresql",
  mysql: "mysql",
  transactsql: "transactsql",
  snowflake: "snowflake",
  bigquery: "bigquery",
  redshift: "postgresql",
};

const IDENTIFIER = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[(?:[^\]]|\]\])+\])`;
const TARGET = `${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER}){0,2}`;

export function parseSqlChange(
  sql: string,
  dialect: SqlChangeDialect,
): ParsedSqlChange {
  const source = canonicalizeSource(sql);
  const lexical = parseLexical(source);
  validateWithDialectParser(source, dialect, lexical);
  const boundParameters = collectLiterals(source).map((value, index) => ({
    position: index + 1,
    type:
      value === null
        ? ("null" as const)
        : (typeof value as "boolean" | "number" | "string"),
    value,
  }));
  return {
    dialect,
    operation: lexical.operation,
    target: parseTarget(lexical.target),
    canonicalSql: source,
    boundParameters,
    whereSql: lexical.whereSql,
    assignments: lexical.assignments,
    insertValues: lexical.insertValues,
  };
}

export function sqlChangeStatementHash(input: {
  dialect: SqlChangeDialect;
  canonicalSql: string;
  boundParameters: ParsedSqlChange["boundParameters"];
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        dialect: input.dialect,
        sql: input.canonicalSql,
        parameters: input.boundParameters,
      }),
    )
    .digest("hex");
}

type LexicalChange = {
  operation: SqlChangeOperation;
  target: string;
  whereSql: string | null;
  assignments: Record<string, QueryParameter>;
  insertValues: Record<string, QueryParameter> | null;
};

function canonicalizeSource(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "").trim();
  if (!trimmed || trimmed.length > 100_000) {
    throw new Error("SQL change must contain one bounded statement.");
  }
  assertNoCommentsOrStatementSeparators(trimmed);
  return trimmed;
}

function assertNoCommentsOrStatementSeparators(source: string): void {
  let quote: "'" | '"' | "`" | "]" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      const closing = quote;
      if (character !== closing) continue;
      if (source[index + 1] === closing) {
        index += 1;
        continue;
      }
      quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (
      character === ";" ||
      pair === "--" ||
      pair === "/*" ||
      pair === "*/" ||
      pair === "//"
    ) {
      throw new Error(
        "Comments and multiple SQL statements are not supported.",
      );
    }
  }
}

function parseLexical(sql: string): LexicalChange {
  const insert = new RegExp(
    `^INSERT\\s+INTO\\s+(${TARGET})\\s*\\((.+)\\)\\s+VALUES\\s*\\((.+)\\)$`,
    "is",
  ).exec(sql);
  if (insert) {
    const columns = splitCommaList(insert[2]!).map(parseSimpleIdentifier);
    const values = splitCommaList(insert[3]!).map(parseLiteral);
    if (columns.length === 0 || columns.length !== values.length) {
      throw new Error("INSERT requires one explicit literal value per column.");
    }
    if (
      new Set(columns.map((value) => value.toLowerCase())).size !==
      columns.length
    ) {
      throw new Error("INSERT columns must be unique.");
    }
    return {
      operation: "insert",
      target: insert[1]!,
      whereSql: null,
      assignments: {},
      insertValues: Object.fromEntries(
        columns.map((column, index) => [column, values[index]!] as const),
      ),
    };
  }

  const update = new RegExp(
    `^UPDATE\\s+(${TARGET})\\s+SET\\s+(.+?)\\s+WHERE\\s+(.+)$`,
    "is",
  ).exec(sql);
  if (update) {
    const assignments = Object.fromEntries(
      splitCommaList(update[2]!).map((assignment) => {
        const match = new RegExp(`^(${IDENTIFIER})\\s*=\\s*(.+)$`, "is").exec(
          assignment,
        );
        if (!match)
          throw new Error("UPDATE assignments must set literal values.");
        return [
          parseSimpleIdentifier(match[1]!),
          parseLiteral(match[2]!),
        ] as const;
      }),
    );
    if (Object.keys(assignments).length === 0) {
      throw new Error("UPDATE requires at least one assignment.");
    }
    assertPredicate(update[3]!);
    return {
      operation: "update",
      target: update[1]!,
      whereSql: update[3]!.trim(),
      assignments,
      insertValues: null,
    };
  }

  const deletion = new RegExp(
    `^DELETE\\s+FROM\\s+(${TARGET})\\s+WHERE\\s+(.+)$`,
    "is",
  ).exec(sql);
  if (deletion) {
    assertPredicate(deletion[2]!);
    return {
      operation: "delete",
      target: deletion[1]!,
      whereSql: deletion[2]!.trim(),
      assignments: {},
      insertValues: null,
    };
  }
  throw new Error("Only one simple INSERT, UPDATE, or DELETE is supported.");
}

function validateWithDialectParser(
  source: string,
  dialect: SqlChangeDialect,
  lexical: LexicalChange,
): void {
  const parser = new Parser();
  let parserSource = source;
  if (dialect === "snowflake" && lexical.operation === "delete") {
    parserSource = `DELETE ${lexical.target} FROM ${lexical.target} WHERE ${lexical.whereSql}`;
  }
  let ast: unknown;
  try {
    ast = parser.astify(parserSource, { database: DIALECTS[dialect] });
  } catch {
    throw new Error(`The SQL change is not valid ${dialect} syntax.`);
  }
  if (Array.isArray(ast)) {
    if (ast.length !== 1)
      throw new Error("Exactly one SQL statement is required.");
    ast = ast[0];
  }
  if (!isRecord(ast) || ast.type !== lexical.operation) {
    throw new Error("The parsed SQL operation does not match the proposal.");
  }
  rejectUnsafeAst(ast);
}

function rejectUnsafeAst(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectUnsafeAst);
    return;
  }
  if (!isRecord(value)) return;
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (
    [
      "select",
      "function",
      "aggr_func",
      "case",
      "window_func",
      "cast",
      "interval",
      "assign",
    ].includes(type)
  ) {
    throw new Error(
      "Subqueries, functions, and computed expressions are not supported.",
    );
  }
  for (const nested of Object.values(value)) rejectUnsafeAst(nested);
}

function assertPredicate(predicate: string): void {
  if (
    !predicate.trim() ||
    /\b(?:SELECT|WITH|EXISTS|CALL|EXEC|MERGE)\b/i.test(predicate)
  ) {
    throw new Error("UPDATE and DELETE require one explicit simple predicate.");
  }
}

function parseTarget(value: string): SqlChangeTarget {
  const parts = splitQualifiedIdentifier(value).map(unquoteIdentifier);
  if (parts.length === 1) {
    return { catalog: null, schema: null, table: parts[0]!, sql: value.trim() };
  }
  if (parts.length === 2) {
    return {
      catalog: null,
      schema: parts[0]!,
      table: parts[1]!,
      sql: value.trim(),
    };
  }
  return {
    catalog: parts[0]!,
    schema: parts[1]!,
    table: parts[2]!,
    sql: value.trim(),
  };
}

function parseSimpleIdentifier(value: string): string {
  if (!new RegExp(`^${IDENTIFIER}$`, "is").test(value.trim())) {
    throw new Error("Only simple explicit column identifiers are supported.");
  }
  return unquoteIdentifier(value.trim());
}

function parseLiteral(value: string): SqlLiteral {
  const trimmed = value.trim();
  if (/^NULL$/i.test(trimmed)) return null;
  if (/^TRUE$/i.test(trimmed)) return true;
  if (/^FALSE$/i.test(trimmed)) return false;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (!Number.isFinite(number))
      throw new Error("Numeric literal is out of range.");
    return number;
  }
  if (/^'(?:[^']|'')*'$/.test(trimmed)) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  throw new Error(
    "Only NULL, boolean, finite number, and quoted string literals are supported.",
  );
}

function collectLiterals(source: string): SqlLiteral[] {
  const values: SqlLiteral[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (character === "'") {
      const end = scanQuotedToken(source, index, "'");
      values.push(parseLiteral(source.slice(index, end)));
      index = end;
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      index = scanQuotedToken(
        source,
        index,
        character === "[" ? "]" : character,
      );
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) {
        index += 1;
      }
      const word = source.slice(start, index);
      if (/^(?:NULL|TRUE|FALSE)$/i.test(word)) values.push(parseLiteral(word));
      continue;
    }
    const numeric = scanNumericToken(source, index);
    if (numeric) {
      values.push(parseLiteral(numeric.value));
      index = numeric.end;
      continue;
    }
    index += 1;
  }
  return values;
}

function scanQuotedToken(
  source: string,
  start: number,
  closing: "'" | '"' | "`" | "]",
): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === closing) {
      if (source[index + 1] === closing) index += 2;
      else return index + 1;
    } else {
      index += 1;
    }
  }
  throw new Error("Unterminated SQL literal or identifier.");
}

function scanNumericToken(
  source: string,
  start: number,
): { value: string; end: number } | null {
  const first = source[start]!;
  const signed = first === "-";
  const digitStart = signed ? start + 1 : start;
  if (!/[0-9]/.test(source[digitStart] ?? "")) return null;
  if (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1]!)) return null;
  let end = digitStart;
  while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
  if (source[end] === ".") {
    end += 1;
    while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
  }
  if (source[end] === "e" || source[end] === "E") {
    end += 1;
    if (source[end] === "+" || source[end] === "-") end += 1;
    while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
  }
  while (end < source.length && /[A-Za-z0-9_$]/.test(source[end]!)) {
    end += 1;
  }
  return {
    value: source.slice(start, end),
    end,
  };
}

function splitCommaList(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote || (quote === "]" && character === "]")) {
        if (value[index + 1] === character) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`")
      quote = character;
    else if (character === "[") quote = "]";
    else if (character === ",") {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote) throw new Error("Unterminated SQL literal or identifier.");
  result.push(value.slice(start).trim());
  if (result.some((part) => !part))
    throw new Error("SQL list contains an empty item.");
  return result;
}

function splitQualifiedIdentifier(value: string): string[] {
  return splitOutside(value, ".");
}

function splitOutside(value: string, separator: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: '"' | "`" | "]" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === character) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === '"' || character === "`") quote = character;
    else if (character === "[") quote = "]";
    else if (character === separator) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result;
}

function unquoteIdentifier(value: string): string {
  if (value.startsWith('"')) return value.slice(1, -1).replace(/""/g, '"');
  if (value.startsWith("`")) return value.slice(1, -1).replace(/``/g, "`");
  if (value.startsWith("[")) return value.slice(1, -1).replace(/]]/g, "]");
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
