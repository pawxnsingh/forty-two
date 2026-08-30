import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { ChatSessionIdSchema } from "./ids.js";

const TOKEN_PREFIX = "ftart1";
const SIGNING_DOMAIN = "forty-two:artifact-browser-capability:v1";
const MINIMUM_SIGNING_KEY_BYTES = 32;

const ArtifactBrowserCapabilityClaimsSchema = z
  .object({
    sub: ChatSessionIdSchema,
    jti: z.string().trim().min(1).max(255),
    scope: z.literal("artifacts:read"),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine((claims) => claims.exp > claims.iat, {
    message: "Capability expiry must be after issuance.",
  });

export type ArtifactBrowserCapabilityClaims = z.infer<
  typeof ArtifactBrowserCapabilityClaimsSchema
>;

export function mintArtifactBrowserCapability(input: {
  chatSessionId: string;
  capabilityId: string;
  expiresAt: Date;
  signingKey: string;
  issuedAt?: Date;
}): string {
  const key = signingKey(input.signingKey);
  const issuedAt = input.issuedAt ?? new Date();
  const claims = ArtifactBrowserCapabilityClaimsSchema.parse({
    sub: input.chatSessionId,
    jti: input.capabilityId,
    scope: "artifacts:read",
    iat: Math.floor(issuedAt.getTime() / 1_000),
    exp: Math.floor(input.expiresAt.getTime() / 1_000),
  });
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signingInput = `${TOKEN_PREFIX}.${payload}`;
  const signature = createHmac("sha256", key)
    .update(SIGNING_DOMAIN)
    .update("\0")
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

export function verifyArtifactBrowserCapability(input: {
  token: string;
  signingKey: string;
  now?: Date;
}): ArtifactBrowserCapabilityClaims | null {
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
      .update(SIGNING_DOMAIN)
      .update("\0")
      .update(signingInput)
      .digest();
    const supplied = Buffer.from(suppliedSignature, "base64url");
    if (
      supplied.length !== expectedSignature.length ||
      !timingSafeEqual(supplied, expectedSignature)
    ) {
      return null;
    }
    const claims = ArtifactBrowserCapabilityClaimsSchema.parse(
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
      `Artifact capability signing key must contain at least ${MINIMUM_SIGNING_KEY_BYTES} bytes.`,
    );
  }
  return key;
}
