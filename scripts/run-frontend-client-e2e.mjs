import { spawnSync } from "node:child_process";

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
const containers = discovery.stdout
  .split("\n")
  .map((value) => value.trim())
  .filter(Boolean);
if (containers.length !== 1) {
  throw new Error(
    `Expected exactly one running Compose web container; found ${containers.length}.`,
  );
}

const result = spawnSync(
  "docker",
  [
    "exec",
    "-e",
    "TRUEFORGE_URL=http://trueforge:8790",
    "-e",
    "WEB_URL=http://127.0.0.1:3000",
    containers[0],
    "node",
    "scripts/test-frontend-client-e2e.mjs",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
