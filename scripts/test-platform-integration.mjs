import assert from "node:assert/strict";
import { createRequire } from "node:module";

const requireFromMcp = createRequire(
  new URL("../apps/data-source-mcp/package.json", import.meta.url),
);
const { Client } = requireFromMcp("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireFromMcp(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);

const trueforgeUrl = normalizeUrl(
  process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790",
);
const dataSourceMcpUrl = normalizeUrl(
  process.env.DATA_SOURCE_MCP_URL ?? "http://127.0.0.1:8791",
);
const mcpAuthToken = requiredEnvironment("MCP_AUTH_TOKEN");
const agentName =
  process.env.FORTY_TWO_AGENT_NAME?.trim() || "forty-two-data-agent";

let sessionId;
let primaryError;

try {
  await assertSharedTransportFailsClosedWithoutActiveSession();
  await assertSharedConnectorReady();
  await assertNamedAgentCannotCallDatasource();
  console.log(
    "Platform security integration passed: shared transport requires an active bound application session.",
  );
} catch (error) {
  primaryError = error;
} finally {
  let cleanupError;
  if (sessionId) {
    const response = await requestTrueForge(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", allowStatuses: [204, 404] },
    ).catch((error) => {
      cleanupError = error;
    });
    void response;
  }
  if (primaryError || cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError].filter(Boolean),
      "Platform security integration failed or cleanup was incomplete.",
    );
  }
}

async function assertSharedTransportFailsClosedWithoutActiveSession() {
  const client = new Client({ name: "platform-security", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${dataSourceMcpUrl}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${mcpAuthToken}` } } },
  );
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(
      tools.tools.every((tool) =>
        tool.inputSchema.required?.includes("sessionId"),
      ),
    );
    for (const applicationSessionId of [
      "sess_01HZX000000000000000000099",
      "sess_01HZX000000000000000000098",
    ]) {
      const response = await client.callTool({
        name: "list_data_sources",
        arguments: { sessionId: applicationSessionId },
      });
      assert.equal(response.isError, true);
    }
  } finally {
    await client.close();
  }
}

async function assertSharedConnectorReady() {
  const response = await requestTrueForge(
    "/api/v1/mcp-servers/forty-two-data-source/tools",
    {},
  );
  assert.equal(response.status, 200);
  assert.ok(
    response.body.data.some((tool) => tool.name === "finalize_chart_artifact"),
  );
  assert.equal(
    response.body.data.some((tool) => tool.name === "visualize"),
    false,
  );
}

async function assertNamedAgentCannotCallDatasource() {
  const agents = await requestTrueForge("/api/v1/agents");
  const agent = agents.body.data.find(
    (candidate) => candidate.name === agentName,
  );
  assert.ok(agent, `Configured agent ${agentName} was not found.`);
  const servers =
    agent.manifest?.mcpServers ?? agent.manifest?.mcp_servers ?? [];
  assert.equal(
    servers.some((server) => server.name === "forty-two-data-source"),
    true,
    "The callable named agent is missing the shared datasource connector.",
  );

  const created = await requestTrueForge("/api/v1/sessions", {
    method: "POST",
    body: { agent: { name: agentName } },
  });
  sessionId = String(created.body.data?.id ?? "");
  assert.ok(sessionId);

  const createdTurn = await requestTrueForge(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      method: "POST",
      body: {
        stream: false,
        input: [
          {
            type: "user.message",
            content:
              'Call list_data_sources and then run SQL "SELECT 1" against local-postgres. Report only actual tool results.',
          },
        ],
      },
    },
  );
  const turnId = String(createdTurn.body.data?.id ?? "");
  assert.ok(turnId);
  let turn = createdTurn.body.data;
  const deadline = Date.now() + 90_000;
  while (turn.state?.status === "running" && Date.now() < deadline) {
    await delay(500);
    turn = (
      await requestTrueForge(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      )
    ).body.data;
  }
  assert.notEqual(turn.state?.status, "running");

  const eventResponse = await requestTrueForge(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events?limit=100&order=asc`,
  );
  const events = eventResponse.body.data.map((item) => item.event ?? item);
  const datasourceCalls = events.flatMap((event) =>
    event.type === "model.message" && Array.isArray(event.toolCalls)
      ? event.toolCalls.filter(
          (call) =>
            call.toolInfo?.serverName === "forty-two-data-source" ||
            ["list_data_sources", "run_read_query"].includes(
              call.toolInfo?.name,
            ),
        )
      : [],
  );
  const successful = events.filter(
    (event) =>
      event.type === "tool.response" &&
      datasourceCalls.some((call) => call.id === event.toolCallId) &&
      !String(event.content).includes("failed"),
  );
  assert.deepEqual(successful, []);
}

async function requestTrueForge(
  path,
  { method = "GET", body, allowStatuses = [] } = {},
) {
  const response = await fetch(
    path.startsWith("http") ? path : `${trueforgeUrl}${path}`,
    {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = response.status === 204 ? "" : await response.text();
  const responseBody = text ? JSON.parse(text) : undefined;
  if (!response.ok && !allowStatuses.includes(response.status)) {
    throw new Error(`TrueForge request failed (${response.status}).`);
  }
  return { status: response.status, body: responseBody };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Integration URLs must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
