function quoteBigQueryString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function buildBigQueryRowMutationScript(input: {
  preconditionSql: string;
  mutationSql: string;
  expectedRows: string[];
  expectedAffectedRows: number;
}): string {
  const expectedRowsJson = quoteBigQueryString(
    JSON.stringify(input.expectedRows),
  );
  return `BEGIN TRANSACTION;\nASSERT (SELECT TO_JSON_STRING(ARRAY(SELECT TO_JSON_STRING(tf_row) FROM (${input.preconditionSql}) AS tf_row ORDER BY TO_JSON_STRING(tf_row)))) = ${expectedRowsJson} AS 'stale precondition';\n${input.mutationSql};\nASSERT @@row_count = ${input.expectedAffectedRows} AS 'affected row mismatch';\nCOMMIT TRANSACTION;`;
}

export function buildBigQueryBackfillScript(input: {
  preconditionSql: string;
  backfillSql: string;
  verificationSql: string;
  expectedRows: string[];
  expectedVerificationRows?: string[];
  expectedAffectedRows: number;
}): string {
  const expectedRowsJson = quoteBigQueryString(
    JSON.stringify(input.expectedRows),
  );
  const expectedVerificationRowsJson = quoteBigQueryString(
    JSON.stringify(input.expectedVerificationRows ?? input.expectedRows),
  );
  return `BEGIN TRANSACTION;\nASSERT (SELECT TO_JSON_STRING(ARRAY(SELECT TO_JSON_STRING(tf_row) FROM (${input.preconditionSql}) AS tf_row ORDER BY TO_JSON_STRING(tf_row)))) = ${expectedRowsJson} AS 'stale backfill precondition';\n${input.backfillSql};\nASSERT @@row_count = ${input.expectedAffectedRows} AS 'affected row mismatch';\nASSERT (SELECT TO_JSON_STRING(ARRAY(SELECT TO_JSON_STRING(tf_row) FROM (${input.verificationSql}) AS tf_row ORDER BY TO_JSON_STRING(tf_row)))) = ${expectedVerificationRowsJson} AS 'backfill verification mismatch';\nCOMMIT TRANSACTION;`;
}

export function bigQueryWorkflowEstimate(input: {
  paidReadBytesProcessed: string[];
  transactionBytesProcessed: string;
  identityLookupBytesProcessed?: string;
}): Record<string, unknown> {
  if (input.paidReadBytesProcessed.length === 0) {
    throw new Error("BigQuery paid-read cost evidence is unavailable.");
  }
  const paidReads = input.paidReadBytesProcessed.map((value) =>
    parseBytes(value, "BigQuery paid-read cost evidence is unavailable."),
  );
  const preview = paidReads.reduce((total, value) => total + value, 0n);
  const transaction = parseBytes(
    input.transactionBytesProcessed,
    "BigQuery transaction cost evidence is unavailable.",
  );
  const identity = input.identityLookupBytesProcessed
    ? parseBytes(
        input.identityLookupBytesProcessed,
        "BigQuery identity lookup cost evidence is unavailable.",
      )
    : 0n;
  const workflow = identity + preview + transaction;
  return {
    dryRunBytesProcessed: workflow.toString(),
    workflowBytesProcessed: workflow.toString(),
    previewBytesProcessed: preview.toString(),
    transactionBytesProcessed: transaction.toString(),
    ...(input.identityLookupBytesProcessed
      ? { identityLookupBytesProcessed: identity.toString() }
      : {}),
    paidReadJobBytesProcessed: paidReads.map(String),
    estimatedPaidJobs:
      paidReads.length + 1 + (input.identityLookupBytesProcessed ? 1 : 0),
  };
}

export function assertBigQueryWorkflowWithinLimit(
  estimate: Record<string, unknown>,
  maximumBytesBilled: string,
): void {
  const workflow = parseBytes(
    estimate.workflowBytesProcessed,
    "BigQuery workflow cost evidence is unavailable.",
  );
  const maximum = parseBytes(
    maximumBytesBilled,
    "BigQuery workflow cost limit is invalid.",
  );
  if (workflow > maximum) {
    throw new Error("SQL change exceeds the configured BigQuery cost limit.");
  }
}

function parseBytes(value: unknown, message: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(message);
  }
  return BigInt(value);
}
