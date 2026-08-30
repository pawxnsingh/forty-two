import { createHash } from "node:crypto";

import { z } from "zod";

export const MAX_ARTIFACT_ROWS = 10_000;
export const MAX_ARTIFACT_COLUMNS = 100;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_ARTIFACT_STRING_BYTES = 64 * 1024;
export const MAX_ARTIFACT_PREVIEW_ROWS = 30;
export const MAX_CHART_ROWS = 5_000;

export const TableColumnV1Schema = z
  .object({
    name: z.string().min(1).max(256),
    type: z.enum([
      "string",
      "number",
      "integer",
      "decimal",
      "boolean",
      "datetime",
      "json",
    ]),
    nullable: z.boolean(),
    encoding: z.enum(["json", "string"]).optional(),
  })
  .strict();

export const TableColumnsV1Schema = z
  .array(TableColumnV1Schema)
  .min(1)
  .max(MAX_ARTIFACT_COLUMNS)
  .superRefine((columns, context) => {
    const names = new Set<string>();
    columns.forEach((column, index) => {
      if (!column.name.trim() || names.has(column.name)) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: "Column names must be non-blank and unique",
        });
      }
      names.add(column.name);
    });
  });

export const TableHeaderV1Schema = z
  .object({
    $schema: z.literal("table.v1"),
    columns: TableColumnsV1Schema,
    rowCount: z.number().int().nonnegative().max(MAX_ARTIFACT_ROWS),
  })
  .strict();

export type TableColumnV1 = z.infer<typeof TableColumnV1Schema>;
export type TableHeaderV1 = z.infer<typeof TableHeaderV1Schema>;

export type SourceColumnMetadata = {
  name: string;
  type: string;
  nullable: boolean;
  precision?: number;
  scale?: number;
  length?: number;
};

export type CanonicalTableV1 = {
  bytes: Buffer;
  contentSha256: string;
  byteSize: number;
  rowCount: number;
  columns: TableColumnV1[];
  preview: Record<string, unknown>[];
  rows: Record<string, unknown>[];
};

function canonicalJsonValue(value: unknown, path: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_ARTIFACT_STRING_BYTES) {
      throw new Error(`${path} exceeds the 64 KiB string-cell limit.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error(`${path} is an invalid date.`);
    return value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    throw new Error(`${path} contains unsupported binary data.`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      canonicalJsonValue(item, `${path}[${index}]`),
    );
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalJsonValue(record[key], `${path}.${key}`)]),
    );
  }
  throw new Error(`${path} contains an unsupported value.`);
}

function assertCellMatchesColumn(
  value: unknown,
  column: TableColumnV1,
  rowIndex: number,
): void {
  const path = `rows[${rowIndex}].${column.name}`;
  if (value === null) {
    if (!column.nullable) throw new Error(`${path} cannot be null.`);
    return;
  }
  switch (column.type) {
    case "string":
      if (typeof value !== "string")
        throw new Error(`${path} must be a string.`);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${path} must be a finite number.`);
      }
      return;
    case "integer":
      if (
        column.encoding === "string"
          ? typeof value !== "string" || !/^-?\d+$/.test(value)
          : typeof value !== "number" || !Number.isSafeInteger(value)
      ) {
        throw new Error(`${path} must be a safely encoded integer.`);
      }
      return;
    case "decimal":
      if (
        typeof value !== "string" ||
        !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
      ) {
        throw new Error(`${path} must be a decimal string.`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean")
        throw new Error(`${path} must be boolean.`);
      return;
    case "datetime":
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        throw new Error(`${path} must be an ISO-compatible datetime string.`);
      }
      return;
    case "json":
      return;
  }
}

