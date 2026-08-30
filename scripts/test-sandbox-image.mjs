import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { requiredImmutableSandboxImage } from "./platform-sandbox-image-contract.mjs";

const image =
  process.env.FORTY_TWO_SANDBOX_LOCAL_IMAGE?.trim() ||
  "forty-two-sandbox:local";
const helperPath = new URL(
  "../packages/artifacts/python/forty_two_artifacts.py",
  import.meta.url,
);
const expectedHash = createHash("sha256")
  .update(await readFile(helperPath))
  .digest("hex");
const proof = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--entrypoint",
    "python",
    image,
    "-c",
    'import hashlib,json,pathlib,pandas as pd,forty_two_artifacts as helper; source=pathlib.Path(helper.__file__).resolve(); frame=pd.DataFrame({"n":[1,2]}); assert int(frame["n"].sum()) == 3; print(json.dumps({"path":str(source),"sha256":hashlib.sha256(source.read_bytes()).hexdigest(),"emit":callable(helper.emit_table),"load":callable(helper.load_table),"pandasVersion":pd.__version__,"dataframeRows":int(len(frame.index))}))',
  ],
  { encoding: "utf8" },
);
if (proof.error) throw proof.error;
assert.equal(proof.status, 0, proof.stderr);
const evidence = JSON.parse(proof.stdout.trim());
assert.deepEqual(evidence, {
  path: "/usr/local/lib/python3.13/site-packages/forty_two_artifacts.py",
  sha256: expectedHash,
  emit: true,
  load: true,
  pandasVersion: "3.0.5",
  dataframeRows: 2,
});

assert.equal(
  requiredImmutableSandboxImage(
    `registry.example.com/forty-two/sandbox@sha256:${"a".repeat(64)}`,
  ),
  `registry.example.com/forty-two/sandbox@sha256:${"a".repeat(64)}`,
);
for (const mutable of [
  "forty-two-sandbox:local",
  "registry.example.com/forty-two/sandbox:latest",
  "registry.example.com/forty-two/sandbox:2026-08-29",
  `registry.example.com/forty-two/sandbox@sha256:${"A".repeat(64)}`,
]) {
  assert.throws(
    () => requiredImmutableSandboxImage(mutable),
    /immutable OCI image reference/,
  );
}

console.log(
  `Sandbox image helper contract passed (image=${image}, sha256=${expectedHash}).`,
);
