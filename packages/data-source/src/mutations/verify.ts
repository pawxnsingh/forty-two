import { hashMutationRow } from "./row-hash.js";

export function assertMutationPreconditions(
  rows: Record<string, unknown>[],
  expectedRowHashes: readonly string[],
): void {
  const actual = rows.map(hashMutationRow).sort();
  const expected = [...expectedRowHashes].sort();
  if (
    actual.length !== expected.length ||
    actual.some((hash, index) => hash !== expected[index])
  ) {
    const error = new Error("SQL change preconditions are stale.");
    error.name = "SqlChangeStaleError";
    throw error;
  }
}

export function assertAffectedRows(actual: number, expected: number): void {
  if (actual !== expected) {
    const error = new Error("SQL change affected-row verification failed.");
    error.name = "SqlChangeStaleError";
    throw error;
  }
}

export function verifiedRowEvidence(
  rows: Record<string, unknown>[],
  expectedRowHashes: readonly string[],
): Record<string, unknown> {
  assertMutationPreconditions(rows, expectedRowHashes);
  return {
    verifiedRows: rows.length,
    verifiedRowHashes: rows.map(hashMutationRow).sort(),
    verifiedSample: rows.slice(0, 10),
  };
}