function normalizeRows(
  rawRows: readonly Record<string, unknown>[],
  columns: readonly TableColumnV1[],
): Record<string, unknown>[] {
  if (rawRows.length > MAX_ARTIFACT_ROWS) {
    throw new Error(`Table exceeds the ${MAX_ARTIFACT_ROWS}-row limit.`);
  }
  const names = columns.map((column) => column.name);
  const expected = new Set(names);
  return rawRows.map((rawRow, rowIndex) => {
    const keys = Object.keys(rawRow);
    if (
      keys.length !== names.length ||
      keys.some((key) => !expected.has(key))
    ) {
      throw new Error(
        `rows[${rowIndex}] does not match the declared table columns.`,
      );
    }
    const row = Object.fromEntries(
      columns.map((column) => {
        const value = canonicalJsonValue(
          rawRow[column.name],
          `rows[${rowIndex}].${column.name}`,
        );
        assertCellMatchesColumn(value, column, rowIndex);
        return [column.name, value] as const;
      }),
    );
    return row;
  });
}

export function serializeCanonicalTableV1(input: {
  columns: readonly TableColumnV1[];
  rows: readonly Record<string, unknown>[];
}): CanonicalTableV1 {
  const columns = TableColumnsV1Schema.parse(input.columns);
  const rows = normalizeRows(input.rows, columns);
  const header: TableHeaderV1 = {
    $schema: "table.v1",
    columns,
    rowCount: rows.length,
  };
  const serialized =
    [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join(
      "\n",
    ) + "\n";
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("Canonical table exceeds the 5 MiB artifact limit.");
  }
  return {
    bytes,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
    rowCount: rows.length,
    columns,
    preview: rows.slice(0, MAX_ARTIFACT_PREVIEW_ROWS),
    rows,
  };
}

export function parseCanonicalTableV1(
  input: Uint8Array,
  expected?: {
    contentSha256?: string;
    byteSize?: number;
    rowCount?: number;
    columns?: readonly TableColumnV1[];
  },
): CanonicalTableV1 {
  const bytes = Buffer.from(input);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("Canonical table exceeds the 5 MiB artifact limit.");
  }
  if (
    expected?.byteSize !== undefined &&
    expected.byteSize !== bytes.byteLength
  ) {
    throw new Error("Artifact byte size does not match the upload receipt.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text = decoder.decode(bytes);
  if (!text.endsWith("\n"))
    throw new Error("Canonical table must end with a newline.");
  const lines = text.slice(0, -1).split("\n");
  if (!lines[0]) throw new Error("Canonical table header is missing.");
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(lines[0]);
  } catch {
    throw new Error("Canonical table header is invalid JSON.");
  }
  const header = TableHeaderV1Schema.parse(headerValue);
  const rawRows = lines.slice(1).map((line, index) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error();
      }
      return value as Record<string, unknown>;
    } catch {
      throw new Error(`Canonical table row ${index + 1} is invalid JSON.`);
    }
  });
  if (rawRows.length !== header.rowCount) {
    throw new Error("Canonical table row count does not match its header.");
  }
  const canonical = serializeCanonicalTableV1({
    columns: header.columns,
    rows: rawRows,
  });
  if (!canonical.bytes.equals(bytes)) {
    throw new Error("Artifact payload is not canonical table.v1 JSON Lines.");
  }
  if (
    expected?.contentSha256 &&
    canonical.contentSha256 !== expected.contentSha256
  ) {
    throw new Error("Artifact SHA-256 does not match the upload receipt.");
  }
  if (
    expected?.rowCount !== undefined &&
    canonical.rowCount !== expected.rowCount
  ) {
    throw new Error("Artifact row count does not match the upload receipt.");
  }
  if (
    expected?.columns &&
    JSON.stringify(canonical.columns) !==
      JSON.stringify(TableColumnsV1Schema.parse(expected.columns))
  ) {
    throw new Error("Artifact columns do not match the upload receipt.");
  }
  return canonical;
}

