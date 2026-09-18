import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  linuxAppServerSupervisorLaunch
} from "../src/cli/codexAppServerProcess.js";

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

type SupervisorLaunchMessage =
  | { type: "spawned"; pid: number }
  | { type: "error"; code?: string; message: string };

const readSupervisorPid = async (child: ReturnType<typeof spawn>) => await new Promise<number>((resolve, reject) => {
  let stderr = "";
  const onStderr = (chunk: Buffer | string) => {
    stderr += chunk.toString();
  };
  const cleanup = () => {
    child.off("error", onError);
    child.off("exit", onExit);
    child.off("message", onMessage);
    child.stderr?.off("data", onStderr);
  };
  const fail = (message: string) => {
    cleanup();
    const detail = stderr.trim();
    reject(new Error(detail ? `${message}\n${detail}` : message));
  };
  const onError = (error: Error) => fail(`supervisor fixture parent failed to spawn: ${error.message}`);
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    fail(`supervisor fixture parent exited before reporting its child: code=${code ?? ""} signal=${signal ?? ""}`);
  };
  const onMessage = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const payload = message as SupervisorLaunchMessage;
    if (payload.type === "error") {
      fail(`supervisor fixture child failed to spawn${payload.code ? ` (${payload.code})` : ""}: ${payload.message}`);
      return;
    }
    if (payload.type !== "spawned" || !Number.isInteger(payload.pid) || payload.pid <= 0) return;
    cleanup();
    resolve(payload.pid);
  };
  child.stderr?.on("data", onStderr);
  child.once("error", onError);
  child.once("exit", onExit);
  child.on("message", onMessage);
});

test("Linux parent-death supervisor removes the nested app-server process tree", {
  skip: process.platform !== "linux"
}, async () => {
  await access("/usr/bin/setpriv", constants.X_OK);
  await access("/bin/bash", constants.X_OK);
  const launch = linuxAppServerSupervisorLaunch("/bin/bash", ["-c", "sleep 1000 & wait"]);
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.argv[1], JSON.parse(process.argv[2]),",
    "  { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });",
    "child.once('spawn', () => process.send({ type: 'spawned', pid: child.pid }));",
    "child.once('error', (error) => {",
    "  process.send({ type: 'error', code: error.code, message: error.message }, () => process.exit(1));",
    "});",
    "setInterval(() => {}, 1000);"
  ].join("\n");
  const parent = spawn(process.execPath, [
    "-e",
    parentScript,
    launch.command,
    JSON.stringify(launch.args)
  ], {
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let supervisorPid = 0;
  let descendants: number[] = [];
  try {
    supervisorPid = await readSupervisorPid(parent);
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
