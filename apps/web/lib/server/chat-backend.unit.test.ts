import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiInputError,
  readRequestBodyWithinLimit,
  readTurnInput,
} from "./chat-backend";

test("multipart input is parsed only after its byte stream is bounded", async () => {
  const form = new FormData();
  form.set("message", "analyze this file");
  form.set("file", new File(["name,value\ncoffee,42\n"], "coffee.csv"));
  const message = await readTurnInput(
    new Request("http://localhost/turn", { method: "POST", body: form }),
  );
  assert.equal(message.type, "user.message");
  assert.ok(Array.isArray(message.content));
  assert.equal(message.content.length, 2);
});

test("declared oversized bodies are rejected before consuming their stream", async () => {
  const request = new Request("http://localhost/turn", {
    method: "POST",
    headers: { "content-length": "11" },
    body: new Uint8Array(1),
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    readRequestBodyWithinLimit(request, 10),
    (error: unknown) => error instanceof ApiInputError && error.status === 413,
  );
  assert.equal(request.bodyUsed, false);
});

test("chunked bodies are stopped as soon as their cumulative size exceeds the limit", async () => {
  let chunk = 0;
  const request = new Request("http://localhost/turn", {
    method: "POST",
    body: new ReadableStream({
      pull(controller) {
        chunk += 1;
        controller.enqueue(new Uint8Array(6));
        if (chunk === 3) controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    readRequestBodyWithinLimit(request, 10),
    (error: unknown) => error instanceof ApiInputError && error.status === 413,
  );
  assert.equal(chunk, 2);
});
