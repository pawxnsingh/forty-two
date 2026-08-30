import assert from "node:assert/strict";
import test from "node:test";

import { reconcileStreamError } from "./turn-stream-lifecycle";

test("preserves live assistant events for empty or partial running history", async () => {
  const liveEvents = [
    { type: "assistant.message.started", messageId: "message-1" },
    {
      type: "assistant.message.delta",
      messageId: "message-1",
      text: "newer live text",
    },
  ];

  for (const history of [
    [],
    [{ type: "assistant.message.started", messageId: "message-1" }],
  ]) {
    let currentEvents = liveEvents;
    let closeCount = 0;
    await reconcileStreamError({
      loadHistory: async () => history,
      applyTerminalHistory: (events) => {
        currentEvents = events;
      },
      closeTerminalStream: () => {
        closeCount += 1;
      },
    });

    assert.strictEqual(currentEvents, liveEvents);
    assert.equal(closeCount, 0);
  }
});

test("preserves live state when history reconciliation fails", async () => {
  let applied = false;
  let closeCount = 0;

  await reconcileStreamError({
    loadHistory: async () => {
      throw new Error("history unavailable");
    },
    applyTerminalHistory: () => {
      applied = true;
    },
    closeTerminalStream: () => {
      closeCount += 1;
    },
  });

  assert.equal(applied, false);
  assert.equal(closeCount, 0);
});

test("closes the EventSource only after history is terminal", async () => {
  let closeCount = 0;
  let applied: Array<{ type: string }> = [];

  await reconcileStreamError({
    loadHistory: async () => [{ type: "turn.completed" }],
    applyTerminalHistory: (events) => {
      applied = events;
    },
    closeTerminalStream: () => {
      closeCount += 1;
    },
  });

  assert.deepEqual(applied, [{ type: "turn.completed" }]);
  assert.equal(closeCount, 1);
});
