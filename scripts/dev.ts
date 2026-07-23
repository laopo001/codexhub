import { spawn, type ChildProcess } from "node:child_process";

const services = [
  { name: "api", args: ["run", "dev:api"] },
  { name: "web", args: ["run", "dev:web"] },
] as const;

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const children: ChildProcess[] = [];
const completed = new Set<ChildProcess>();
let exitCode = 0;
let stopping = false;
let resolveDone!: () => void;
const done = new Promise<void>((resolve) => {
  resolveDone = resolve;
});

const stopAll = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!completed.has(child)) child.kill(signal);
  }
};

for (const service of services) {
  const child = spawn(pnpmCommand, service.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  children.push(child);
  child.once("error", (error) => {
    console.error(`codexhub dev ${service.name} failed to start: ${error.message}`);
    exitCode = 1;
    stopAll("SIGTERM");
  });
  child.once("close", (code, signal) => {
    completed.add(child);
    if (!stopping) {
      exitCode = code ?? 1;
      console.error(`codexhub dev ${service.name} stopped (${signal ?? `exit ${code}`}); stopping remaining services.`);
      stopAll("SIGTERM");
    }
    if (completed.size === services.length) resolveDone();
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => stopAll(signal));
}

console.error("codexhub dev starting: web http://127.0.0.1:15173 -> api http://127.0.0.1:18788");
await done;
process.exitCode = exitCode;
