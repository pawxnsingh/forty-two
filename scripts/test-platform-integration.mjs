const trueforgeUrl = normalizeUrl(
  process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790",
);
const agentName =
  process.env.FORTY_TWO_AGENT_NAME?.trim() || "forty-two-data-agent";

const session = await requestJson(`${trueforgeUrl}/api/v1/sessions`, {
  method: "POST",
  body: {
    agent: { name: agentName },
  },
});

const sessionId = session.data?.id;
if (typeof sessionId !== "string") {
  throw new Error("TrueForge did not return a session id.");
}

console.log(`Integration session created (${sessionId}).`);

const createdTurn = await requestJson(
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
3. Call server "forty-two-data-source", tool "run_read_query", with body {"dataSource":"local-postgres","sql":"SELECT current_database() AS database_name, md5(random()::text) AS nonce","maxRows":1}.
4. Read the first returned row and print it.

Only after the real sandboxed MCP result is available, answer exactly in this shape:
PLATFORM_INTEGRATION_OK database=<database_name> nonce=<nonce>`,
        },
      ],
    },
  },
);

const turnId = createdTurn.data?.id;
if (typeof turnId !== "string") {
  throw new Error("TrueForge did not return a turn id.");
}

const deadline = Date.now() + 5 * 60_000;
let turn = createdTurn.data;
while (turn.state?.status === "running" && Date.now() < deadline) {
  await delay(1_000);
  const response = await requestJson(
    `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
  );
  turn = response.data;
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

const eventsResponse = await requestJson(
  `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events?limit=100&order=asc`,
);
const events = eventsResponse.data;
if (!Array.isArray(events)) {
  throw new Error("TrueForge did not return turn events.");
}
const eventTypes = new Set(events.map((event) => event.type));
for (const requiredType of ["mcp.initialize", "sandbox.created"]) {
  if (!eventTypes.has(requiredType)) {
    throw new Error(`Integration turn did not emit ${requiredType}.`);
  }
}

const output = JSON.stringify(turn.state.output ?? {});
const result = output.match(
  /PLATFORM_INTEGRATION_OK database=forty_two nonce=([a-f0-9]{32})/,
);
if (!result) {
  throw new Error("The agent did not return the verified database nonce.");
}

console.log(
  `Platform integration passed (turn=${turnId}, nonce=${result[1]}, events=${events.length}).`,
);

function normalizeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TRUEFORGE_URL must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

async function requestJson(url, { method = "GET", body } = {}) {
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
