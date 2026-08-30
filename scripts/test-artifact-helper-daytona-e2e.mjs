import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildEmitCommand,
  buildLoadCommand,
} from "./artifact-helper-acceptance.mjs";

const webUrl = normalizedUrl(process.env.WEB_URL || "http://127.0.0.1:3001");
const expectedHelperHash = requiredSha256(
  requiredEnvironment("FORTY_TWO_ARTIFACT_HELPER_SHA256"),
);
const helperModulePath =
  "/usr/local/lib/python3.13/site-packages/forty_two_artifacts.py";
const nonce = `daytona-helper-${Date.now()}-${process.pid}`;
let applicationSessionId;
let dataSourceId;

await assertIsolatedAcceptanceEnvironment();

try {
  dataSourceId = await createReadyFixture();
  const created = await productApi("/api/chat/sessions", {
    method: "POST",
    headers: { "Idempotency-Key": nonce },
    body: { dataSourceIds: [dataSourceId] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  applicationSessionId = created.body.data.id;
  const artifactCapability = created.body.data.artifactCapability;
  assert.match(artifactCapability, /^ftart1\./);
  const mcpServerName = "forty-two-data-source";
  await proveSnapshotProductSession(applicationSessionId, mcpServerName);

  const title = `Daytona snapshot helper ${nonce}`;
  const emitCommand = buildEmitCommand({
    expectedHelperHash,
    helperModulePath,
    nonce,
    title,
    sessionId: applicationSessionId,
  });
  const loadCommandTemplate = buildLoadCommand({
    artifactId: "<ARTIFACT_ID>",
    expectedHelperHash,
    helperModulePath,
    nonce,
    sessionId: applicationSessionId,
  });
  const message = `Prove the platform snapshot-installed artifact helper with one exact causal chain. Do not upload or create any helper file and do not alter either command.

1. Call the Daytona sandbox exec tool once with the exact command below (the command argument must match byte-for-byte):
<emit_command>
${emitCommand}
</emit_command>
Parse the final FT42_EMIT_PROOF_V1 JSON object from that correlated exec response.

2. Call ${mcpServerName} finalize_table_artifact directly exactly once. Its arguments must include sessionId ${applicationSessionId}, artifactId and contentSha256 from that receipt, title ${JSON.stringify(title)}, and the receipt's empty parentArtifactIds and sourceReferences. Wait for the correlated response and require the same artifact ID, hash, and rowCount 1000.

3. Replace only <ARTIFACT_ID> in the exact command template below with the committed artifact ID, then call Daytona sandbox exec once with the resulting exact command:
<load_command_template>
${loadCommandTemplate}
</load_command_template>
Parse the final FT42_LOAD_PROOF_V1 JSON object from that correlated exec response and require the same artifact ID, rowCount 1000, and sentinel square 603729.

Never print the DataFrame or put complete rows in a model message or MCP argument. After the chain succeeds, answer concisely with the committed artifact ID.`;

  const createdTurn = await productApi(
    `/api/chat/sessions/${applicationSessionId}/turns`,
    { method: "POST", body: { message } },
  );
  assert.equal(createdTurn.status, 202, JSON.stringify(createdTurn.body));
  const turnId = createdTurn.body.data.id;
  const completed = await productApi(
    `/api/chat/sessions/${applicationSessionId}/turns/${turnId}/wait`,
    {
      method: "POST",
      body: { timeoutSeconds: 300 },
      timeoutMs: 330_000,
    },
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(
    completed.body.data.state?.status,
    "done",
    JSON.stringify(completed.body.data.state),
  );
  const events = await productApi(
    `/api/chat/sessions/${applicationSessionId}/turns/${turnId}/events`,
  );
  assert.equal(events.status, 200, JSON.stringify(events.body));
  const eventList = events.body.data || [];
  assert.deepEqual(eventList, events.body.normalizedEvents);
  assert.equal(
    eventList.some((event) => "event" in event),
    false,
  );
  assert.equal(
    eventList.some((event) => event.type === "sandbox.created"),
    false,
  );
  const artifactEvents = eventList.filter(
    (event) =>
      event.type === "artifact.created" &&
      event.artifact?.kind === "table" &&
      event.artifact?.rowCount === 1000,
  );
  assert.equal(artifactEvents.length, 1, JSON.stringify(eventList));
  const artifactEvent = artifactEvents[0];
  const artifactId = artifactEvent.artifact.id;
  const assistantText = eventList
    .filter((event) => event.type === "assistant.message.delta")
    .map((event) => event.text)
    .join("");
  assert.equal(assistantText.includes(artifactId), true);

  const serializedEvents = JSON.stringify(eventList);
  for (const forbiddenInjectionEvidence of [
    ["", "opt", "tf", "uploads"].join("/"),
    ["", "opt", "tfy", "skills"].join("/"),
    ["data", "text/x-python"].join(":"),
    ["importlib", "spec_from_file_location"].join("."),
  ]) {
    assert.equal(
      serializedEvents.includes(forbiddenInjectionEvidence),
      false,
      `Turn events contained forbidden helper injection evidence: ${forbiddenInjectionEvidence}`,
    );
  }
  assert.equal(serializedEvents.includes('"n":777,"square":603729'), false);

  const artifacts = await productApi(
    `/api/chat/sessions/${applicationSessionId}/artifacts?limit=100`,
    { headers: { authorization: `Bearer ${artifactCapability}` } },
  );
  assert.equal(artifacts.status, 200, JSON.stringify(artifacts.body));
  const artifact = artifacts.body.data.artifacts.find(
    (candidate) => candidate.id === artifactId,
  );
  assert.ok(artifact, JSON.stringify(artifacts.body));

  const download = await fetch(
    `${webUrl}/api/chat/sessions/${applicationSessionId}/artifacts/${artifactId}/download`,
    {
      headers: { authorization: `Bearer ${artifactCapability}` },
      signal: AbortSignal.timeout(60_000),
    },
  );
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assertSafeArtifactApiEvidence({
    artifact,
    artifactEvent,
    bytes,
    nonce,
    title,
  });

  console.log(
    `Snapshot-baked Daytona helper passed (session=${applicationSessionId}, helperSha256=${expectedHelperHash}, artifact=${artifactId}, rows=${artifact.rowCount}).`,
  );
} finally {
  if (applicationSessionId) {
    await productApi(`/api/chat/sessions/${applicationSessionId}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
  if (dataSourceId) {
    await productApi(`/api/data-sources/${dataSourceId}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
}

function assertSafeArtifactApiEvidence({
  artifact,
  artifactEvent,
  bytes,
  nonce,
  title,
}) {
  assert.equal(artifact.id, artifactEvent.artifact.id);
  assert.equal(artifact.kind, "table");
  assert.equal(artifact.title, title);
  assert.equal(artifact.rowCount, 1000);
  assert.equal(artifactEvent.artifact.rowCount, artifact.rowCount);
  assert.match(artifact.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    artifact.contentSha256,
  );
  const text = bytes.toString("utf8");
  assert.ok(text.endsWith("\n"), "Artifact bytes were not canonical JSONL.");
  const values = text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line));
  const [header, ...rows] = values;
  assert.equal(header.$schema, "table.v1");
  assert.equal(header.rowCount, artifact.rowCount);
  assert.equal(rows.length, artifact.rowCount);
  assert.deepEqual(
    rows.find((row) => row.n === 777),
    {
      n: 777,
      square: 603729,
      nonce,
    },
  );
}

async function assertIsolatedAcceptanceEnvironment() {
  assert.equal(fileURLToPath(new URL(".", import.meta.url)), "/acceptance/");
  assert.deepEqual((await readdir("/acceptance")).sort(), [
    "artifact-helper-acceptance.mjs",
    "test-artifact-helper-daytona-e2e.mjs",
  ]);
  for (const forbiddenPath of [
    "/workspace",
    "/skills",
    ["", "opt", "tfy", "skills"].join("/"),
    ["", "acceptance", "forty_two_artifacts.py"].join("/"),
    [
      "",
      "acceptance",
      "packages",
      "artifacts",
      "python",
      "forty_two_artifacts.py",
    ].join("/"),
  ]) {
    await assert.rejects(access(forbiddenPath));
  }
}

async function proveSnapshotProductSession(sessionId, mcpServerName) {
  const session = await productApi(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}`,
  );
  assert.equal(session.status, 200, JSON.stringify(session.body));
  assert.equal(session.body.data?.agent?.type, "inline");
  const spec = session.body.data.agent.spec;
  assert.equal(spec?.skills, undefined);
  assert.match(
    spec?.instructions ?? "",
    /from forty_two_artifacts import emit_table, load_table, visualize/,
  );
  const scopedServers = spec?.mcp_servers ?? spec?.mcpServers;
  assert.equal(
    scopedServers?.filter((server) => server.name === mcpServerName).length,
    1,
  );
}

async function createReadyFixture() {
  const bytes = Buffer.from(`nonce,value\n${nonce},1\n`, "utf8");
  const initiated = await productApi("/api/data-sources/files/initiate", {
    method: "POST",
    body: {
      name: `Daytona helper fixture ${nonce}`,
      filename: "daytona-helper.csv",
      mimeType: "text/csv",
      fileSizeBytes: bytes.byteLength,
    },
  });
  assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
  const upload = await fetch(initiated.body.upload.url, {
    method: "PUT",
    headers: initiated.body.upload.headers,
    body: bytes,
  });
  assert.equal(upload.status, 201);
  const completed = await productApi(
    `/api/data-sources/${initiated.body.data.id}/complete`,
    { method: "POST" },
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  return initiated.body.data.id;
}

function productApi(path, options = {}) {
  return requestJson(`${webUrl}${path}`, options);
}

async function requestJson(
  url,
  { method = "GET", body, headers = {}, timeoutMs = 60_000 } = {},
) {
  const response = await fetch(url, {
    method,
    headers:
      body === undefined
        ? headers
        : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => undefined),
  };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredSha256(value) {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      "FORTY_TWO_ARTIFACT_HELPER_SHA256 must be a lowercase SHA-256.",
    );
  }
  return value;
}

function normalizedUrl(value) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("E2E URLs must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}
