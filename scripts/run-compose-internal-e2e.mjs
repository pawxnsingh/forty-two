import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const allowedScripts = new Set([
  "scripts/test-artifact-backend-e2e.mjs",
  "scripts/test-artifact-helper-daytona-e2e.mjs",
  "scripts/test-chat-backend-e2e.mjs",
  "scripts/test-database-datasource-e2e.mjs",
  "scripts/test-file-integration.mjs",
  "scripts/test-plan-e2e.mjs",
  "scripts/test-platform-integration.mjs",
  "scripts/test-sql-change-approval-e2e.mjs",
]);
const script = process.argv[2];
if (!allowedScripts.has(script)) {
  throw new Error("A supported internal E2E script path is required.");
}
const artifactFixtureSourcePath =
  script === "scripts/test-artifact-backend-e2e.mjs"
    ? process.env.COFFEE_SALES_CSV_PATH?.trim()
    : undefined;
if (
  script === "scripts/test-artifact-backend-e2e.mjs" &&
  !artifactFixtureSourcePath
) {
  throw new Error(
    "COFFEE_SALES_CSV_PATH must point to the Coffee Sales CSV fixture for the artifact backend E2E.",
  );
}

let helperHash;
if (script === "scripts/test-artifact-helper-daytona-e2e.mjs") {
  helperHash = createHash("sha256")
    .update(readFileSync("packages/artifacts/python/forty_two_artifacts.py"))
    .digest("hex");
}

const discovery = spawnSync(
  "docker",
  [
    "ps",
    "--filter",
    "status=running",
    "--filter",
    `label=com.docker.compose.project.working_dir=${process.cwd()}`,
    "--filter",
    "label=com.docker.compose.service=web",
    "--format",
    "{{.ID}}",
  ],
  { encoding: "utf8" },
);
if (discovery.error) throw discovery.error;
if (discovery.status !== 0) {
  throw new Error(
    `Could not discover the running Compose web container: ${discovery.stderr.trim() || "unknown Docker error"}`,
  );
}
const webContainers = discovery.stdout
  .split("\n")
  .map((value) => value.trim())
  .filter(Boolean);
if (webContainers.length !== 1) {
  throw new Error(
    `Expected exactly one running Compose web container; found ${webContainers.length}.`,
  );
}

const result = helperHash
  ? runIsolatedArtifactHelperAcceptance(webContainers[0], helperHash)
  : runInsideWebContainer(webContainers[0], script);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

function runInsideWebContainer(webContainer, scriptPath) {
  const environmentArguments = [
    "-e",
    "TRUEFORGE_URL=http://trueforge:8790",
    "-e",
    "DATA_SOURCE_MCP_URL=http://data-source-mcp:8791",
    "-e",
    "TODO_MCP_URL=http://todo-mcp:8792",
    "-e",
    "WEB_URL=http://127.0.0.1:3000",
  ];
  let fixturePath;
  if (scriptPath === "scripts/test-artifact-backend-e2e.mjs") {
    fixturePath = `/tmp/forty-two-coffee-sales-${process.pid}.csv`;
    const copied = spawnSync(
      "docker",
      ["cp", artifactFixtureSourcePath, `${webContainer}:${fixturePath}`],
      { stdio: "inherit" },
    );
    if (copied.error) throw copied.error;
    if (copied.status !== 0) return copied;
    environmentArguments.push("-e", `COFFEE_SALES_CSV_PATH=${fixturePath}`);
  }

  const executed = spawnSync(
    "docker",
    ["exec", ...environmentArguments, webContainer, "node", scriptPath],
    { stdio: "inherit" },
  );
  if (!fixturePath) return executed;

  const removed = spawnSync(
    "docker",
    ["exec", "--user", "0", webContainer, "rm", "--", fixturePath],
    { stdio: "inherit" },
  );
  if (removed.error) throw removed.error;
  return executed.status === 0 ? removed : executed;
}

function runIsolatedArtifactHelperAcceptance(webContainer, expectedHash) {
  const image = "forty-two-artifact-helper-acceptance:local";
  const built = spawnSync(
    "docker",
    ["build", "--file", "docker/acceptance/Dockerfile", "--tag", image, "."],
    { stdio: "inherit" },
  );
  if (built.error) throw built.error;
  if (built.status !== 0) return built;
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      `container:${webContainer}`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "-e",
      `FORTY_TWO_ARTIFACT_HELPER_SHA256=${expectedHash}`,
      "-e",
      "WEB_URL=http://127.0.0.1:3000",
      image,
    ],
    { stdio: "inherit" },
  );
}
