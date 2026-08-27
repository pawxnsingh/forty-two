import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const trueforgeUrl = normalizeUrl(
  process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790",
);
const daytonaUrl = normalizeUrl(
  process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
);
const daytonaApiKey = requiredSecret("DAYTONA_API_KEY");
const agentName =
  process.env.FORTY_TWO_AGENT_NAME?.trim() || "forty-two-data-agent";
const fixturePath = process.env.TABULAR_FIXTURE_PATH?.trim();
const fixture = fixturePath
  ? await readFile(fixturePath)
  : Buffer.from("region,amount\nNorth,10\nSouth,20\nNorth,30\n", "utf8");
const filename = fixturePath ? basename(fixturePath) : "sales-fixture.csv";
const mime = filename.toLowerCase().endsWith(".xlsx")
  ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  : "text/csv";
const expectedSheets = process.env.TABULAR_EXPECTED_SHEETS?.trim() || "none";

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

  const createdTurn = await requestTrueforge(
    `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      method: "POST",
      body: {
        stream: false,
        input: [
          {
            type: "user.message",
            content: [
              {
                type: "file",
                name: filename,
                data: `data:${mime};base64,${fixture.toString("base64")}`,
              },
              {
                type: "text",
                text: `Use Daytona Code Mode to inspect the actual uploaded file, not this message. Do not use mental arithmetic. Read the table containing columns region and amount, count its data rows, and calculate the sum of amount. If this is an Excel workbook, enumerate its sheet names before selecting the Data sheet. Reply with exactly one line:\nFILE_INTEGRATION_OK filename=${filename} rows=<row_count> total=<amount_sum> sheets=<comma-separated-sheet-names-or-none>`,
              },
            ],
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
  if (turn.state?.status !== "done") {
    throw new Error(
      `File integration turn failed (${String(turn.state?.status)}): ${String(turn.state?.message ?? "unknown error")}`,
    );
  }

  events = await getTurnEvents();
  if (!events.some((event) => event.type === "sandbox.created")) {
    throw new Error("The uploaded file turn did not create a Daytona sandbox.");
  }

  const expected = `FILE_INTEGRATION_OK filename=${filename} rows=3 total=60 sheets=${expectedSheets}`;
  const sandboxResponses = events
    .filter((event) => event.type === "tool.response")
    .map((event) => event.content)
    .filter((content) => typeof content === "string");
  if (!sandboxResponses.some((content) => content.includes(expected))) {
    throw new Error(
      "No Daytona tool response contained the computed file result.",
    );
  }
  const output = JSON.stringify(turn.state.output ?? {});
  if (!output.includes(expected)) {
    throw new Error(
      `Agent output did not match the sandbox result: ${expected}. Actual output: ${output}`,
    );
  }

  console.log(
    `File integration passed (turn=${turnId}, filename=${filename}, events=${events.length}).`,
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
  if (events.length === 0 && sessionId && turnId) {
    events = await getTurnEvents().catch(() => []);
  }
  const sandboxIds = new Set(
    events
      .filter((event) => event.type === "sandbox.created")
      .map((event) => rawDaytonaId(event.sandbox_id))
      .filter(Boolean),
  );
  for (const sandboxId of sandboxIds) {
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
  if (sessionId) {
    await requestTrueforge(
      `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
  }
}

function rawDaytonaId(value) {
  if (typeof value !== "string") return undefined;
  const prefix = "v1:daytona:";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
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
