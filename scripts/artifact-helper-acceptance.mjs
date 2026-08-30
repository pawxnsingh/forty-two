import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const EMIT_PROOF_PREFIX = "FT42_EMIT_PROOF_V1=";
export const LOAD_PROOF_PREFIX = "FT42_LOAD_PROOF_V1=";

export function buildEmitCommand({
  expectedHelperHash,
  helperModulePath,
  nonce,
  title,
  sessionId,
}) {
  return `python - <<'PY'
import hashlib
import json
import pathlib

import forty_two_artifacts
import pandas as pd
from forty_two_artifacts import emit_table

expected_path = pathlib.Path(${JSON.stringify(helperModulePath)})
source = pathlib.Path(forty_two_artifacts.__file__).resolve()
assert source == expected_path
source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
assert source_sha256 == ${JSON.stringify(expectedHelperHash)}
for alternate_root in (pathlib.Path("/opt") / "tf" / "uploads", pathlib.Path("/opt") / "tfy" / "skills"):
    assert not alternate_root.exists() or not any(alternate_root.rglob("forty_two_artifacts.py"))
frame = pd.DataFrame({"n": range(1000)})
frame["square"] = frame["n"] * frame["n"]
frame["nonce"] = ${JSON.stringify(nonce)}
receipt = emit_table(frame, ${JSON.stringify(sessionId)}, title=${JSON.stringify(title)}, parent_artifact_ids=[], source_references=[])
proof = {"version": 1, "modulePath": str(source), "sourceSha256": source_sha256, "receipt": receipt.to_dict()}
print(${JSON.stringify(EMIT_PROOF_PREFIX)} + json.dumps(proof, separators=(",", ":"), sort_keys=True))
PY`;
}

export function buildLoadCommand({
  artifactId,
  expectedHelperHash,
  helperModulePath,
  nonce,
  sessionId,
}) {
  return `python - <<'PY'
import hashlib
import json
import pathlib

import forty_two_artifacts
from forty_two_artifacts import load_table

expected_path = pathlib.Path(${JSON.stringify(helperModulePath)})
source = pathlib.Path(forty_two_artifacts.__file__).resolve()
assert source == expected_path
source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
assert source_sha256 == ${JSON.stringify(expectedHelperHash)}
for alternate_root in (pathlib.Path("/opt") / "tf" / "uploads", pathlib.Path("/opt") / "tfy" / "skills"):
    assert not alternate_root.exists() or not any(alternate_root.rglob("forty_two_artifacts.py"))
artifact_id = ${JSON.stringify(artifactId)}
frame = load_table(artifact_id, ${JSON.stringify(sessionId)})
assert len(frame.index) == 1000
assert frame["nonce"].eq(${JSON.stringify(nonce)}).all()
sentinel = frame.loc[frame["n"] == 777, "square"]
assert len(sentinel.index) == 1
assert int(sentinel.iloc[0]) == 603729
proof = {"version": 1, "modulePath": str(source), "sourceSha256": source_sha256, "artifactId": artifact_id, "rowCount": int(len(frame.index)), "sentinel": {"n": 777, "square": int(sentinel.iloc[0])}}
print(${JSON.stringify(LOAD_PROOF_PREFIX)} + json.dumps(proof, separators=(",", ":"), sort_keys=True))
PY`;
}

