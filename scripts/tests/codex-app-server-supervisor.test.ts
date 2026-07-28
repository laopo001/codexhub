import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  linuxAppServerSupervisorLaunch
} from "../../src/cli/codexAppServerProcess.js";

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const processChildren = async (pid: number) => {
  try {
    const value = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return value.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

const waitFor = async <T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5_000
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (accept(value)) return value;
    await delay(25);
  }
  throw new Error(`condition was not met after ${timeoutMs}ms`);
};

const readFirstStdoutLine = async (child: ReturnType<typeof spawn>) => await new Promise<string>((resolve, reject) => {
  let buffered = "";
  child.once("error", reject);
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buffered += chunk.toString();
    const newline = buffered.indexOf("\n");
    if (newline !== -1) resolve(buffered.slice(0, newline).trim());
  });
});

test("Linux parent-death supervisor removes the nested app-server process tree", {
  skip: process.platform !== "linux"
}, async () => {
  await access("/usr/bin/setpriv");
  await access("/bin/bash");
  const launch = linuxAppServerSupervisorLaunch("/bin/bash", ["-c", "sleep 1000 & wait"]);
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.argv[1], JSON.parse(process.argv[2]),",
    "  { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });",
    "console.log(child.pid);",
    "setInterval(() => {}, 1000);"
  ].join("\n");
  const parent = spawn(process.execPath, [
    "-e",
    parentScript,
    launch.command,
    JSON.stringify(launch.args)
  ], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  let supervisorPid = 0;
  let descendants: number[] = [];
  try {
    supervisorPid = Number(await readFirstStdoutLine(parent));
    assert.ok(Number.isInteger(supervisorPid) && supervisorPid > 0);
    descendants = await waitFor(
      async () => {
        const children = await processChildren(supervisorPid);
        const grandchildren = (await Promise.all(children.map(processChildren))).flat();
        return [...children, ...grandchildren];
      },
      (pids) => pids.length >= 2
    );

    parent.kill("SIGKILL");
    await new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    await waitFor(
      () => [supervisorPid, ...descendants].every((pid) => !processAlive(pid)),
      Boolean
    );
    assert.ok([supervisorPid, ...descendants].every((pid) => !processAlive(pid)));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    if (supervisorPid && processAlive(supervisorPid)) {
      try {
        process.kill(-supervisorPid, "SIGKILL");
      } catch {
        // 测试清理和进程退出之间可能发生竞争。
      }
    }
    for (const pid of descendants) {
      if (!processAlive(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 同上。
      }
    }
  }
});
