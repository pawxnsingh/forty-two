import ExcelJS from "exceljs";
import { z } from "zod";

export const CSV_MIME_TYPE = "text/csv";
export const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type SupportedFileType = "csv" | "xlsx";

export type InitiateFileDataSourceInput = {
  name: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  connectorType: SupportedFileType;
};

const InitiateFileBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    filename: z.string().trim().min(1).max(1024),
    mimeType: z.string().trim().min(1).max(255),
    fileSizeBytes: z.number().int().positive().safe(),
  })
  .strict();

export function sanitizeFileName(filename: string): string {
  const normalized = filename.normalize("NFKC").replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? "";

  if (
    !basename ||
    [...basename].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("filename is invalid.");
  }

  const extensionMatch = /\.(csv|xlsx)$/i.exec(basename);
  if (!extensionMatch) {
    throw new Error("filename must end in .csv or .xlsx.");
  }

  const extension = extensionMatch[1]!.toLowerCase();
  const stem = basename
    .slice(0, -extension.length - 1)
    .replaceAll(/[^A-Za-z0-9._ -]/g, "_")
    .replaceAll(/[ ]+/g, "_")
    .replaceAll(/_+/g, "_")
    .replaceAll(/^\.+|\.+$/g, "")
    .slice(0, 180);

  if (!stem || stem === "." || stem === "..") {
    throw new Error("filename must contain a safe basename.");
  }
  return `${stem}.${extension}`;
}

export function parseInitiateFileDataSourceInput(
  value: unknown,
  maxFileSizeBytes: number,
): InitiateFileDataSourceInput {
  const parsed = InitiateFileBodySchema.parse(value);
  if (parsed.fileSizeBytes > maxFileSizeBytes) {
    throw new Error(`fileSizeBytes must not exceed ${maxFileSizeBytes} bytes.`);
  }

  const filename = sanitizeFileName(parsed.filename);
  const connectorType: SupportedFileType = filename.endsWith(".csv")
    ? "csv"
    : "xlsx";
  const expectedMimeType =
    connectorType === "csv" ? CSV_MIME_TYPE : XLSX_MIME_TYPE;
  const mimeType = parsed.mimeType.toLowerCase();

  if (mimeType !== expectedMimeType) {
    throw new Error(
      `${connectorType.toUpperCase()} files require MIME type ${expectedMimeType}.`,
    );
  }

  return {
    ...parsed,
    filename,
    mimeType,
    connectorType,
  };
}

export async function validateUploadedFileContent(input: {
  buffer: Buffer;
  connectorType: SupportedFileType;
  maxFileSizeBytes: number;
}): Promise<void> {
  if (
    input.buffer.length === 0 ||
    input.buffer.length > input.maxFileSizeBytes
  ) {
    throw new Error("Uploaded file size is outside the allowed range.");
  }

  if (input.connectorType === "csv") {
    validateCsv(input.buffer);
    return;
  }

  await validateXlsx(input.buffer, input.maxFileSizeBytes);
}

