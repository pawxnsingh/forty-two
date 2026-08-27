const DATA_SOURCE_SERVER = "forty-two-data-source";

export function assertNoDirectDatasourceCalls(turnEvents) {
  for (const event of turnEvents) {
    if (event.type !== "model.message" || !Array.isArray(event.tool_calls))
      continue;
    for (const call of event.tool_calls) {
      const info = call?.tool_info;
      const args = parseJson(call?.function?.arguments);
      const isDirectDatasourceCall =
        (info?.type === "mcp" && info?.server_name === DATA_SOURCE_SERVER) ||
        ((call?.function?.name === "call_tool" ||
          call?.function?.name?.endsWith("__call_tool")) &&
          args?.mcp_server === DATA_SOURCE_SERVER);
      if (isDirectDatasourceCall) {
        throw new Error(
          "The integration turn called the datasource MCP directly instead of through Daytona Code Mode.",
        );
      }
    }
  }
}

export function correlatedCodeModeResults(turnEvents, requestId) {
  const execCallIds = new Set();
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
        command.includes(DATA_SOURCE_SERVER) &&
        command.includes("run_read_query") &&
        command.includes("local-postgres") &&
        command.includes(requestId) &&
        (command.includes("call_tool") ||
          command.includes("mcp-client call-tool"))
      ) {
        execCallIds.add(call.id);
      }
    }
  }

  return turnEvents
    .filter(
      (event) =>
        event.type === "tool.response" &&
        execCallIds.has(event.tool_call_id) &&
        typeof event.content === "string",
    )
    .map((event) => event.content);
}

export async function listAllEventPages(fetchPage, maxPages = 100) {
  const allEvents = [];
  const seenPageTokens = new Set();
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await fetchPage(pageToken);
    if (!Array.isArray(response.data)) {
      throw new Error("TrueForge did not return turn events.");
    }
    allEvents.push(...response.data);
    const nextPageToken = response.pagination?.next_page_token;
    if (typeof nextPageToken !== "string" || !nextPageToken) return allEvents;
    if (seenPageTokens.has(nextPageToken)) {
      throw new Error("TrueForge repeated an event page token.");
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  throw new Error(`TrueForge event pagination exceeded ${maxPages} pages.`);
}

export async function discoverSandboxEvents({
  initialEvents,
  fetchEvents,
  pause,
  attempts = 3,
}) {
  let currentEvents = initialEvents;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (currentEvents.some((event) => event.type === "sandbox.created")) {
      return currentEvents;
    }
    try {
      currentEvents = await fetchEvents();
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (currentEvents.some((event) => event.type === "sandbox.created")) {
      return currentEvents;
    }
    if (attempt < attempts) await pause(attempt * 250);
  }
  throw new Error("No sandbox.created event was discoverable after retries.", {
    cause: lastError,
  });
}

function parseJson(value) {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