export function inferTableColumnsV1(
  rows: readonly Record<string, unknown>[],
): TableColumnV1[] {
  if (!rows[0]) throw new Error("Cannot infer columns from an empty table.");
  const names = Object.keys(rows[0]);
  if (names.length === 0 || names.length > MAX_ARTIFACT_COLUMNS) {
    throw new Error("Table must contain between 1 and 100 columns.");
  }
  return names.map((name) => {
    if (!name.trim()) throw new Error("Table column names cannot be blank.");
    const values = rows
      .map((row) => row[name])
      .filter((value) => value != null);
    const nullable = values.length !== rows.length;
    let type: TableColumnV1["type"] = "string";
    let encoding: TableColumnV1["encoding"];
    if (values.length === 0) type = "string";
    else if (values.every((value) => typeof value === "boolean"))
      type = "boolean";
    else if (
      values.every(
        (value) => typeof value === "number" && Number.isSafeInteger(value),
      )
    )
      type = "integer";
    else if (values.every((value) => typeof value === "number"))
      type = "number";
    else if (values.every((value) => typeof value === "bigint")) {
      type = "integer";
      encoding = "string";
    } else if (values.every((value) => value instanceof Date))
      type = "datetime";
    else if (
      values.some(
        (value) => typeof value === "object" && !(value instanceof Date),
      )
    )
      type = "json";
    else if (!values.every((value) => typeof value === "string")) {
      throw new Error(`Column '${name}' contains inconsistent scalar types.`);
    }
    return { name, type, nullable, ...(encoding ? { encoding } : {}) };
  });
}

function canonicalTypeForSourceColumn(
  column: SourceColumnMetadata,
): Pick<TableColumnV1, "type" | "encoding"> {
  const type = column.type
    .toLowerCase()
    .trim()
    .replace(/\s*\(.*/, "");
  if (/^(decimal|numeric|number|bigdecimal|money|smallmoney)$/.test(type)) {
    return { type: "decimal", encoding: "string" };
  }
  if (/^(bigint|int8|int64|uint64|long)$/.test(type)) {
    return { type: "integer", encoding: "string" };
  }
  if (
    /^(tinyint|smallint|integer|int|int2|int4|uint8|uint16|uint32)$/.test(type)
  ) {
    return { type: "integer" };
  }
  if (
    /^(float|float4|float8|double|double precision|real|binary_double|binary_float)$/.test(
      type,
    )
  ) {
    return { type: "number" };
  }
  if (/^(bool|boolean|bit)$/.test(type)) return { type: "boolean" };
  if (
    /^(date|datetime|datetime2|datetimeoffset|smalldatetime|timestamp|timestamptz|timestamp_ntz|timestamp_ltz|timestamp_tz)$/.test(
      type,
    )
  ) {
    return { type: "datetime" };
  }
  if (
    /^(json|jsonb|array|object|record|struct|variant|geography)$/.test(type)
  ) {
    return { type: "json" };
  }
  return { type: "string" };
}

/** Serialize query rows using connector metadata instead of value-only inference. */
export function serializeQueryResultTableV1(input: {
  columns: readonly SourceColumnMetadata[];
  rows: readonly Record<string, unknown>[];
}): CanonicalTableV1 {
  if (input.columns.length === 0) {
    throw new Error("Query result must declare at least one column.");
  }
  const columns = input.columns.map<TableColumnV1>((source) => ({
    name: source.name,
    nullable: source.nullable,
    ...canonicalTypeForSourceColumn(source),
  }));
  const normalizedRows = input.rows.map((rawRow) =>
    Object.fromEntries(
      columns.map((column) => {
        const value = rawRow[column.name];
        if (value == null) return [column.name, null];
        if (column.type === "decimal") return [column.name, String(value)];
        if (column.type === "integer" && column.encoding === "string") {
          return [column.name, String(value)];
        }
        if (column.type === "integer" && typeof value === "string") {
          const numeric = Number(value);
          if (!Number.isSafeInteger(numeric) || String(numeric) !== value) {
            column.encoding = "string";
            return [column.name, value];
          }
          return [column.name, numeric];
        }
        if (column.type === "datetime" && value instanceof Date) {
          return [column.name, value.toISOString()];
        }
        return [column.name, value];
      }),
    ),
  );
  // A later unsafe integer row can promote the column; normalize earlier rows too.
  for (const column of columns) {
    if (column.type !== "integer" || column.encoding !== "string") continue;
    for (const row of normalizedRows) {
      if (row[column.name] != null) row[column.name] = String(row[column.name]);
    }
  }
  return serializeCanonicalTableV1({ columns, rows: normalizedRows });
}
