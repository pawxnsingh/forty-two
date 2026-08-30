import { z } from "zod";

const DEFAULT_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const DEFAULT_UPLOAD_SAS_TTL_SECONDS = 300;

const PositiveIntegerEnvironmentSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());

export type FileDataSourceServerConfig = {
  azureAccountName: string;
  azureAccountKey: string;
  azureContainer: string;
  allowedOrigins: string[];
  maxFileSizeBytes: number;
  uploadSasTtlSeconds: number;
};

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseIntegerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  const result = raw
    ? PositiveIntegerEnvironmentSchema.safeParse(raw)
    : { success: true as const, data: fallback };

  if (!result.success) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  const value = result.data;

  if (value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function parseAllowedOrigins(value: string): string[] {
  const origins = [...new Set(value.split(",").map((origin) => origin.trim()))]
    .filter(Boolean)
    .map((origin) => {
      if (origin.includes("*")) {
        throw new Error(
          "AZURE_STORAGE_ALLOWED_ORIGINS cannot contain wildcards.",
        );
      }
      const url = new URL(origin);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(
          "AZURE_STORAGE_ALLOWED_ORIGINS entries must use HTTP or HTTPS.",
        );
      }
      if (url.origin !== origin.replace(/\/$/, "")) {
        throw new Error(
          "AZURE_STORAGE_ALLOWED_ORIGINS entries must be exact origins without paths.",
        );
      }
      return url.origin;
    });

  if (origins.length === 0) {
    throw new Error("AZURE_STORAGE_ALLOWED_ORIGINS must contain an origin.");
  }
  return origins.sort();
}

export function readFileDataSourceServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FileDataSourceServerConfig {
  const azureAccountName = requiredEnvironment(
    environment,
    "AZURE_STORAGE_ACCOUNT_NAME",
  );
  const azureContainer = requiredEnvironment(
    environment,
    "AZURE_STORAGE_CONTAINER",
  );

  if (!/^[a-z0-9]{3,24}$/.test(azureAccountName)) {
    throw new Error("AZURE_STORAGE_ACCOUNT_NAME is invalid.");
  }
  if (
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(azureContainer) ||
    azureContainer.includes("--")
  ) {
    throw new Error("AZURE_STORAGE_CONTAINER is invalid.");
  }

  return {
    azureAccountName,
    azureAccountKey: requiredEnvironment(
      environment,
      "AZURE_STORAGE_ACCOUNT_KEY",
    ),
    azureContainer,
    allowedOrigins: parseAllowedOrigins(
      environment.AZURE_STORAGE_ALLOWED_ORIGINS?.trim() ||
        "http://localhost:3000",
    ),
    maxFileSizeBytes: parseIntegerEnvironment(
      environment,
      "DATA_SOURCE_MAX_FILE_SIZE_BYTES",
      DEFAULT_MAX_FILE_SIZE_BYTES,
      1_024,
      Number.MAX_SAFE_INTEGER,
    ),
    uploadSasTtlSeconds: parseIntegerEnvironment(
      environment,
      "AZURE_STORAGE_UPLOAD_SAS_TTL_SECONDS",
      DEFAULT_UPLOAD_SAS_TTL_SECONDS,
      60,
      900,
    ),
  };
}
