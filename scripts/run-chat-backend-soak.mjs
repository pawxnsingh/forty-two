import { spawn } from "node:child_process";

const rawRuns = process.env.CHAT_BACKEND_SOAK_RUNS?.trim() || "5";
const runs = Number(rawRuns);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) {
  throw new Error(
    "CHAT_BACKEND_SOAK_RUNS must be an integer from 1 through 20.",
  );
}

const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (let iteration = 1; iteration <= runs; iteration += 1) {
  console.log(`Combined live soak ${iteration}/${runs} starting.`);
  const exitCode = await run(executable, ["test:chat-backend-e2e"]);
  if (exitCode !== 0) {
    throw new Error(
      `Combined live soak failed on iteration ${iteration}/${runs} with exit code ${exitCode}.`,
    );
  }
  console.log(`Combined live soak ${iteration}/${runs} passed.`);
}

console.log(`Combined live soak passed ${runs}/${runs} consecutive runs.`);

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(
          new Error(`Combined live soak child exited from signal ${signal}.`),
        );
        return;
      }
      resolve(code ?? 1);
    });
  });
}
