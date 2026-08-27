import { randomUUID } from "node:crypto";

const trueforgeUrl = normalizeUrl(
  process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790",
);
const daytonaUrl = normalizeUrl(
  process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
);
const daytonaApiKey = requiredSecret("DAYTONA_API_KEY");
const dataSourceMcpUrl = normalizeUrl(
  process.env.DATA_SOURCE_MCP_URL ?? "http://127.0.0.1:8791",
);
const mcpAuthToken = requiredSecret("MCP_AUTH_TOKEN");
const queryRequestId = randomUUID();
const agentName =
  process.env.FORTY_TWO_AGENT_NAME?.trim() || "forty-two-data-agent";

let sessionId;
let turnId;
let events = [];
let testPassed = false;

try {
  const session = await requestTrueforge(`${trueforgeUrl}/api/v1/sessions`, {
    method: "POST",
    body: { agent: { name: agentName } },
  });
  sessionId = requiredId(session.data?.id, "session");
  console.log(`Integration session created (${sessionId}).`);

  const createdTurn = await requestTrueforge(
    `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      method: "POST",
      body: {
        stream: false,
        input: [
          {
            type: "user.message",
            content: `Use Code Mode in the Daytona sandbox for this test; do not call the datasource tools directly from the model.

In sandboxed Python, import call_tool from mcp_client and:
1. Call server "forty-two-data-source", tool "list_data_sources", with an empty body.
2. Confirm "local-postgres" is present.
3. Call server "forty-two-data-source", tool "run_read_query", with body {"dataSource":"local-postgres","sql":"SELECT current_database() AS database_name, md5(random()::text) AS nonce","maxRows":1,"requestId":"${queryRequestId}"}.
4. Read the first returned row and print it.

Only after the real sandboxed MCP result is available, answer exactly in this shape:
PLATFORM_INTEGRATION_OK database=<database_name> nonce=<nonce>`,
          },
        ],
      },
    },
  );
  turnId = requiredId(createdTurn.data?.id, "turn");

  const deadline = Date.now() + 5 * 60_000;
  let turn = createdTurn.data;
  while (turn.state?.status === "running" && Date.now() < deadline) {
    await delay(1_000);
    turn = (
      await requestTrueforge(
        `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      )
    ).data;
  }
  if (turn.state?.status === "running") {
    throw new Error("Integration turn did not finish within five minutes.");
  }
  if (turn.state?.status !== "done") {
    throw new Error(
      `Integration turn failed (${String(turn.state?.status)}): ${String(turn.state?.message ?? "unknown error")}`,
    );
  }
  if (turn.state.required_actions?.length) {
    throw new Error("Integration turn unexpectedly paused for user action.");
  }

  events = await getTurnEvents();
  const eventTypes = new Set(events.map((event) => event.type));
  for (const requiredType of ["mcp.initialize", "sandbox.created"]) {
    if (!eventTypes.has(requiredType)) {
      throw new Error(`Integration turn did not emit ${requiredType}.`);
    }
  }

  if (!hasCorrelatedMcpExecution(events, queryRequestId)) {
    throw new Error(
      "No correlated Daytona exec/tool response used the runner-issued MCP request id.",
    );
  }
  const execution = await requestMcpExecution(queryRequestId);
  const verifiedRow = execution.rows?.[0];
  if (
    execution.dataSource !== "local-postgres" ||
    verifiedRow?.database_name !== "forty_two" ||
    typeof verifiedRow.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(verifiedRow.nonce)
  ) {
    throw new Error(
      "Datasource MCP telemetry did not contain the expected row.",
    );
  }
  const output = JSON.stringify(turn.state.output ?? {});
  const result = output.match(
    /PLATFORM_INTEGRATION_OK database=forty_two nonce=([a-f0-9]{32})/,
  );
  if (!result || verifiedRow.nonce !== result[1]) {
    throw new Error(
      "The final answer did not match a nonce found in the correlated MCP tool response.",
    );
  }

  console.log(
    `Platform integration passed (turn=${turnId}, nonce=${result[1]}, events=${events.length}).`,
  );
  testPassed = true;
} finally {
  try {
    await cleanup();
  } catch (error) {
    if (testPassed) throw error;
    console.error(`Integration cleanup also failed: ${String(error)}`);
  }
}

