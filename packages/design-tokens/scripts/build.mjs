import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(packageRoot, "dist");

await rm(distRoot, { force: true, recursive: true });
await execute("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], { cwd: packageRoot });
await execute(process.execPath, ["scripts/generate.mjs"], { cwd: packageRoot });
