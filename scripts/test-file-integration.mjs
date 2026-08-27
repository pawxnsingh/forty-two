import { basename } from "node:path";
import { readFile } from "node:fs/promises";

const trueforgeUrl = normalizeUrl(
  process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790",
);
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

const session = await requestJson(`${trueforgeUrl}/api/v1/sessions`, {
  method: "POST",
  body: { agent: { name: agentName } },
});
const sessionId = requiredId(session.data?.id, "session");

const createdTurn = await requestJson(
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
const turnId = requiredId(createdTurn.data?.id, "turn");

const deadline = Date.now() + 5 * 60_000;
let turn = createdTurn.data;
while (turn.state?.status === "running" && Date.now() < deadline) {
  await delay(1_000);
  turn = (
    await requestJson(
      `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
    )
  ).data;
}
if (turn.state?.status !== "done") {
  throw new Error(
    `File integration turn failed (${String(turn.state?.status)}): ${String(turn.state?.message ?? "unknown error")}`,
  );
}

const events = (
  await requestJson(
    `${trueforgeUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events?limit=100&order=asc`,
  )
).data;
if (!Array.isArray(events)) throw new Error("TrueForge did not return events.");
const eventTypes = new Set(events.map((event) => event.type));
if (!eventTypes.has("sandbox.created")) {
  throw new Error("The uploaded file turn did not create a Daytona sandbox.");
}

const output = JSON.stringify(turn.state.output ?? {});
const expected = `FILE_INTEGRATION_OK filename=${filename} rows=3 total=60 sheets=${expectedSheets}`;
if (!output.includes(expected)) {
  throw new Error(
    `Agent output did not contain the verified result: ${expected}. Actual output: ${output}`,
  );
}

console.log(
  `File integration passed (turn=${turnId}, filename=${filename}, events=${events.length}).`,
);

function requiredId(value, label) {
  if (typeof value !== "string") {
    throw new Error(`TrueForge did not return a ${label} id.`);
  }
  return value;
}

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