function hasCorrelatedMcpExecution(turnEvents, requestId) {
  const execCalls = new Map();
  for (const event of turnEvents) {
    if (event.type !== "model.message" || !Array.isArray(event.tool_calls))
      continue;
    for (const call of event.tool_calls) {
      const isExec =
        call?.tool_info?.name === "exec" ||
        call?.function?.name === "exec" ||
        call?.function?.name?.endsWith("__exec");
      if (!isExec || typeof call.id !== "string") continue;
      const args = parseJson(call.function.arguments);
      const command = [args?.command, args?.cmd, args?.code].find(
        (value) => typeof value === "string",
      );
      if (
        typeof command === "string" &&
        command.includes("forty-two-data-source") &&
        command.includes("run_read_query") &&
        command.includes("local-postgres") &&
        command.includes(requestId) &&
        (command.includes("call_tool") ||
          command.includes("mcp-client call-tool"))
      ) {
        execCalls.set(call.id, command);
      }
    }
  }

  for (const event of turnEvents) {
    if (
      event.type !== "tool.response" ||
      !execCalls.has(event.tool_call_id) ||
      typeof event.content !== "string"
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function parseJson(value) {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function requestMcpExecution(requestId) {
  const response = await fetch(
    `${dataSourceMcpUrl}/internal/query-executions/${encodeURIComponent(requestId)}`,
    {
      headers: { authorization: `Bearer ${mcpAuthToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Datasource MCP telemetry failed (${response.status}).`);
  }
  return body?.data ?? {};
}

async function getTurnEvents() {
  if (!sessionId || !turnId) return [];
  const response = await requestTrueforge(
    `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events?limit=100&order=asc`,
  );
  if (!Array.isArray(response.data)) {
    throw new Error("TrueForge did not return turn events.");
  }
  return response.data;
}

async function cleanup() {
  const errors = [];
  if (sessionId) {
    try {
      await requestTrueforge(
        `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
        { method: "POST", body: {} },
      );
    } catch (error) {
      errors.push(error);
    }
  }

  let eventDiscoverySucceeded = events.length > 0 || !turnId;
  if (!eventDiscoverySucceeded && sessionId && turnId) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        events = await getTurnEvents();
        eventDiscoverySucceeded = true;
        break;
      } catch (error) {
        if (attempt === 3) errors.push(error);
        else await delay(attempt * 250);
      }
    }
  }

  const sandboxIds = new Set(
    events
      .filter((event) => event.type === "sandbox.created")
      .map((event) => rawDaytonaId(event.sandbox_id))
      .filter(Boolean),
  );
  for (const sandboxId of sandboxIds) {
    try {
      await deleteDaytonaSandbox(sandboxId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (sessionId && eventDiscoverySucceeded) {
    try {
      await requestTrueforge(
        `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      errors.push(error);
    }
  } else if (sessionId) {
    errors.push(
      new Error(
        `Retained TrueForge session ${sessionId} because sandbox discovery failed`,
      ),
    );
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Integration cleanup was incomplete");
  }
}

function rawDaytonaId(value) {
  if (typeof value !== "string") return undefined;
  const prefix = "v1:daytona:";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

async function deleteDaytonaSandbox(sandboxId) {
  const response = await fetch(
    `${daytonaUrl}/sandbox/${encodeURIComponent(sandboxId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${daytonaApiKey}` },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Daytona sandbox deletion failed (${response.status}).`);
  }
}

function requiredId(value, label) {
  if (typeof value !== "string") {
    throw new Error(`TrueForge did not return a ${label} id.`);
  }
  return value;
}

function requiredSecret(name) {
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

async function requestTrueforge(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
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
