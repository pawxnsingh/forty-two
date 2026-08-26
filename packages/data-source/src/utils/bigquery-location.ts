const DEFAULT_BIGQUERY_LOCATION = "US";
const BIGQUERY_LOCATION_PATTERN = /^[a-z][a-z0-9-]*$/i;

export function normalizeBigQueryLocation(location: unknown): string {
  if (location === undefined || location === null) {
    return DEFAULT_BIGQUERY_LOCATION;
  }
  if (typeof location !== "string") {
    throw new Error("BigQuery location must be a string");
  }

  const normalized = location.trim();
  if (!normalized) return DEFAULT_BIGQUERY_LOCATION;
  if (normalized.length > 128 || !BIGQUERY_LOCATION_PATTERN.test(normalized)) {
    throw new Error("BigQuery location is invalid");
  }

  return /^(?:us|eu)$/i.test(normalized)
    ? normalized.toUpperCase()
    : normalized.toLowerCase();
}

export function isValidBigQueryLocation(location: unknown): boolean {
  try {
    normalizeBigQueryLocation(location);
    return true;
  } catch {
    return false;
  }
}
