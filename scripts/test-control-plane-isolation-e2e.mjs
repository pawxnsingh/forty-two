import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const webUrl = normalizeUrl(process.env.WEB_URL ?? "http://127.0.0.1:3000");
const internalServiceProbes = [
  {
    composeService: "trueforge",
    name: "TrueForge control plane",
    url: process.env.TRUEFORGE_EXTERNAL_PROBE_URL ?? "http://127.0.0.1:8790",
  },
  {
    composeService: "data-source-mcp",
    name: "datasource MCP",
    url:
      process.env.DATA_SOURCE_MCP_EXTERNAL_PROBE_URL ?? "http://127.0.0.1:8791",
  },
  {
    composeService: "todo-mcp",
    name: "Todo MCP",
    url: process.env.TODO_MCP_EXTERNAL_PROBE_URL ?? "http://127.0.0.1:8792",
  },
].map((probe) => ({ ...probe, url: normalizeUrl(probe.url) }));

for (const probe of internalServiceProbes) {
  assertNoHostBinding(probe);
  let reachable = false;
  try {
    await fetch(`${probe.url}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    reachable = true;
  } catch {
    reachable = false;
  }
  assert.equal(reachable, false, `${probe.name} is reachable from the host.`);
}

await waitForWeb();

for (const body of [
  {
    agent: {
      spec: {
        mcp_servers: [{ name: "ft-session-victim" }],
      },
    },
  },
  {
    dataSourceIds: [],
    mcpServerName: "ft-session-victim",
  },
]) {
  const response = await fetch(`${webUrl}/api/chat/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(
    response.status,
    400,
    `The public session API accepted control-plane input (${response.status}).`,
  );
}

console.log(
  "Control-plane isolation passed: internal HTTP services have no Docker host bindings, are host-inaccessible, and Next.js rejects raw AgentSpecs/connectors.",
);

function assertNoHostBinding({ composeService, name }) {
  const containers = runDocker([
    "ps",
    "--filter",
    "status=running",
    "--filter",
    `label=com.docker.compose.project.working_dir=${process.cwd()}`,
    "--filter",
    `label=com.docker.compose.service=${composeService}`,
    "--format",
    "{{.ID}}",
  ])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  assert.equal(
    containers.length,
    1,
    `Expected exactly one running ${name} Compose container.`,
  );

  const containerId = containers[0];
  const networkMode = runDocker([
    "inspect",
    "--format",
    "{{.HostConfig.NetworkMode}}",
    containerId,
  ]).trim();
  assert.notEqual(networkMode, "host", `${name} uses the host network.`);

  const publishedPorts = runDocker(["port", containerId]).trim();
  assert.equal(
    publishedPorts,
    "",
    `${name} has Docker host bindings: ${publishedPorts}`,
  );
}

function runDocker(arguments_) {
  const result = spawnSync("docker", arguments_, { encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `Docker command failed: ${result.stderr.trim() || "unknown error"}`,
  );
  return result.stdout;
}

async function waitForWeb() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${webUrl}/api/data-sources`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The freshly recreated development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The public Next.js API did not become ready within 60 seconds.");
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("E2E URLs must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}