export function assertArtifactHelperEventChain({
  events,
  expectedHelperHash,
  helperModulePath,
  nonce,
  scopedServerName,
  title,
  sessionId,
}) {
  const orderedEvents = chronologicalEvents(events);
  const calls = collectCalls(orderedEvents);
  const responses = collectResponses(orderedEvents);
  const expectedEmitCommand = buildEmitCommand({
    expectedHelperHash,
    helperModulePath,
    nonce,
    title,
    sessionId,
  });
  const execCalls = calls.filter((call) => call.name === "exec");
  assert.equal(
    execCalls.length,
    2,
    `Expected exactly two model-issued sandbox exec calls (canonical emit then load); observed tools=${calls.map((call) => call.name).join(",") || "none"}, emitProof=${responses.some((response) => String(response.content).includes(EMIT_PROOF_PREFIX))}.`,
  );
  const emitCall = exactExecCall(calls, expectedEmitCommand, "emit");
  const emitResponse = correlatedResponse(responses, emitCall, "emit");
  const emitProof = prefixedProof(emitResponse.content, EMIT_PROOF_PREFIX);
  const receipt = validateEmitProof(emitProof, {
    expectedHelperHash,
    helperModulePath,
  });

  const expectedFinalizeArguments = {
    sessionId,
    artifactId: receipt.artifactId,
    contentSha256: receipt.contentSha256,
    title,
    parentArtifactIds: receipt.parentArtifactIds,
    sourceReferences: receipt.sourceReferences,
  };
  const finalizeCalls = calls.filter(
    (call) => call.name === "finalize_table_artifact",
  );
  assert.equal(
    finalizeCalls.length,
    1,
    "Expected exactly one finalize_table_artifact call.",
  );
  const finalizeCall = finalizeCalls[0];
  assert.equal(
    finalizeCall.serverName,
    scopedServerName,
    "Finalization did not use the exact shared MCP server.",
  );
  assert.deepEqual(
    finalizeCall.arguments,
    expectedFinalizeArguments,
    "Finalization arguments did not exactly match the emit receipt.",
  );
  const finalizeResponse = correlatedResponse(
    responses,
    finalizeCall,
    "finalize",
  );
  const committed = receiptLikeObject(finalizeResponse.content);
  assert.ok(committed, "Finalization response did not contain a receipt.");
  assert.equal(committed.artifactId, receipt.artifactId);
  assert.equal(committed.contentSha256, receipt.contentSha256);
  assert.equal(committed.rowCount, receipt.rowCount);
  assert.equal(committed.schemaVersion, "table.v1");

  const expectedLoadCommand = buildLoadCommand({
    artifactId: receipt.artifactId,
    expectedHelperHash,
    helperModulePath,
    nonce,
    sessionId,
  });
  const loadCall = exactExecCall(calls, expectedLoadCommand, "load");
  assert.strictEqual(
    execCalls[0],
    emitCall,
    "The first model-issued sandbox exec was not the canonical emit command.",
  );
  assert.strictEqual(
    execCalls[1],
    loadCall,
    "The second model-issued sandbox exec was not the canonical load command.",
  );
  const loadResponse = correlatedResponse(responses, loadCall, "load");
  const loadProof = prefixedProof(loadResponse.content, LOAD_PROOF_PREFIX);
  validateLoadProof(loadProof, {
    artifactId: receipt.artifactId,
    expectedHelperHash,
    helperModulePath,
  });

  assert.ok(
    emitCall.index < emitResponse.index,
    "Emit response preceded its call.",
  );
  assert.ok(
    emitResponse.index < finalizeCall.index,
    "Finalization did not follow the emitted receipt.",
  );
  assert.ok(
    finalizeCall.index < finalizeResponse.index,
    "Finalize response preceded its call.",
  );
  assert.ok(
    finalizeResponse.index < loadCall.index,
    "load_table ran before finalization succeeded.",
  );
  assert.ok(
    loadCall.index < loadResponse.index,
    "Load response preceded its call.",
  );

  return { receipt, committed, loadProof };
}

function chronologicalEvents(events) {
  const dated = events.map((event, inputIndex) => ({
    event,
    inputIndex,
    timestamp: Date.parse(event?.created_at ?? event?.createdAt ?? ""),
  }));
  if (!dated.every((item) => Number.isFinite(item.timestamp))) {
    return events;
  }
  return dated
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.inputIndex - right.inputIndex,
    )
    .map((item) => item.event);
}

export function assertArtifactApiEvidence({
  artifact,
  bytes,
  chain,
  nonce,
  title,
}) {
  const { receipt, committed, loadProof } = chain;
  assert.equal(artifact.id, receipt.artifactId);
  assert.equal(artifact.kind, "table");
  assert.equal(artifact.title, title);
  assert.equal(artifact.contentSha256, receipt.contentSha256);
  assert.equal(artifact.contentSha256, committed.contentSha256);
  assert.equal(artifact.rowCount, receipt.rowCount);
  assert.equal(artifact.rowCount, committed.rowCount);
  assert.equal(artifact.rowCount, loadProof.rowCount);
  assert.equal(bytes.byteLength, receipt.byteSize);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    receipt.contentSha256,
  );

  const text = bytes.toString("utf8");
  assert.ok(text.endsWith("\n"), "Artifact bytes were not canonical JSONL.");
  const lines = text.slice(0, -1).split("\n");
  const values = lines.map((line) => JSON.parse(line));
  const [header, ...rows] = values;
  assert.equal(header.$schema, "table.v1");
  assert.equal(header.rowCount, receipt.rowCount);
  assert.equal(rows.length, receipt.rowCount);
  assert.equal(
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    text,
    "Artifact API bytes were not canonical table.v1 JSONL.",
  );
  const sentinel = rows.find((row) => row.n === 777);
  assert.deepEqual(sentinel, { n: 777, square: 603729, nonce });
  assert.deepEqual(loadProof.sentinel, { n: 777, square: 603729 });
}

function collectCalls(events) {
  const calls = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== "model.message") continue;
    const toolCalls = event.toolCalls ?? event.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      const info = call.toolInfo ?? call.tool_info ?? {};
      const fn = call.function ?? {};
      const outerName = info.name ?? fn.name;
      const outerServerName = info.serverName ?? info.server_name;
      const outerArguments = parseArguments(fn.arguments);
      const wrapped = exactWrappedMcpCall({
        info,
        name: outerName,
        argumentsValue: outerArguments,
      });
      const name = wrapped?.name ?? outerName;
      const serverName = wrapped?.serverName ?? outerServerName;
      const argumentsValue = wrapped?.arguments ?? outerArguments;
      calls.push({
        id: call.id,
        index,
        name,
        serverName,
        arguments: argumentsValue,
        command:
          argumentsValue?.command ??
          argumentsValue?.cmd ??
          argumentsValue?.code,
      });
    }
  }
  return calls;
}

