import type { ConnectorType } from "./connector-registry";

export type DataSourceStatus =
  "awaiting_upload" | "testing" | "ready" | "failed";

export interface PublicDataSource {
  connectorType: ConnectorType;
  createdAt: string;
  fileSizeBytes: number | null;
  id: string;
  name: string;
  originalFilename: string | null;
  processingMessage: string | null;
  status: DataSourceStatus;
  updatedAt: string;
}

export interface ApiErrorPayload {
  error?: { code?: string; message?: string };
}
