import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const nonce = randomUUID().slice(0, 8);
const image = `forty-two-web:smoke-${nonce}`;
const container = `forty-two-web-smoke-${nonce}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

async function waitForPage(url) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok) return response.text();
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError;
}

try {
  run("docker", [
    "build",
    "--file",
    "apps/web/Dockerfile",
    "--tag",
    image,
    ".",
  ]);
  run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--publish",
    "127.0.0.1::3000",
    image,
  ]);

  const binding = run(
    "docker",
    ["port", container, "3000/tcp"],
    { capture: true },
  );
  const port = binding.match(/:(\d+)$/)?.[1];
  assert.ok(port, `Docker did not publish a web port: ${binding}`);

  const origin = `http://127.0.0.1:${port}`;
  const connectorHtml = await waitForPage(`${origin}/connectors/new`);
  const chatHtml = await waitForPage(`${origin}/chat`);
  assert.match(connectorHtml, /Forty Two|New connector/);
  assert.match(chatHtml, /Forty Two/);

  console.log(`Production image smoke passed at ${origin}.`);
} finally {
  spawnSync("docker", ["stop", container], { stdio: "ignore" });
}