function exactWrappedMcpCall({ info, name, argumentsValue }) {
  if (info.type !== "truefoundry-system" || name !== "call_tool") {
    return undefined;
  }
  if (
    !isExactObject(info, ["type", "name"]) ||
    !isExactObject(argumentsValue, ["mcp_server", "tool_name", "input"]) ||
    typeof argumentsValue.mcp_server !== "string" ||
    typeof argumentsValue.tool_name !== "string" ||
    !isRecord(argumentsValue.input)
  ) {
    return undefined;
  }
  return {
    name: argumentsValue.tool_name,
    serverName: argumentsValue.mcp_server,
    arguments: argumentsValue.input,
  };
}

function isExactObject(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectResponses(events) {
  return events.flatMap((event, index) => {
    if (event.type !== "tool.response") return [];
    const toolCallId = event.toolCallId ?? event.tool_call_id;
    return [{ index, toolCallId, content: event.content }];
  });
}

function exactExecCall(calls, expectedCommand, label) {
  const candidates = calls.filter(
    (call) => call.name === "exec" && call.command === expectedCommand,
  );
  assert.equal(
    candidates.length,
    1,
    `Expected exactly one exact ${label} exec command.`,
  );
  for (const call of calls.filter(
    (candidate) =>
      candidate.name === "exec" &&
      typeof candidate.command === "string" &&
      candidate.command.includes(
        label === "emit" ? EMIT_PROOF_PREFIX : LOAD_PROOF_PREFIX,
      ),
  )) {
    assert.equal(
      call.command,
      expectedCommand,
      `A noncanonical ${label} proof-producing exec was observed.`,
    );
  }
  return candidates[0];
}

function correlatedResponse(responses, call, label) {
  const matches = responses.filter(
    (response) => response.toolCallId === call.id,
  );
  assert.equal(
    matches.length,
    1,
    `Expected exactly one response correlated to the ${label} call.`,
  );
  return matches[0];
}

function validateEmitProof(value, { expectedHelperHash, helperModulePath }) {
  assert.deepEqual(Object.keys(value).sort(), [
    "modulePath",
    "receipt",
    "sourceSha256",
    "version",
  ]);
  assert.equal(value.version, 1);
  assert.equal(value.modulePath, helperModulePath);
  assert.equal(value.sourceSha256, expectedHelperHash);
  const receipt = value.receipt;
  assert.ok(receipt && typeof receipt === "object");
  assert.match(receipt.artifactId, /^art_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(receipt.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.schemaVersion, "table.v1");
  assert.equal(receipt.rowCount, 1000);
  assert.ok(Number.isSafeInteger(receipt.byteSize) && receipt.byteSize > 0);
  assert.ok(Array.isArray(receipt.columns));
  assert.ok(Array.isArray(receipt.preview) && receipt.preview.length <= 30);
  assert.deepEqual(receipt.parentArtifactIds, []);
  assert.deepEqual(receipt.sourceReferences, []);
  assert.ok(Array.isArray(receipt.warnings));
  return receipt;
}

function validateLoadProof(
  value,
  { artifactId, expectedHelperHash, helperModulePath },
) {
  assert.deepEqual(Object.keys(value).sort(), [
    "artifactId",
    "modulePath",
    "rowCount",
    "sentinel",
    "sourceSha256",
    "version",
  ]);
  assert.equal(value.version, 1);
  assert.equal(value.modulePath, helperModulePath);
  assert.equal(value.sourceSha256, expectedHelperHash);
  assert.equal(value.artifactId, artifactId);
  assert.equal(value.rowCount, 1000);
  assert.deepEqual(value.sentinel, { n: 777, square: 603729 });
}

function prefixedProof(content, prefix) {
  const matches = [];
  for (const text of contentStrings(content)) {
    let offset = 0;
    while (offset < text.length) {
      const prefixIndex = text.indexOf(prefix, offset);
      if (prefixIndex < 0) break;
      const line = text
        .slice(prefixIndex + prefix.length)
        .split(/\r?\n/, 1)[0]
        .trim();
      try {
        matches.push(JSON.parse(line));
      } catch {
        // A proof prefix without one compact JSON object is not evidence.
      }
      offset = prefixIndex + prefix.length;
    }
  }
  assert.equal(
    matches.length,
    1,
    `Expected one structured proof for ${prefix}`,
  );
  return matches[0];
}

function receiptLikeObject(content) {
  for (const value of contentValues(content)) {
    if (
      value &&
      typeof value === "object" &&
      typeof value.artifactId === "string" &&
      typeof value.contentSha256 === "string" &&
      Number.isSafeInteger(value.rowCount)
    ) {
      return value;
    }
  }
  return undefined;
}

function contentStrings(content) {
  return contentValues(content).filter((value) => typeof value === "string");
}

function contentValues(content) {
  const values = [];
  const visit = (value) => {
    values.push(value);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          visit(JSON.parse(trimmed));
        } catch {
          // Command output is commonly plain text rather than a JSON envelope.
        }
      }
    } else if (Array.isArray(value)) {
      for (const nested of value) visit(nested);
    } else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(content);
  return values;
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
