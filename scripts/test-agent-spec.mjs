import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const specPath = new URL(
  "../config/agents/forty-two-data-agent.json",
  import.meta.url,
);
const spec = JSON.parse(await readFile(specPath, "utf8"));

assert.equal(spec.model?.name, "openai/gpt-5-6-terra");
assert.equal(spec.config?.sandbox?.enabled, true);
assert.equal(spec.config?.sandbox?.file_downloads, true);

const server = spec.mcp_servers?.find(
  (candidate) => candidate.name === "forty-two-data-source",
);
assert.ok(
  server,
  "The datasource MCP server must be referenced by the agent spec.",
);
assert.deepEqual(server.enable_tools, ["@all"]);

const prompt = spec.instructions;
assert.equal(typeof prompt, "string");
for (const requiredSection of [
  "<identity>",
  "<execution_discipline>",
  "<source_routing>",
  "<file_workflow>",
  "<database_workflow>",
  "<analysis_rules>",
  "<safety>",
  "<output>",
]) {
  assert.match(prompt, new RegExp(requiredSection.replace(/[<>]/g, "\\$&")));
}
for (const requiredContract of [
  "Every reported number must be computed from a tool result",
  "Never invent connector options",
  "If a query returns zero rows",
  "Before joining, identify expected key cardinality",
  "Credentials are platform-managed",
  "Database access is read-only",
]) {
  assert.ok(
    prompt.includes(requiredContract),
    `Missing prompt contract: ${requiredContract}`,
  );
}

const serialized = JSON.stringify(spec);
for (const secretPattern of [
  /sk-proj-/i,
  /dtn_[a-f0-9]/i,
  /OPENAI_API_KEY=/i,
  /DAYTONA_API_KEY=/i,
  /MCP_AUTH_TOKEN=/i,
  /POSTGRES_READER_PASSWORD=/i,
]) {
  assert.doesNotMatch(serialized, secretPattern);
}

console.log("Agent spec contract passed.");
