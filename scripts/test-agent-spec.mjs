import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { requiredImmutableSandboxImage } from "./platform-sandbox-image-contract.mjs";

const spec = JSON.parse(
  await readFile(
    new URL("../config/agents/forty-two-data-agent.json", import.meta.url),
    "utf8",
  ),
);
const effectivePrompt = spec.instructions;
const chartContractFixture = JSON.parse(
  await readFile(
    new URL(
      "../packages/charting/test/fixtures/chart-config-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

assert.equal(spec.model?.name, "openai/gpt-5-6-terra");
assert.equal(spec.config?.sandbox?.enabled, true);
assert.equal(spec.config?.sandbox?.file_downloads, true);
assert.equal(spec.config?.generative_ui?.enabled, false);
assert.equal(spec.skills, undefined);

const datasourceServer = spec.mcp_servers?.find(
  (candidate) => candidate.name === "forty-two-data-source",
);
assert.ok(
  datasourceServer,
  "The agent must reference the shared datasource connector.",
);
assert.deepEqual(datasourceServer.enable_tools, ["@all"]);
assert.deepEqual(datasourceServer.require_approval_for_tools, [
  "apply_sql_change",
]);
assert.deepEqual(
  spec.mcp_servers?.map((candidate) => candidate.name),
  ["forty-two-data-source", "forty-two-todo"],
);

const todoServer = spec.mcp_servers?.find(
  (candidate) => candidate.name === "forty-two-todo",
);
assert.ok(
  todoServer,
  "The shared Todo MCP must be referenced by the agent spec.",
);
assert.deepEqual(todoServer.enable_tools, ["plan"]);
assert.deepEqual(todoServer.preload_tools, ["plan"]);
assert.deepEqual(todoServer.require_approval_for_tools, []);

for (const requiredSection of [
  "<identity>",
  "<execution_discipline>",
  "<source_routing>",
  "<file_workflow>",
  "<database_workflow>",
  "<analysis_rules>",
  "<follow_up_policy>",
  "<plan_workflow>",
  "<artifact_workflow>",
  "<safety>",
  "<output>",
]) {
  assert.match(
    effectivePrompt,
    new RegExp(requiredSection.replace(/[<>]/g, "\\$&")),
  );
}

const metricDefinitionBullet =
  "For a named KPI, use its certified definition from available verified metadata or descriptions when one exists. Without a glossary or certified definition, state the assumed numerator, denominator, filters, and weighting; ask only if the ambiguity materially changes the answer.";
const weightedRateBullet =
  "Compute rates from the aggregated numerator divided by the aggregated denominator. Never use an unweighted mean of row-level ratios unless the verified definition requires it.";
const followUpBullet =
  "For a presentation-only follow-up, reuse the nearest unambiguous committed table and preserve its source, filters, grain, and provenance; do not re-query. Re-query or recompute when the population, filter, grain, metric definition, source, or requested freshness changes. Ask only when multiple prior artifacts plausibly match.";
const artifactIdentityBullet =
  "For database results, `run_read_query` is side-effect-free. Use `create_query_table_artifact` explicitly when the bounded query result must be durable. Generate one UUID requestId for each genuinely new logical operation; after a timeout, disconnect, or lost response, retry the exact same source, SQL, artifact inputs, and requestId. Changed inputs require a new UUID. If the receipt says `sourceLimited: true`, do not use it for totals, joins, averages, or completeness claims; narrow or aggregate in SQL until the required result is not limited.";

function taggedPromptSection(prompt, name) {
  const section = prompt.match(
    new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`),
  )?.[1];
  assert.ok(section, `Missing prompt section: ${name}`);
  return section;
}

function assertCompleteBullet(section, bullet, label) {
  const bullets = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
  assert.ok(bullets.includes(`- ${bullet}`), `Missing exact ${label} clause.`);
}

function assertAgentPromptClauses(prompt) {
  const analysisRules = taggedPromptSection(prompt, "analysis_rules");
  assertCompleteBullet(
    analysisRules,
    metricDefinitionBullet,
    "no-glossary metric-definition fallback",
  );
  assertCompleteBullet(
    analysisRules,
    weightedRateBullet,
    "weighted-rate fallback",
  );
  assertCompleteBullet(
    taggedPromptSection(prompt, "follow_up_policy"),
    followUpBullet,
    "follow-up reuse and six-dimension recompute",
  );
  assertCompleteBullet(
    taggedPromptSection(prompt, "artifact_workflow"),
    artifactIdentityBullet,
    "artifact request identity",
  );
}

function replaceContract(source, exactClause, contradiction) {
  const firstIndex = source.indexOf(exactClause);
  assert.notEqual(
    firstIndex,
    -1,
    `Mutation source clause is missing: ${exactClause}`,
  );
  assert.equal(
    source.indexOf(exactClause, firstIndex + exactClause.length),
    -1,
    `Mutation source clause is not unique: ${exactClause}`,
  );
  return `${source.slice(0, firstIndex)}${contradiction}${source.slice(firstIndex + exactClause.length)}`;
}

assertAgentPromptClauses(effectivePrompt);
for (const mutation of [
  {
    label: "no-glossary metric-definition fallback",
    original: metricDefinitionBullet,
    contradiction:
      "For a named KPI without a glossary, silently infer convenient filters and weighting without stating a numerator or denominator.",
  },
  {
    label: "weighted-rate fallback",
    original: weightedRateBullet,
    contradiction:
      "Compute rates as the unweighted mean of row-level ratios even when numerator and denominator totals are available.",
  },
  {
    label: "follow-up reuse and six-dimension recompute",
    original: followUpBullet,
    contradiction:
      "For a presentation-only follow-up, always run a fresh query. Reuse stale rows even when the population, filter, grain, metric definition, source, or requested freshness changes.",
  },
  {
    label: "artifact request identity",
    original: artifactIdentityBullet,
    contradiction:
      "For every create_query_table_artifact call and ambiguous retry, generate a new UUID requestId even when the source, SQL, and artifact inputs are unchanged; reuse that UUID for genuinely new operations.",
  },
]) {
  const mutatedPrompt = replaceContract(
    effectivePrompt,
    mutation.original,
    mutation.contradiction,
  );
  assert.throws(
    () => assertAgentPromptClauses(mutatedPrompt),
    new RegExp(mutation.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
}

for (const requiredContract of [
  "Every reported number must be computed from a tool result",
  "Never invent connector options",
  "If a query returns zero rows",
  "Before joining, identify expected key cardinality",
  "Credentials are platform-managed",
  "run_read_query and all ordinary database access are read-only",
  "Database mutation is permitted only through prepare_sql_change",
  "TrueForge-approval-gated apply_sql_change",
  "never claim success until the approved apply result is verified",
  "Do not leave completed work in_progress",
  "from forty_two_artifacts import emit_table, load_table, visualize",
  "Never download, upload, reconstruct, or modify `sys.path`",
  "finalize_table_artifact",
  "create_query_table_artifact",
  "sourceLimited: true",
  "Recovery is stage-specific",
  "stop on ETag/hash/size mismatch",
  "retry only the unchanged bounded receipt",
  "never call an MCP tool named `visualize`",
  "finalize_chart_artifact",
  '<artifact_ref id="art_..." type="table|chart"/>',
]) {
  assert.ok(
    effectivePrompt.includes(requiredContract),
    `Missing prompt contract: ${requiredContract}`,
  );
}
assert.match(effectivePrompt, /<chart_authoring_v1>/);
const chartAuthoringGuidance = effectivePrompt.match(
  /<chart_authoring_v1>([\s\S]*?)<\/chart_authoring_v1>/,
)?.[1];
assert.ok(chartAuthoringGuidance);
for (const chartType of chartContractFixture.supportedRendererTypes) {
  assert.match(chartAuthoringGuidance, new RegExp(`\\b${chartType}\\b`));
}
for (const chartType of chartContractFixture.unsupportedRendererTypes) {
  assert.doesNotMatch(chartAuthoringGuidance, new RegExp(`\\b${chartType}\\b`));
}
for (const schemaField of chartContractFixture.promptFields) {
  assert.ok(
    chartContractFixture.rootFields.includes(schemaField),
    `Prompt field is not part of chart.v1: ${schemaField}`,
  );
  assert.ok(
    effectivePrompt.includes(schemaField),
    `Chart authoring guidance is missing chart.v1 field: ${schemaField}`,
  );
}
assert.match(effectivePrompt, /tableColumnOrder[^\n]+never tableColumns/);
assert.doesNotMatch(effectivePrompt, /\/opt\/tfy\/skills/);
assert.doesNotMatch(effectivePrompt, /git[- ](?:backed )?skill/i);
assert.doesNotMatch(effectivePrompt, /def emit_table\s*\(/);
assert.doesNotMatch(
  effectivePrompt,
  /future approval-gated change-set capability/,
);
assert.match(effectivePrompt, /Uploaded CSV and XLSX files/);
assert.doesNotMatch(effectivePrompt, /other uploaded tabular files/);

const chatBackendSource = await readFile(
  new URL("../apps/web/lib/server/chat-backend.ts", import.meta.url),
  "utf8",
);
const sessionContextTemplate = chatBackendSource.match(
  /const sessionContext = `(<session_context>[\s\S]*?<\/session_context>)`;/,
)?.[1];
assert.ok(sessionContextTemplate, "Missing dynamic session-instruction block.");
const newArtifactOperationClause =
  "For each genuinely new logical create_query_table_artifact operation, generate a new UUID requestId.";
const ambiguousArtifactRetryClause =
  "If its result is ambiguous, retry the exact same source, SQL, artifact inputs, and requestId; never create a second identity for that operation.";

function assertDynamicSessionClauses(sessionContext) {
  assert.ok(
    sessionContext.includes(newArtifactOperationClause),
    "Missing exact genuinely-new artifact UUID clause.",
  );
  assert.ok(
    sessionContext.includes(ambiguousArtifactRetryClause),
    "Missing exact ambiguous artifact retry identity clause.",
  );
}

assertDynamicSessionClauses(sessionContextTemplate);
for (const mutation of [
  {
    label: "genuinely-new artifact UUID",
    original: newArtifactOperationClause,
    contradiction:
      "For each call, including an ambiguous retry of the same logical operation, generate a new UUID requestId.",
  },
  {
    label: "ambiguous artifact retry identity",
    original: ambiguousArtifactRetryClause,
    contradiction:
      "If its result is ambiguous, reuse the SQL but change the source, artifact inputs, and requestId.",
  },
]) {
  const mutatedSessionContext = replaceContract(
    sessionContextTemplate,
    mutation.original,
    mutation.contradiction,
  );
  assert.throws(
    () => assertDynamicSessionClauses(mutatedSessionContext),
    new RegExp(mutation.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
}

assert.match(chatBackendSource, /SHARED_DATA_SOURCE_MCP_NAME/);
assert.match(chatBackendSource, /recordSqlChangeApproval/);
assert.match(chatBackendSource, /type: "user\.tool_approval"/);
assert.match(chatBackendSource, /toolInfo\.name === "apply_sql_change"/);
assert.match(chatBackendSource, /toolInfo\.name !== "call_tool"/);
assert.match(
  chatBackendSource,
  /outerArguments\.tool_name !== "apply_sql_change"/,
);
assert.doesNotMatch(
  chatBackendSource,
  /create_query_table_artifact explicitly with a new UUID requestId/,
);

const serialized = JSON.stringify(spec);
for (const secretPattern of [
  /sk[-]proj-/i,
  /dtn_[a-f0-9]/i,
  /OPENAI_API_KEY=/i,
  /DAYTONA_API_KEY=/i,
  /MCP_AUTH_TOKEN=/i,
  /TODO_MCP_AUTH_TOKEN=/i,
  /POSTGRES_READER_PASSWORD=/i,
]) {
  assert.doesNotMatch(serialized, secretPattern);
}

const bootstrapSource = await readFile(
  new URL("./bootstrap-trueforge.mjs", import.meta.url),
  "utf8",
);
assert.doesNotMatch(bootstrapSource, /\/api\/v1\/settings\/skills/);
assert.doesNotMatch(bootstrapSource, /artifactSkillManifest/);
assert.doesNotMatch(bootstrapSource, /artifact_instructions/);
assert.match(bootstrapSource, /<artifact_workflow>/);
assert.match(bootstrapSource, /MCP_AUTH_TOKEN/);
assert.match(bootstrapSource, /finalize_chart_artifact/);
assert.doesNotMatch(bootstrapSource, /disabled-/);

const composeSource = await readFile(
  new URL("../compose.yml", import.meta.url),
  "utf8",
);
assert.match(composeSource, /docker\/sandbox\/Dockerfile/);
assert.match(composeSource, /docker\/trueforge\/Dockerfile/);
assert.match(composeSource, /PLATFORM_SANDBOX_IMAGE_URI/);
assert.doesNotMatch(composeSource, /FORTY_TWO_ARTIFACT_SKILL/);
assert.doesNotMatch(composeSource, /trueforge-artifact-skill-contract/);

const sandboxDockerfile = await readFile(
  new URL("../docker/sandbox/Dockerfile", import.meta.url),
  "utf8",
);
assert.match(sandboxDockerfile, /0dab475d3d20a8333cff41f25f88e7134c424cf9/);
assert.match(
  sandboxDockerfile,
  /trueforge-sandbox@sha256:63196eb7c45b75b24e1354d1343eae38698a60fc9f638ee47e8d05c838bbae09/,
);
assert.match(
  sandboxDockerfile,
  /COPY packages\/artifacts\/python\/forty_two_artifacts\.py \/usr\/local\/lib\/python3\.13\/site-packages\/forty_two_artifacts\.py/,
);
assert.match(sandboxDockerfile, /pandas\.__version__ == "3\.0\.5"/);
assert.match(sandboxDockerfile, /pandas\.DataFrame/);
assert.doesNotMatch(sandboxDockerfile, /:latest\b/);

const trueforgeDockerfile = await readFile(
  new URL("../docker/trueforge/Dockerfile", import.meta.url),
  "utf8",
);
assert.match(trueforgeDockerfile, /PLATFORM_SANDBOX_IMAGE_URI/);
assert.match(trueforgeDockerfile, /platform-sandbox-image-contract\.mjs/);

const helperE2eSource = await readFile(
  new URL("./test-artifact-helper-daytona-e2e.mjs", import.meta.url),
  "utf8",
);
assert.match(
  helperE2eSource,
  /import \{\s*buildEmitCommand,\s*buildLoadCommand,\s*\} from "\.\/artifact-helper-acceptance\.mjs";/,
);
for (const requiredSnapshotEvidence of [
  "/usr/local/lib/python3.13/site-packages/forty_two_artifacts.py",
  "FORTY_TWO_ARTIFACT_HELPER_SHA256",
  "/api/chat/sessions/${applicationSessionId}/turns",
  "assertSafeArtifactApiEvidence",
  "assertIsolatedAcceptanceEnvironment",
  'event.type === "artifact.created"',
  'createHash("sha256").update(bytes).digest("hex")',
  'assert.equal(header.$schema, "table.v1")',
  "square: 603729",
]) {
  assert.ok(
    helperE2eSource.includes(requiredSnapshotEvidence),
    `The helper E2E is missing snapshot evidence: ${requiredSnapshotEvidence}`,
  );
}
for (const forbiddenInjectionPattern of [
  /readFile\s*\(/,
  /type:\s*["']file["']/,
  /data:text\/x-python/,
  /toString\(["']base64["']\)/,
  /createInjectedHelperSession/,
  /\/opt\/tf\/uploads/,
  /\/opt\/tfy\/skills/,
  /settings\/skills/,
  /FORTY_TWO_ARTIFACT_SKILL/,
  /importlib\.spec_from_file_location/,
  /sys\.path/,
  /packages\/artifacts\/python\/forty_two_artifacts\.py/,
]) {
  assert.doesNotMatch(helperE2eSource, forbiddenInjectionPattern);
}

const acceptanceContractSource = await readFile(
  new URL("./artifact-helper-acceptance.mjs", import.meta.url),
  "utf8",
);
for (const requiredCausalEvidence of [
  "export function buildEmitCommand",
  "export function buildLoadCommand",
  "assert source_sha256 == ${JSON.stringify(expectedHelperHash)}",
  "Expected exactly two model-issued sandbox exec calls",
  "Expected exactly one exact ${label} exec command.",
  "Finalization arguments did not exactly match the emit receipt",
  "load_table ran before finalization succeeded",
  'createHash("sha256").update(bytes).digest("hex")',
  "Artifact API bytes were not canonical table.v1 JSONL",
]) {
  assert.ok(
    acceptanceContractSource.includes(requiredCausalEvidence),
    `The public acceptance contract is missing evidence: ${requiredCausalEvidence}`,
  );
}
const acceptanceRegressionSource = await readFile(
  new URL("./test-artifact-helper-acceptance.mjs", import.meta.url),
  "utf8",
);
for (const acceptanceRegression of [
  "correlates exact emit, scoped finalize, load, and API bytes",
  "accepts only the exact TrueForge call_tool wrapper for finalization",
  "orders complete persisted histories chronologically",
  "rejects comment-only and echo-only fabricated exec evidence",
  "rejects a successful pre-emit helper overwrite exec",
  "rejects an unscoped or receipt-mismatched finalization",
]) {
  assert.ok(
    acceptanceRegressionSource.includes(acceptanceRegression),
    `The isolated acceptance suite is missing: ${acceptanceRegression}`,
  );
}

const acceptanceDockerfile = await readFile(
  new URL("../docker/acceptance/Dockerfile", import.meta.url),
  "utf8",
);
assert.match(
  acceptanceDockerfile,
  /COPY scripts\/artifact-helper-acceptance\.mjs \.\/artifact-helper-acceptance\.mjs/,
);
assert.match(
  acceptanceDockerfile,
  /COPY scripts\/test-artifact-helper-daytona-e2e\.mjs \.\/test-artifact-helper-daytona-e2e\.mjs/,
);
for (const forbiddenAcceptanceImageContent of [
  /COPY packages/,
  /COPY skills/,
  /COPY[^\n]*forty_two_artifacts\.py/,
  /\bVOLUME\b/,
]) {
  assert.doesNotMatch(acceptanceDockerfile, forbiddenAcceptanceImageContent);
}

const internalRunnerSource = await readFile(
  new URL("./run-compose-internal-e2e.mjs", import.meta.url),
  "utf8",
);
assert.match(
  internalRunnerSource,
  /"scripts\/test-artifact-helper-daytona-e2e\.mjs"/,
);
assert.match(internalRunnerSource, /runIsolatedArtifactHelperAcceptance/);
assert.match(internalRunnerSource, /`container:\$\{webContainer\}`/);
assert.match(internalRunnerSource, /"--read-only"/);
assert.match(internalRunnerSource, /"--cap-drop",\s*"ALL"/);
assert.doesNotMatch(internalRunnerSource, /--mount|--volume|-v\b/);
assert.doesNotMatch(internalRunnerSource, /FORTY_TWO_ARTIFACT_SKILL/);

const rootPackage = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(
  rootPackage.scripts?.["test:artifact-helper-python"],
  "PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s packages/artifacts/python/tests -p 'test_*.py' -v",
);
assert.equal(
  rootPackage.scripts?.["test:artifact-helper-daytona-e2e"],
  "node scripts/run-compose-internal-e2e.mjs scripts/test-artifact-helper-daytona-e2e.mjs",
);
assert.equal(
  rootPackage.scripts?.["test:artifact-helper-acceptance"],
  "node --test scripts/test-artifact-helper-acceptance.mjs",
);
const immutableImage = `registry.example.com/forty-two/sandbox@sha256:${"a".repeat(64)}`;
assert.equal(requiredImmutableSandboxImage(immutableImage), immutableImage);
for (const mutableImage of [
  "forty-two-sandbox:local",
  "registry.example.com/forty-two/sandbox:latest",
  "registry.example.com/forty-two/sandbox:release",
  `registry.example.com/forty-two/sandbox@sha256:${"A".repeat(64)}`,
]) {
  assert.throws(
    () => requiredImmutableSandboxImage(mutableImage),
    /immutable OCI image reference/,
  );
}

await assert.rejects(
  readFile(
    new URL(
      "../skills/forty-two-artifacts/scripts/forty_two_artifacts.py",
      import.meta.url,
    ),
  ),
  /ENOENT/,
);
await readFile(
  new URL(
    "../packages/artifacts/python/forty_two_artifacts.py",
    import.meta.url,
  ),
);

console.log("Agent spec and snapshot runtime contract passed.");
