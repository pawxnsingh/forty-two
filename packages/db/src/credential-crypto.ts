import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { DataSourceIdSchema } from "./ids.js";
import {
  CredentialEnvelopeSchema,
  DatabaseConnectorTypeSchema,
  DatabaseSecretSchema,
  type CredentialEnvelope,
  type DatabaseConnectorType,
  type DatabaseSecret,
} from "./types.js";

export const DATA_SOURCE_CREDENTIAL_ENCRYPTION_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptDatabaseSecretInput {
  dataSourceId: string;
  connectorType: DatabaseConnectorType;
  secret: DatabaseSecret;
  encryptionKey: string;
}

export interface DecryptDatabaseSecretInput {
  dataSourceId: string;
  connectorType: DatabaseConnectorType;
  credentials: CredentialEnvelope;
  encryptionKey: string;
}

export function encryptDatabaseSecret(
  input: EncryptDatabaseSecretInput,
): CredentialEnvelope {
  const dataSourceId = DataSourceIdSchema.parse(input.dataSourceId);
  const connectorType = DatabaseConnectorTypeSchema.parse(input.connectorType);
  const secret = DatabaseSecretSchema.parse(input.secret);
  if (secret.connectorType !== connectorType) {
    throw new Error(
      "Credential connector does not match datasource connector.",
    );
  }

  const encryptionVersion = DATA_SOURCE_CREDENTIAL_ENCRYPTION_VERSION;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    parseEncryptionKey(input.encryptionKey),
    iv,
    { authTagLength: AUTH_TAG_BYTES },
  );
  cipher.setAAD(
    buildAdditionalAuthenticatedData(
      dataSourceId,
      connectorType,
      encryptionVersion,
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secret), "utf8"),
    cipher.final(),
  ]);

  return CredentialEnvelopeSchema.parse({
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    encryptionVersion,
  });
}

export function decryptDatabaseSecret(
  input: DecryptDatabaseSecretInput,
): DatabaseSecret {
  const dataSourceId = DataSourceIdSchema.parse(input.dataSourceId);
  const connectorType = DatabaseConnectorTypeSchema.parse(input.connectorType);
  const credentials = CredentialEnvelopeSchema.parse(input.credentials);
  if (
    credentials.encryptionVersion !== DATA_SOURCE_CREDENTIAL_ENCRYPTION_VERSION
  ) {
    throw new Error("Unsupported datasource credential encryption version.");
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      parseEncryptionKey(input.encryptionKey),
      decodeBase64Url(credentials.iv, IV_BYTES),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(
      buildAdditionalAuthenticatedData(
        dataSourceId,
        connectorType,
        credentials.encryptionVersion,
      ),
    );
    decipher.setAuthTag(decodeBase64Url(credentials.authTag, AUTH_TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(credentials.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const secret = DatabaseSecretSchema.parse(JSON.parse(plaintext));
    if (secret.connectorType !== connectorType) {
      throw new Error("Credential connector mismatch.");
    }
    return secret;
  } catch {
    throw new Error("Datasource credentials could not be decrypted.");
  }
}

function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(
      "DATA_SOURCE_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.",
    );
  }
  return key;
}

function buildAdditionalAuthenticatedData(
  dataSourceId: string,
  connectorType: DatabaseConnectorType,
  encryptionVersion: number,
): Buffer {
  return Buffer.from(
    JSON.stringify({ dataSourceId, connectorType, encryptionVersion }),
    "utf8",
  );
}

function decodeBase64Url(value: string, expectedLength: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedLength) {
    throw new Error("Invalid encrypted credential envelope.");
  }
  return decoded;
}
