import { readFile } from "node:fs/promises";

const trueforgeUrl = requiredUrl("TRUEFORGE_INTERNAL_URL");
const dataSourceMcpUrl = requiredUrl("DATA_SOURCE_MCP_INTERNAL_URL");
const daytonaApiKey = requiredSecret("DAYTONA_API_KEY");
const openaiApiKey = requiredSecret("OPENAI_API_KEY");
const mcpAuthToken = requiredSecret("MCP_AUTH_TOKEN");
const agentName = requiredSecret("FORTY_TWO_AGENT_NAME");
const agentSpecPath = requiredSecret("FORTY_TWO_AGENT_SPEC_PATH");

const modelCatalog = await requestJson(
  `${trueforgeUrl}/api/v1/catalogs/model-providers`,
);
const openaiCatalog = modelCatalog.data?.find(
  (provider) => provider.type === "openai",
);
if (!openaiCatalog || !Array.isArray(openaiCatalog.models)) {
  throw new Error("TrueForge's model catalog does not contain OpenAI.");
}
await requestJson(`${trueforgeUrl}/api/v1/settings/model-providers`, {
  method: "PUT",
  body: {
    manifest: {
      type: "openai",
      auth: { api_key: openaiApiKey },
      base_url: "https://api.openai.com/v1",
      models: openaiCatalog.models,
    },
  },
});
console.log(
  `TrueForge OpenAI provider configured (${openaiCatalog.models.length} models).`,
);

const sandboxProvider = await requestJson(
  `${trueforgeUrl}/api/v1/settings/sandbox-providers`,
  {
    method: "PUT",
    body: {
      manifest: {
        type: "daytona",
        auth: { api_key: daytonaApiKey },
        exec_timeout_ms: 60_000,
        auto_stop_interval_in_minutes: 5,
        auto_archive_interval_in_minutes: 60,
        auto_delete_interval_in_minutes: 7_200,
      },
    },
  },
);

const sandboxStatus = sandboxProvider.data?.status;
if (sandboxStatus !== "ready" && sandboxStatus !== "pending") {
  throw new Error(
    `TrueForge returned an invalid Daytona status: ${String(sandboxStatus)}`,
  );
}
console.log(`TrueForge Daytona provider configured (${sandboxStatus}).`);

const mcpName = "forty-two-data-source";
await requestJson(`${trueforgeUrl}/api/v1/settings/mcp-servers`, {
  method: "PUT",
  body: {
    manifest: {
      type: "remote",
      name: mcpName,
      url: `${dataSourceMcpUrl}/mcp`,
      description: "Read-only access to configured Forty Two data sources",
      auth: {
        type: "header",
        headers: { Authorization: `Bearer ${mcpAuthToken}` },
      },
    },
  },
});

const toolsResponse = await requestJson(
  `${trueforgeUrl}/api/v1/mcp-servers/${encodeURIComponent(mcpName)}/tools`,
);
const tools = toolsResponse.data;
if (!Array.isArray(tools) || tools.length === 0) {
  throw new Error("TrueForge did not discover any datasource MCP tools.");
}
console.log(
  `TrueForge datasource MCP configured (${tools.length} tools discovered).`,
);

await waitForSandboxReady();

const agentManifest = JSON.parse(await readFile(agentSpecPath, "utf8"));
const agentsResponse = await requestJson(`${trueforgeUrl}/api/v1/agents`);
const existingAgent = agentsResponse.data?.find(
  (agent) => agent.name === agentName,
);
if (existingAgent) {
  await requestJson(
    `${trueforgeUrl}/api/v1/agents/${encodeURIComponent(existingAgent.id)}`,
    { method: "PUT", body: { manifest: agentManifest } },
  );
  console.log(`TrueForge agent updated (${agentName}).`);
} else {
  await requestJson(`${trueforgeUrl}/api/v1/agents`, {
    method: "POST",
    body: { name: agentName, manifest: agentManifest },
  });
  console.log(`TrueForge agent created (${agentName}).`);
}

async function waitForSandboxReady() {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const response = await requestJson(
      `${trueforgeUrl}/api/v1/settings/sandbox-providers`,
    );
    const status = response.data?.status;
    if (status === "ready") return;
    if (status === "failed") {
      throw new Error(
        `Daytona sandbox image failed: ${String(response.data?.status_reason ?? "unknown error")}`,
      );
    }
    await delay(5_000);
  }
  throw new Error("Daytona sandbox image was not ready within ten minutes.");
}

function requiredSecret(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredUrl(name) {
  const value = requiredSecret(name);
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${name} must be a valid HTTP(S) URL.`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  return url.toString().replace(/\/$/, "");
}

async function requestJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const responseBody = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = responseBody?.error?.message;
    throw new Error(
      typeof message === "string"
        ? `TrueForge request failed (${response.status}): ${message}`
        : `TrueForge request failed (${response.status}).`,
    );
  }
  return responseBody;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
