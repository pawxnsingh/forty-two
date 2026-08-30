import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  CSV_MIME_TYPE,
  parseInitiateFileDataSourceInput,
  sanitizeFileName,
  validateUploadedFileContent,
  XLSX_MIME_TYPE,
} from "./file-validation";

test("initiate validation sanitizes a basename and enforces type agreement", () => {
  assert.equal(
    sanitizeFileName("../../quarterly report.CSV"),
    "quarterly_report.csv",
  );
  assert.deepEqual(
    parseInitiateFileDataSourceInput(
      {
        name: "Quarterly report",
        filename: "quarterly.csv",
        mimeType: CSV_MIME_TYPE,
        fileSizeBytes: 42,
      },
      1_024,
    ),
    {
      name: "Quarterly report",
      filename: "quarterly.csv",
      mimeType: CSV_MIME_TYPE,
      fileSizeBytes: 42,
      connectorType: "csv",
    },
  );
  assert.throws(
    () =>
      parseInitiateFileDataSourceInput(
        {
          name: "Fake",
          filename: "fake.xlsx",
          mimeType: CSV_MIME_TYPE,
          fileSizeBytes: 10,
        },
        1_024,
      ),
    /XLSX files require MIME type/,
  );
  assert.throws(
    () =>
      parseInitiateFileDataSourceInput(
        {
          name: "Large",
          filename: "large.csv",
          mimeType: CSV_MIME_TYPE,
          fileSizeBytes: 1_025,
        },
        1_024,
      ),
    /must not exceed/,
  );
});

test("CSV validation accepts quoted UTF-8 and rejects malformed headers and rows", async () => {
  await validateUploadedFileContent({
    buffer: Buffer.from('name,notes\nAda,"hello, world"\n'),
    connectorType: "csv",
    maxFileSizeBytes: 1_024,
  });

  for (const content of [
    "name, NAME\nAda,Lovelace\n",
    "name, \nAda,Lovelace\n",
    "name,age\nAda\n",
    'name,age\n"Ada,36\n',
  ]) {
    await assert.rejects(
      validateUploadedFileContent({
        buffer: Buffer.from(content),
        connectorType: "csv",
        maxFileSizeBytes: 1_024,
      }),
    );
  }
});

test("XLSX validation uses a real workbook parser and rejects fake ZIP content", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Data");
  worksheet.addRow(["name", "value"]);
  worksheet.addRow(["dummy42", 42]);
  const output = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(output as unknown as Uint8Array);

  await validateUploadedFileContent({
    buffer,
    connectorType: "xlsx",
    maxFileSizeBytes: 1024 * 1024,
  });
  await assert.rejects(
    validateUploadedFileContent({
      buffer: Buffer.from("PK\u0003\u0004this is not an xlsx workbook"),
      connectorType: "xlsx",
      maxFileSizeBytes: 1024 * 1024,
    }),
    /complete ZIP container/,
  );
});

test("XLSX MIME type constant is the standard Open XML media type", () => {
  assert.equal(
    XLSX_MIME_TYPE,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
});
