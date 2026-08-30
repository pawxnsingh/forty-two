import { createHash } from "node:crypto";

import { ulid } from "ulid";
import { z } from "zod";

const ULID_PATTERN = "[0-7][0-9A-HJKMNP-TV-Z]{25}";

export const DataSourceIdSchema = z
  .string()
  .regex(new RegExp(`^ds_${ULID_PATTERN}$`), "Invalid datasource ID");

export const ChatSessionIdSchema = z
  .string()
  .regex(new RegExp(`^sess_${ULID_PATTERN}$`), "Invalid chat session ID");

export const AnalysisArtifactIdSchema = z
  .string()
  .regex(new RegExp(`^art_${ULID_PATTERN}$`), "Invalid analysis artifact ID");

export const SqlChangeSetIdSchema = z
  .string()
  .regex(new RegExp(`^change_${ULID_PATTERN}$`), "Invalid SQL change-set ID");

export const SqlChangeExecutionIdSchema = z
  .string()
  .regex(
    new RegExp(`^changeexec_${ULID_PATTERN}$`),
    "Invalid SQL change execution ID",
  );

export type DataSourceId = z.infer<typeof DataSourceIdSchema>;
export type ChatSessionId = z.infer<typeof ChatSessionIdSchema>;
export type AnalysisArtifactId = z.infer<typeof AnalysisArtifactIdSchema>;
export type SqlChangeSetId = z.infer<typeof SqlChangeSetIdSchema>;
export type SqlChangeExecutionId = z.infer<typeof SqlChangeExecutionIdSchema>;

export function generateDataSourceId(): DataSourceId {
  return DataSourceIdSchema.parse(`ds_${ulid()}`);
}

export function generateChatSessionId(): ChatSessionId {
  return ChatSessionIdSchema.parse(`sess_${ulid()}`);
}

export function generateSqlChangeSetId(): SqlChangeSetId {
  return SqlChangeSetIdSchema.parse(`change_${ulid()}`);
}

export function generateSqlChangeExecutionId(): SqlChangeExecutionId {
  return SqlChangeExecutionIdSchema.parse(`changeexec_${ulid()}`);
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeCrockfordUlid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("ULID input must be 128 bits.");
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let output = "";
  for (let index = 0; index < 26; index += 1) {
    output = CROCKFORD_BASE32[Number(value & 31n)] + output;
    value >>= 5n;
  }
  return output;
}

/**
 * Derive an opaque, stable artifact id from an already-canonical identity.
 * The caller must include the application session id in `identity`; doing so
 * makes identical payloads in different sessions unlinkable.
 */
export function deriveAnalysisArtifactId(identity: string): AnalysisArtifactId {
  const digest = createHash("sha256")
    .update(identity, "utf8")
    .digest()
    .subarray(0, 16);
  return AnalysisArtifactIdSchema.parse(`art_${encodeCrockfordUlid(digest)}`);
}
