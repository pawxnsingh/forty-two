import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_ITEM_STATUSES,
  SetChatSessionPlanInputSchema,
  SessionPlanSchema,
  UpdateChatSessionPlanItemInputSchema,
} from "../src/index.js";

const sessionId = "sess_01HZX000000000000000000000";

test("plan schemas enforce the public contract and content bounds", () => {
  assert.deepEqual(PLAN_ITEM_STATUSES, [
    "pending",
    "in_progress",
    "completed",
    "failed",
    "skipped",
  ]);
  assert.equal(
    SetChatSessionPlanInputSchema.parse({
      chatSessionId: sessionId,
      title: "Analysis",
      items: [{ text: "Inspect data" }],
    }).items[0]?.status,
    "pending",
  );
  assert.throws(() =>
    SessionPlanSchema.parse({
      title: "Too many",
      items: Array.from({ length: 16 }, (_, index) => ({
        text: `Step ${index}`,
        status: "pending",
      })),
    }),
  );
  assert.throws(() =>
    UpdateChatSessionPlanItemInputSchema.parse({
      chatSessionId: sessionId,
      itemIndex: 0,
      status: "unknown",
    }),
  );
});
