import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { createXlsxFixture } from "./lib/xlsx-fixture.mjs";

const webUrl = normalizeUrl(process.env.WEB_URL ?? "http://127.0.0.1:3000");
const dataSourceMcpUrl = normalizeUrl(
  process.env.DATA_SOURCE_MCP_URL ?? "http://127.0.0.1:8791",
);
const mcpAuthToken = requiredSecret("MCP_AUTH_TOKEN");
const runToken = randomUUID().replaceAll("-", "");
const tableName = `forty_two_chat_e2e_${runToken.slice(0, 12)}`;
const sessions = new Set();
const completedCases = [];
const requestedCases = selectedCases();
let primaryError;

try {
  seedDatabase();
  if (requestedCases.has("csv")) await runCsvCase();
  if (requestedCases.has("xlsx")) await runExcelCase();
  if (requestedCases.has("database")) await runDatabaseCase();
  if (requestedCases.has("combined")) await runCombinedCase();
  console.log(
    `Chat backend E2E passed against the live system (${completedCases.join(", ")}).`,
  );
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  for (const sessionId of sessions) {
    try {
      await requestApi(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      const check = await fetch(
        `${webUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (check.status !== 404) {
        throw new Error(
          `Deleted session ${sessionId} remained accessible (${check.status}).`,
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    dropDatabaseFixture();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      "Chat backend E2E cleanup was incomplete.",
    );
  }
  if (primaryError) throw primaryError;
}

async function runCsvCase() {
  const marker = `CSV_E2E_OK token=${runToken} rows=3 total=87 north=58`;
  const csv = Buffer.from(
    "region,amount\nNorth,17\nSouth,29\nNorth,41\n",
    "utf8",
  );
  const result = await runFileTurn({
    filename: "regional-sales.csv",
    mime: "text/csv",
    contents: csv,
    prompt: `Use exactly one Daytona Code Mode exec operation. In Python, read the actual uploaded file at /opt/tf/uploads/regional-sales.csv, compute its data-row count, total amount, and North amount, assert they equal 3, 87, and 58, then print exactly this marker from that exec:\n${marker}\nAfter verifying the exec result, answer exactly the marker line with no other text.`,
  });
  proveFileExecution(result.events, marker);
  proveFinalOutput(result.turn, marker);
  completedCases.push("CSV");
  console.log("Live CSV case passed.");
}

async function runExcelCase() {
  const marker = `XLSX_E2E_OK token=${runToken} sheets=Data rows=3 total=123`;
  const workbook = createXlsxFixture([
    ["category", "amount"],
    ["Alpha", 31],
    ["Beta", 47],
    ["Gamma", 45],
  ]);
  const result = await runFileTurn({
    filename: "category-sales.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contents: workbook,
    prompt: `Use exactly one Daytona Code Mode exec operation. In Python, open the actual uploaded workbook at /opt/tf/uploads/category-sales.xlsx, enumerate its sheet names, read the Data sheet, compute its data-row count and total amount, assert the sheet list is Data and the values equal 3 and 123, then print exactly this marker from that exec:\n${marker}\nAfter verifying the exec result, answer exactly the marker line with no other text.`,
  });
  proveFileExecution(result.events, marker);
  proveFinalOutput(result.turn, marker);
  completedCases.push("XLSX");
  console.log("Live XLSX case passed.");
}

async function runDatabaseCase() {
  const requestId = randomUUID();
  const marker = `DATABASE_E2E_OK token=${runToken} rows=2 total=18`;
  const sql = `SELECT e2e_token, COUNT(*)::int AS row_count, SUM(unit_price)::int AS total_price FROM public.${tableName} WHERE e2e_token = '${runToken}' GROUP BY e2e_token ORDER BY e2e_token`;
  const { turn, events } = await runTurn({
    message: `Use Daytona Code Mode and mcp_client; do not call datasource tools directly from the model. Call the forty-two-data-source MCP server run_read_query tool for local-postgres with requestId "${requestId}", maxRows 1, and exactly this SQL:\n${sql}\nPrint the returned MCP object. Verify the row, then answer exactly this one line, with no other text:\n${marker}`,
  });
  const execution = await requireMcpExecution(requestId);
  const row = execution.rows?.[0];
  if (
    execution.dataSource !== "local-postgres" ||
    row?.e2e_token !== runToken ||
    Number(row?.row_count) !== 2 ||
    Number(row?.total_price) !== 18
  ) {
    throw new Error(
      "Database E2E MCP telemetry did not contain the seeded aggregate.",
    );
  }
  proveDatabaseExecution(events, requestId, [runToken, "18"]);
  proveFinalOutput(turn, marker);
  completedCases.push("database");
  console.log("Live database case passed.");
}

async function runCombinedCase() {
  const requestId = randomUUID();
  const marker = `COMBINED_E2E_OK token=${runToken} matched=2 revenue=43`;
  const sql = `SELECT sku, unit_price FROM public.${tableName} WHERE e2e_token = '${runToken}' ORDER BY sku`;
  const quantities = Buffer.from("sku,quantity\nSKU-A,2\nSKU-B,3\n", "utf8");
  const { turn, events } = await runFileTurn({
    filename: "quantities.csv",
    mime: "text/csv",
    contents: quantities,
    prompt: `The runner has already verified the fixture schema and exact SQL. Do not call any datasource MCP tool directly from the model, including discovery or introspection. Use one Daytona Code Mode exec operation. If the sandbox is still starting and the exec fails, retry that same operation once. In sandboxed Python, read /opt/tf/uploads/quantities.csv, import call_tool from mcp_client, and call the forty-two-data-source MCP server run_read_query tool for local-postgres with requestId "${requestId}", maxRows 2, and exactly this SQL:\n${sql}\nJoin those returned rows with the uploaded file on sku in Python, calculate matched SKU count and sum(quantity * unit_price), and print exactly this marker from the same exec:\n${marker}\nAfter verifying that exec result, answer exactly the marker line with no other text.`,
  });
  const execution = await requireMcpExecution(requestId);
  if (
    execution.dataSource !== "local-postgres" ||
    execution.rows?.length !== 2 ||
    !execution.rows.some(
      (row) => row.sku === "SKU-A" && Number(row.unit_price) === 11,
    ) ||
    !execution.rows.some(
      (row) => row.sku === "SKU-B" && Number(row.unit_price) === 7,
    )
  ) {
    throw new Error(
      "Combined E2E MCP telemetry did not contain the seeded price rows.",
    );
  }
  proveDatabaseExecution(events, requestId, [marker]);
  proveFinalOutput(turn, marker);
  completedCases.push("combined source");
  console.log("Live combined-source case passed.");
}

async function runFileTurn({ filename, mime, contents, prompt }) {
  const form = new FormData();
  form.set("message", prompt);
  form.append("files", new File([contents], filename, { type: mime }));
  return runTurn({ body: form });
}

async function runTurn({ message, body }) {
  const createdSession = await requestApi("/api/chat/sessions", {
    method: "POST",
  });
  const sessionId = requiredId(createdSession.data?.id, "session");
  sessions.add(sessionId);
  const createdTurn = await requestApi(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns`,
    body ? { method: "POST", body } : { method: "POST", json: { message } },
  );
  const turnId = requiredId(createdTurn.data?.id, "turn");
  const waited = await requestApi(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/wait`,
    { method: "POST", json: { timeoutSeconds: 300 }, timeoutMs: 330_000 },
  );
  const turn = waited.data;
  if (turn?.state?.status !== "done") {
    throw new Error(
      `Live turn ${turnId} failed (${String(turn?.state?.status)}): ${String(turn?.state?.message ?? "unknown error")}`,
    );
  }
  if (turn.state.requiredActions?.length) {
    throw new Error(
      `Live turn ${turnId} paused for an unexpected user action.`,
    );
  }
  const eventResponse = await requestApi(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`,
  );
  const events = eventResponse.data?.map((item) => item.event) ?? [];
  if (!events.some((event) => event.type === "sandbox.created")) {
    throw new Error(`Live turn ${turnId} did not create a Daytona sandbox.`);
  }
  return { sessionId, turnId, turn, events };
}

function proveFileExecution(events, marker) {
  const responses = correlatedExecResponses(events);
  if (!responses.some((content) => content.includes(marker))) {
    throw new Error(`No real Daytona exec response contained ${marker}.`);
  }
}

function proveDatabaseExecution(events, requestId, expectedValues) {
  assertNoDirectDatasourceCalls(events);
  const responses = correlatedExecResponses(
    events,
    (command) =>
      command.includes("forty-two-data-source") &&
      command.includes("run_read_query") &&
      command.includes("local-postgres") &&
      command.includes(requestId) &&
      (command.includes("call_tool") ||
        command.includes("mcp-client call-tool")),
  );
  if (
    responses.length === 0 ||
    !responses.some((content) =>
      expectedValues.every((value) => content.includes(value)),
    )
  ) {
    throw new Error(
      "No correlated Daytona Code Mode result contained the live MCP rows.",
    );
  }
}

function correlatedExecResponses(events, acceptsCommand = () => true) {
  const callIds = new Set();
  for (const event of events) {
    if (event.type !== "model.message" || !Array.isArray(event.toolCalls))
      continue;
    for (const call of event.toolCalls) {
      if (call.toolInfo?.name !== "exec" && call.function?.name !== "exec")
        continue;
      const args = parseJson(call.function?.arguments);
      const command = [args?.command, args?.cmd, args?.code].find(
        (value) => typeof value === "string",
      );
      if (typeof command === "string" && acceptsCommand(command))
        callIds.add(call.id);
    }
  }
  return events
    .filter(
      (event) =>
        event.type === "tool.response" &&
        callIds.has(event.toolCallId) &&
        typeof event.content === "string",
    )
    .map((event) => event.content);
}

function assertNoDirectDatasourceCalls(events) {
  for (const event of events) {
    if (event.type !== "model.message" || !Array.isArray(event.toolCalls))
      continue;
    for (const call of event.toolCalls) {
      if (
        call.toolInfo?.type === "mcp" &&
        call.toolInfo.serverName === "forty-two-data-source"
      ) {
        throw new Error(
          "The model bypassed Daytona and called the datasource MCP directly.",
        );
      }
    }
  }
}

function proveFinalOutput(turn, marker) {
  const output = JSON.stringify(turn.state?.output ?? {});
  if (!output.includes(marker)) {
    throw new Error(
      `Final output did not contain the verified marker ${marker}: ${output.slice(0, 1_000)}`,
    );
  }
}

async function requireMcpExecution(requestId) {
  const response = await fetch(
    `${dataSourceMcpUrl}/internal/query-executions/${encodeURIComponent(requestId)}`,
    {
      headers: { authorization: `Bearer ${mcpAuthToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `Datasource MCP execution evidence was unavailable (${response.status}).`,
    );
  }
  return body?.data ?? {};
}

function seedDatabase() {
  runPsql(`
CREATE TABLE public.${tableName} (
  e2e_token text NOT NULL,
  sku text NOT NULL,
  unit_price integer NOT NULL
);
INSERT INTO public.${tableName} (e2e_token, sku, unit_price) VALUES
  ('${runToken}', 'SKU-A', 11),
  ('${runToken}', 'SKU-B', 7);
`);
}

function dropDatabaseFixture() {
  runPsql(`DROP TABLE IF EXISTS public.${tableName};`);
}

function runPsql(sql) {
  const user = process.env.POSTGRES_USER?.trim() || "forty_two";
  const database = process.env.POSTGRES_DB?.trim() || "forty_two";
  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      user,
      "-d",
      database,
    ],
    { cwd: process.cwd(), input: sql, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `PostgreSQL fixture command failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

async function requestApi(
  path,
  { method = "GET", json, body, timeoutMs = 60_000 } = {},
) {
  const response = await fetch(`${webUrl}${path}`, {
    method,
    headers:
      json === undefined ? undefined : { "content-type": "application/json" },
    body: json === undefined ? body : JSON.stringify(json),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseBody =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = responseBody?.error?.message;
    throw new Error(
      typeof message === "string"
        ? `Product API failed (${response.status}): ${message}`
        : `Product API failed (${response.status}).`,
    );
  }
  return responseBody;
}

function parseJson(value) {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function requiredId(value, label) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Product API did not return a ${label} id.`);
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
    throw new Error("E2E URLs must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function selectedCases() {
  const allowed = new Set(["csv", "xlsx", "database", "combined"]);
  const values = (process.env.CHAT_E2E_CASES ?? "csv,xlsx,database,combined")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0 || values.some((value) => !allowed.has(value))) {
    throw new Error(
      "CHAT_E2E_CASES must contain csv, xlsx, database, and/or combined.",
    );
  }
  return new Set(values);
}
