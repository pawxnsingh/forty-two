import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const committedDist = resolve(packageRoot, "dist");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "op-design-tokens-"));
const temporaryDist = resolve(temporaryRoot, "dist");

async function filesUnder(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, resolve(entry.parentPath, entry.name)))
    .sort();
}

try {
  await execute(process.execPath, ["scripts/generate.mjs", "--check"], { cwd: packageRoot });
  await execute("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json", "--outDir", temporaryDist], {
    cwd: packageRoot,
  });
  await execute(process.execPath, ["scripts/generate.mjs", "--dist-root", temporaryDist], {
    cwd: packageRoot,
  });

  const [expectedFiles, actualFiles] = await Promise.all([
    filesUnder(temporaryDist),
    filesUnder(committedDist),
  ]);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Generated dist file list is stale. Expected ${expectedFiles.join(", ")}; found ${actualFiles.join(", ")}`,
    );
  }

  for (const file of expectedFiles) {
    const [expected, actual] = await Promise.all([
      readFile(resolve(temporaryDist, file)),
      readFile(resolve(committedDist, file)),
    ]);
    if (!actual.equals(expected)) {
      throw new Error(`${file} is stale; run pnpm build in packages/design-tokens`);
    }
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
