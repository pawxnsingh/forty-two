import assert from "node:assert/strict";
import test from "node:test";

import {
  mintChatSessionCapability,
  verifyChatSessionCapability,
} from "../src/session-capability.js";

const signingKey = "capability-unit-test-key-that-is-long-enough";
const chatSessionId = "sess_01HZX000000000000000000000";

test("mints deterministic signed expiring session capability claims", () => {
  const issuedAt = new Date("2026-08-28T00:00:00.000Z");
  const expiresAt = new Date("2026-08-28T01:00:00.000Z");
  const token = mintChatSessionCapability({
    chatSessionId,
    capabilityId: "capability-1",
    issuedAt,
    expiresAt,
    signingKey,
  });
  assert.equal(
    token,
    mintChatSessionCapability({
      chatSessionId,
      capabilityId: "capability-1",
      issuedAt,
      expiresAt,
      signingKey,
    }),
  );
  assert.deepEqual(
    verifyChatSessionCapability({
      token,
      signingKey,
      now: new Date("2026-08-28T00:30:00.000Z"),
    }),
    {
      sub: chatSessionId,
      jti: "capability-1",
      iat: 1_787_875_200,
      exp: 1_787_878_800,
    },
  );
});

test("rejects tampered, expired, future-issued, and cross-key capabilities", () => {
  const token = mintChatSessionCapability({
    chatSessionId,
    capabilityId: "capability-1",
    issuedAt: new Date("2026-08-28T00:00:00.000Z"),
    expiresAt: new Date("2026-08-28T01:00:00.000Z"),
    signingKey,
  });
  for (const candidate of [`${token.slice(0, -1)}x`, "not-a-capability"]) {
    assert.equal(
      verifyChatSessionCapability({
        token: candidate,
        signingKey,
        now: new Date("2026-08-28T00:30:00.000Z"),
      }),
      null,
    );
  }
  assert.equal(
    verifyChatSessionCapability({
      token,
      signingKey,
      now: new Date("2026-08-28T01:00:00.000Z"),
    }),
    null,
  );
  assert.equal(
    verifyChatSessionCapability({
      token,
      signingKey,
      now: new Date("2026-08-27T23:58:00.000Z"),
    }),
    null,
  );
  assert.equal(
    verifyChatSessionCapability({
      token,
      signingKey: "a-different-signing-key-that-is-long-enough",
      now: new Date("2026-08-28T00:30:00.000Z"),
    }),
    null,
  );
});

test("refuses weak signing keys", () => {
  assert.throws(
    () =>
      mintChatSessionCapability({
        chatSessionId,
        capabilityId: "capability-1",
        expiresAt: new Date(Date.now() + 60_000),
        signingKey: "short",
      }),
    /at least 32 bytes/,
  );
});
