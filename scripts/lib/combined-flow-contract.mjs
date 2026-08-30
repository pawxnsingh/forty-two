import { createHash } from "node:crypto";

export const COMBINED_READ_SQL = "SELECT value FROM demo.metrics WHERE id = 1";

export function sqlSha256(sql = COMBINED_READ_SQL) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function executionMatchesExpectedSql(
  execution,
  sql = COMBINED_READ_SQL,
) {
  return execution?.executedSqlSha256 === sqlSha256(sql);
}

export function requireReadyTrackedDataSource(dataSource, cleanupIds) {
  const dataSourceId = dataSource?.id;
  if (
    typeof dataSourceId !== "string" ||
    !/^ds_[0-9A-HJKMNP-TV-Z]{26}$/.test(dataSourceId)
  ) {
    throw new Error(
      "Database registration did not return a valid datasource ID.",
    );
  }
  cleanupIds.add(dataSourceId);
  if (dataSource.status !== "ready") {
    throw new Error(
      `Database registration ${dataSourceId} returned status '${String(dataSource.status)}'.`,
    );
  }
  return dataSource;
}

export async function cleanupTrackedDataSources(cleanupIds, remove) {
  const errors = [];
  for (const dataSourceId of cleanupIds) {
    try {
      await remove(dataSourceId);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function buildCombinedFlowMessage({
  connectorName,
  sessionId,
  fileDataSourceId,
  databaseDataSourceId,
  requestId,
  nonce,
}) {
  return [
    "Use exactly one Daytona Code Mode exec operation.",
    "In sandboxed Python, import call_tool from mcp_client.",
    `Call ${connectorName} get_file_download_url with sessionId ${sessionId} and dataSourceId ${fileDataSourceId}.`,
    "Download that URL directly from Azure with requests using every returned requestHeaders entry.",
    `Assert the HTTP response ETag exactly equals expectedETag, the byte length equals sizeBytes, and the CSV has exactly one record whose nonce column equals ${nonce}.`,
    "Parse the integer from that record's value column; label is nonnumeric metadata and must not be treated as a numeric candidate.",
    `Then call ${connectorName} run_read_query with sessionId ${sessionId}, dataSourceId ${databaseDataSourceId}, requestId ${requestId}, and maxRows 1.`,
    "Set its sql argument to exactly the characters between the <sql> and </sql> delimiter lines below.",
    "<sql>",
    COMBINED_READ_SQL,
    "</sql>",
    "The delimiter tags are not part of the SQL. Do not add quotes, a semicolon, a period, or any other trailing character to the sql argument.",
    "Read the database value without assuming it, add it to the file value, and print exactly this format with the observed numbers substituted:",
    `BOUND_E2E_OK nonce=${nonce} file=<file value> database=<database value> total=<sum>`,
    "After verifying the exec response, answer exactly that printed line and no other text.",
  ].join("\n");
}

export function persistedCombinedExecCalls(events, connectorName) {
  const calls = [];
  for (const event of events) {
    if (event?.type !== "model.message" || !Array.isArray(event.toolCalls)) {
      continue;
    }
    for (const call of event.toolCalls) {
      if (call.toolInfo?.name !== "exec" && call.function?.name !== "exec") {
        continue;
      }
      const arguments_ = parseJson(call.function?.arguments);
      const command = [
        arguments_?.command,
        arguments_?.cmd,
        arguments_?.code,
      ].find((value) => typeof value === "string");
      if (
        command?.includes(connectorName) &&
        command.includes("get_file_download_url") &&
        command.includes("run_read_query") &&
        command.includes("requestHeaders") &&
        command.includes("expectedETag")
      ) {
        calls.push({ id: call.id, command });
      }
    }
  }
  return calls;
}

export function commandContainsExactSqlLiteral(
  command,
  sql = COMBINED_READ_SQL,
) {
  if (typeof command !== "string") return false;
  return [
    `'${sql.replaceAll("'", "\\'")}'`,
    `"${sql.replaceAll('"', '\\"')}"`,
  ].some((literal) => command.includes(literal));
}

function parseJson(value) {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