function validateCsv(buffer: Buffer): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("CSV must be valid UTF-8 text.");
  }

  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (!text || text.includes("\0")) {
    throw new Error("CSV must contain text data.");
  }

  const rows = parseCsv(text);
  const header = rows[0];
  if (!header || header.length === 0) {
    throw new Error("CSV must contain a header row.");
  }

  const normalizedHeaders = header.map((column) => column.trim().toLowerCase());
  if (normalizedHeaders.some((column) => column.length === 0)) {
    throw new Error("CSV header names must be nonblank.");
  }
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
    throw new Error("CSV header names must be unique.");
  }

  for (const row of rows.slice(1)) {
    if (row.every((value) => value.trim() === "")) {
      continue;
    }
    if (row.length !== header.length) {
      throw new Error("CSV rows must match the header column count.");
    }
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  let endedWithNewline = false;

  const finishField = (): void => {
    row.push(field);
    field = "";
    quoteClosed = false;
  };
  const finishRow = (): void => {
    finishField();
    rows.push(row);
    row = [];
    if (rows.length > 100_000) {
      throw new Error("CSV contains too many rows.");
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    endedWithNewline = false;

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (
      quoteClosed &&
      character !== "," &&
      character !== "\r" &&
      character !== "\n"
    ) {
      throw new Error("CSV contains characters after a closing quote.");
    }
    if (character === '"') {
      if (field.length !== 0) {
        throw new Error("CSV quotes must begin at the start of a field.");
      }
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRow();
      endedWithNewline = true;
    } else if (character === "\r") {
      if (text[index + 1] !== "\n") {
        throw new Error("CSV carriage returns must be followed by line feeds.");
      }
      finishRow();
      index += 1;
      endedWithNewline = true;
    } else {
      field += character;
    }

    if (row.length > 10_000) {
      throw new Error("CSV contains too many columns.");
    }
  }

  if (quoted) {
    throw new Error("CSV contains an unterminated quoted field.");
  }
  if (!endedWithNewline || row.length > 0 || field.length > 0) {
    finishRow();
  }
  if (rows.reduce((count, current) => count + current.length, 0) > 1_000_000) {
    throw new Error("CSV contains too many cells.");
  }
  return rows;
}

async function validateXlsx(
  buffer: Buffer,
  maxFileSizeBytes: number,
): Promise<void> {
  validateXlsxContainer(buffer, maxFileSizeBytes);

  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS 4 declares Buffer using an older @types/node shape. The runtime
    // object is the same Node Buffer, so keep the compatibility cast local.
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
  } catch {
    throw new Error("XLSX workbook is corrupt or unreadable.");
  }

  if (workbook.worksheets.length === 0) {
    throw new Error("XLSX workbook must contain a worksheet.");
  }

  let totalCells = 0;
  let hasReadableWorksheet = false;
  for (const worksheet of workbook.worksheets) {
    totalCells +=
      worksheet.actualRowCount * Math.max(worksheet.actualColumnCount, 1);
    if (worksheet.actualRowCount > 0 && worksheet.actualColumnCount > 0) {
      hasReadableWorksheet = true;
    }
  }
  if (!hasReadableWorksheet) {
    throw new Error("XLSX workbook must contain a readable worksheet.");
  }
  if (totalCells > 1_000_000) {
    throw new Error("XLSX workbook contains too many cells.");
  }
}

function validateXlsxContainer(buffer: Buffer, maxFileSizeBytes: number): void {
  const minimumEocdSize = 22;
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (
    let offset = buffer.length - minimumEocdSize;
    offset >= searchStart;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("XLSX must be a complete ZIP container.");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (
    entryCount === 0 ||
    entryCount > 10_000 ||
    centralDirectoryOffset + centralDirectorySize > eocdOffset
  ) {
    throw new Error("XLSX ZIP directory is invalid or too large.");
  }

  const requiredEntries = new Set([
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
  ]);
  let worksheetEntryFound = false;
  let totalUncompressedSize = 0;
  let offset = centralDirectoryOffset;

  for (let entry = 0; entry < entryCount; entry += 1) {
    if (
      offset + 46 > eocdOffset ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw new Error("XLSX ZIP directory entry is invalid.");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + filenameLength;
    if (
      nameEnd > eocdOffset ||
      uncompressedSize === 0xffffffff ||
      flags & 0x1
    ) {
      throw new Error("XLSX ZIP entry is unsupported.");
    }

    const name = buffer.subarray(nameStart, nameEnd).toString("utf8");
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error("XLSX ZIP entry path is unsafe.");
    }
    requiredEntries.delete(name);
    worksheetEntryFound ||= /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
    totalUncompressedSize += uncompressedSize;

    const maximumUncompressedSize = Math.min(
      Math.max(maxFileSizeBytes * 20, maxFileSizeBytes),
      100 * 1024 * 1024,
    );
    if (totalUncompressedSize > maximumUncompressedSize) {
      throw new Error("XLSX expands beyond the validation limit.");
    }

    offset = nameEnd + extraLength + commentLength;
  }

  if (requiredEntries.size > 0 || !worksheetEntryFound) {
    throw new Error("XLSX is missing required workbook parts.");
  }
}
