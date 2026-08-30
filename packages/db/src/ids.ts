import { createHash } from "node:crypto";

import { ulid } from "ulid";
import { z } from "zod";

const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

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
export type SqlChangeExecutionId = z.infer<
  typeof SqlChangeExecutionIdSchema
>;

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

function encodeCrockfordBase32(bytes: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < length) {
      output += CROCKFORD_BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0 && output.length < length) {
    output += CROCKFORD_BASE32[(value << (5 - bits)) & 31];
  }
  return output.slice(0, length);
}

/**
 * Derive an opaque, stable artifact id from an already-canonical identity.
 * The caller must include the application session id in `identity`; doing so
 * makes identical payloads in different sessions unlinkable.
 */
export function deriveAnalysisArtifactId(identity: string): AnalysisArtifactId {
  const digest = createHash("sha256").update(identity, "utf8").digest();
  return AnalysisArtifactIdSchema.parse(
    `art_${encodeCrockfordBase32(digest, 26)}`,
  );
}
