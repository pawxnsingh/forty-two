import assert from "node:assert/strict";
import test from "node:test";

import {
  mintArtifactBrowserCapability,
  verifyArtifactBrowserCapability,
} from "../src/artifact-browser-capability.js";
import { mintChatSessionCapability } from "../src/session-capability.js";

const signingKey = "artifact-capability-unit-test-key-long-enough";
const chatSessionId = "sess_01HZX000000000000000000000";

test("browser capabilities are scoped, expiring, and distinct from MCP capabilities", () => {
  const issuedAt = new Date("2026-08-28T00:00:00.000Z");
  const expiresAt = new Date("2026-08-28T01:00:00.000Z");
  const token = mintArtifactBrowserCapability({
    chatSessionId,
    capabilityId: "capability-1",
    issuedAt,
    expiresAt,
    signingKey,
  });
  assert.match(token, /^ftart1\./);
  assert.deepEqual(
    verifyArtifactBrowserCapability({
      token,
      signingKey,
      now: new Date("2026-08-28T00:30:00.000Z"),
    }),
    {
      sub: chatSessionId,
      jti: "capability-1",
      scope: "artifacts:read",
      iat: 1_787_875_200,
      exp: 1_787_878_800,
    },
  );
  const mcpToken = mintChatSessionCapability({
    chatSessionId,
    capabilityId: "capability-1",
    issuedAt,
    expiresAt,
    signingKey,
  });
  assert.equal(
    verifyArtifactBrowserCapability({
      token: mcpToken,
      signingKey,
      now: new Date("2026-08-28T00:30:00.000Z"),
    }),
    null,
  );
});

test("browser capabilities reject tampering and expiry", () => {
  const token = mintArtifactBrowserCapability({
    chatSessionId,
    capabilityId: "capability-1",
    issuedAt: new Date("2026-08-28T00:00:00.000Z"),
    expiresAt: new Date("2026-08-28T01:00:00.000Z"),
    signingKey,
  });
  assert.equal(
    verifyArtifactBrowserCapability({
      token: `${token.slice(0, -1)}x`,
      signingKey,
      now: new Date("2026-08-28T00:30:00.000Z"),
    }),
    null,
  );
  assert.equal(
    verifyArtifactBrowserCapability({
      token,
      signingKey,
      now: new Date("2026-08-28T01:00:00.000Z"),
    }),
    null,
  );
  assert.ok(
    verifyArtifactBrowserCapability({
      token,
      signingKey,
      now: new Date("2026-08-28T01:05:00.000Z"),
      allowExpiredForSeconds: 301,
    }),
  );
  assert.equal(
    verifyArtifactBrowserCapability({
      token,
      signingKey,
      now: new Date("2026-08-28T01:05:01.000Z"),
      allowExpiredForSeconds: 301,
    }),
    null,
  );
});
