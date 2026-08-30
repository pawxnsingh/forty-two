import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { ChatSessionIdSchema } from "./ids.js";

const TOKEN_PREFIX = "ftmcp1";
const MINIMUM_SIGNING_KEY_BYTES = 32;

const CapabilityClaimsSchema = z
  .object({
    sub: ChatSessionIdSchema,
    jti: z.string().trim().min(1).max(255),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine((claims) => claims.exp > claims.iat, {
    message: "Capability expiry must be after issuance.",
  });

export type ChatSessionCapabilityClaims = z.infer<
  typeof CapabilityClaimsSchema
>;

export type MintChatSessionCapabilityInput = {
  chatSessionId: string;
  capabilityId: string;
  expiresAt: Date;
  signingKey: string;
  issuedAt?: Date;
};

export function mintChatSessionCapability(
  input: MintChatSessionCapabilityInput,
): string {
  const key = signingKey(input.signingKey);
  const issuedAt = input.issuedAt ?? new Date();
  const claims = CapabilityClaimsSchema.parse({
    sub: input.chatSessionId,
    jti: input.capabilityId,
    iat: Math.floor(issuedAt.getTime() / 1_000),
    exp: Math.floor(input.expiresAt.getTime() / 1_000),
  });
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signingInput = `${TOKEN_PREFIX}.${payload}`;
  const signature = createHmac("sha256", key)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

export function verifyChatSessionCapability(input: {
  token: string;
  signingKey: string;
  now?: Date;
}): ChatSessionCapabilityClaims | null {
  try {
    const key = signingKey(input.signingKey);
    if (input.token.length > 4_096) return null;
    const [prefix, payload, suppliedSignature, extra] = input.token.split(".");
    if (
      prefix !== TOKEN_PREFIX ||
      !payload ||
      !suppliedSignature ||
      extra !== undefined
    ) {
      return null;
    }
    const signingInput = `${prefix}.${payload}`;
    const expectedSignature = createHmac("sha256", key)
      .update(signingInput)
      .digest();
    const supplied = Buffer.from(suppliedSignature, "base64url");
    if (
      supplied.length !== expectedSignature.length ||
      !timingSafeEqual(supplied, expectedSignature)
    ) {
      return null;
    }
    const claims = CapabilityClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
    if (claims.iat > nowSeconds + 60 || claims.exp <= nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}

function signingKey(value: string): Buffer {
  const key = Buffer.from(value, "utf8");
  if (key.length < MINIMUM_SIGNING_KEY_BYTES) {
    throw new Error(
      `MCP capability signing key must contain at least ${MINIMUM_SIGNING_KEY_BYTES} bytes.`,
    );
  }
  return key;
}
