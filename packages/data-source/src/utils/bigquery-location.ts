const DEFAULT_BIGQUERY_LOCATION = "US";

// Keep aligned with BigQuery's documented dataset and Omni locations.
const SUPPORTED_BIGQUERY_LOCATIONS = new Set([
  "US",
  "EU",
  "africa-south1",
  "asia-east1",
  "asia-east2",
  "asia-northeast1",
  "asia-northeast2",
  "asia-northeast3",
  "asia-south1",
  "asia-south2",
  "asia-southeast1",
  "asia-southeast2",
  "asia-southeast3",
  "australia-southeast1",
  "australia-southeast2",
  "europe-central2",
  "europe-north1",
  "europe-north2",
  "europe-southwest1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-west6",
  "europe-west8",
  "europe-west9",
  "europe-west10",
  "europe-west12",
  "me-central1",
  "me-central2",
  "me-west1",
  "northamerica-northeast1",
  "northamerica-northeast2",
  "northamerica-south1",
  "southamerica-east1",
  "southamerica-west1",
  "us-central1",
  "us-central2",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-south1",
  "us-west1",
  "us-west2",
  "us-west3",
  "us-west4",
  "aws-ap-northeast-2",
  "aws-ap-southeast-2",
  "aws-eu-central-1",
  "aws-eu-west-1",
  "aws-us-east-1",
  "aws-us-west-2",
  "azure-eastus2",
]);

export function normalizeBigQueryLocation(location: unknown): string {
  if (location === undefined || location === null) {
    return DEFAULT_BIGQUERY_LOCATION;
  }
  if (typeof location !== "string") {
    throw new Error("BigQuery location must be a string");
  }

  const normalized = location.trim();
  if (!normalized) return DEFAULT_BIGQUERY_LOCATION;
  const canonical = /^(?:us|eu)$/i.test(normalized)
    ? normalized.toUpperCase()
    : normalized.toLowerCase();
  if (!SUPPORTED_BIGQUERY_LOCATIONS.has(canonical)) {
    throw new Error("BigQuery location is invalid");
  }

  return canonical;
}

export function isValidBigQueryLocation(location: unknown): boolean {
  try {
    normalizeBigQueryLocation(location);
    return true;
  } catch {
    return false;
  }
}
