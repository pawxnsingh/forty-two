import assert from "node:assert/strict";
import test from "node:test";

import {
  collectCursorPages,
  resolvedApproval,
  retryableApproval,
  sourceScopeLabel,
  submittingApproval,
} from "./chat-ui-state";

test("keeps connector names visible when a session remounts", () => {
  assert.equal(
    sourceScopeLabel([{ name: "Coffee sales" }], "Session sources"),
    "Coffee sales",
  );
  assert.equal(
    sourceScopeLabel([{ name: "Sales" }, { name: "Costs" }], "Session sources"),
    "2 sources",
  );
  assert.equal(sourceScopeLabel([], "Session sources"), "Session sources");
});

test("collects every conversation page in cursor order", async () => {
  const requested: Array<string | null> = [];
  const turns = await collectCursorPages(async (pageToken) => {
    requested.push(pageToken);
    return pageToken === null
      ? { data: ["turn-1", "turn-2"], pagination: { nextPageToken: "next" } }
      : { data: ["turn-3"], pagination: { nextPageToken: null } };
  });

  assert.deepEqual(requested, [null, "next"]);
  assert.deepEqual(turns, ["turn-1", "turn-2", "turn-3"]);
});

test("rejects a repeated cursor instead of looping forever", async () => {
  await assert.rejects(
    collectCursorPages(async () => ({
      data: ["turn"],
      pagination: { nextPageToken: "same" },
    })),
    /repeated a page token/,
  );
});

test("failed approval submission restores retryable controls", () => {
  const submitting = submittingApproval(new Map(), "call-1", "allow");
  assert.equal(submitting.get("call-1")?.status, "submitting");

  const retryable = retryableApproval(submitting, "call-1");
  assert.equal(retryable.has("call-1"), false);
});

test("successful approval keeps the decision visible", () => {
  const resolved = resolvedApproval(new Map(), "call-1", "deny");
  assert.deepEqual(resolved.get("call-1"), {
    decision: "deny",
    status: "resolved",
  });
});
