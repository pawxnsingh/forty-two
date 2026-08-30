import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChatSessionIdSchema, generateChatSessionId } from "../src/index.js";

describe("chat session ID generation", () => {
  it("generates unique sess_-prefixed ULIDs", () => {
    const first = generateChatSessionId();
    const second = generateChatSessionId();

    assert.match(first, /^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(second, /^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(first, second);
    assert.equal(ChatSessionIdSchema.parse(first), first);
  });

  it("rejects datasource, unprefixed, and malformed IDs", () => {
    assert.equal(
      ChatSessionIdSchema.safeParse("01ARZ3NDEKTSV4RRFFQ69G5FAV").success,
      false,
    );
    assert.equal(
      ChatSessionIdSchema.safeParse("ds_01ARZ3NDEKTSV4RRFFQ69G5FAV").success,
      false,
    );
    assert.equal(
      ChatSessionIdSchema.safeParse("sess_not-a-ulid").success,
      false,
    );
  });
});
