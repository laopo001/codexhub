import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, readlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

type MachineSummary = {
  machineId: string;
  type?: string;
  name?: string;
  online?: boolean;
  offlineReason?: string;
  capabilities?: {
    projectLauncher?: boolean;
  };
};

type ProjectOpenResponse = {
  result?: {
    sessionId?: string;
    threadId?: string;
    cwd?: string;
  };
};

type SessionState = {
  sessionId: string;
  online?: boolean;
  offlineReason?: string;
  appServerUrl?: string;
};

type ThreadDetail = {
  threadId: string;
  records?: unknown[];
};

const repoRoot = process.cwd();

const main = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-registered-smoke."));
  const dataDir = path.join(root, "state");
  const projectDir = path.join(root, "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_LOCAL_MACHINE = "0";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "0";
  process.env.TELEGRAM_BOT_TOKEN = "";

  const port = await findFreePort();
  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({ host: "127.0.0.1", port });
  const apiBase = `http://127.0.0.1:${port}`;
  const machineId = `registered-smoke-${process.pid}`;
  const machineName = "Registered Machine Smoke";
  const child = startRegisteredMachine(apiBase, machineId, machineName);

  try {
    const machine = await waitForRegisteredMachine(apiBase, machineId, machineName, child);
    console.log(`registered machine ok: ${machine.machineId}`);

    const open = await apiJson<ProjectOpenResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: machine.machineId, path: projectDir })
    }, 120_000);
    assertNoWorkerId(open, "/api/projects/open");
    const sessionId = open.result?.sessionId;
    const threadId = open.result?.threadId;
    if (!sessionId || !threadId) throw new Error(`project open did not return session/thread: ${JSON.stringify(open)}`);
    if (open.result?.cwd !== projectDir) throw new Error(`registered machine opened unexpected cwd: ${open.result?.cwd}`);
    const session = await waitForSessionOnline(apiBase, sessionId);
    if (!session.appServerUrl?.startsWith("tunnel://")) {
      throw new Error(`registered session did not use app-server tunnel: ${session.appServerUrl ?? ""}`);
    }
    console.log(`project/session ok: ${sessionId} ${threadId}`);

    const turn = await apiJson(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, input: "/status", source: "web" })
    });
    assertNoWorkerId(turn, "/api/sessions/:sessionId/turn");

    const thread = await waitForThreadRecords(apiBase, threadId, 2);
    assertNoWorkerId(thread, "/api/threads/:threadId");
    console.log("thread flow ok");

    await stopChild(child);
    await waitForMachineUnregistered(apiBase, machine.machineId);
    await waitForSessionStopped(apiBase, sessionId);
    await waitForNoCodexAppServerForCwd(projectDir);
    console.log("registered lifecycle ok");
  } catch (error) {
    const output = child.output();
    if (output.trim()) console.error(`registered machine output:\n${output}`);
    throw error;
  } finally {
    await stopChild(child).catch(() => undefined);
    await server.stop();
  }
};

const startRegisteredMachine = (apiBase: string, machineId: string, machineName: string) => {
  let output = "";
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli/codexhub.ts",
    "machine",
    "--server",
    apiBase,
    "--type",
    "registered",
    "--machine-id",
    machineId,
    "--name",
    machineName
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HUB_LOCAL_MACHINE: "0",
      CODEX_HUB_PLUGIN_TELEGRAM: "0",
      TELEGRAM_BOT_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return Object.assign(child, { output: () => output });
};

const waitForSessionOnline = async (apiBase: string, sessionId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const data = await apiJson<{ sessions?: SessionState[] }>(apiBase, "/api/sessions?includeOffline=true").catch(() => ({ sessions: [] }));
    const session = data.sessions?.find((item) => item.sessionId === sessionId);
    if (session?.online) return session;
    await delay(250);
  }
  throw new Error(`registered session did not come online: ${sessionId}`);
};

const waitForRegisteredMachine = async (
  apiBase: string,
  machineId: string,
  machineName: string,
  child: ChildProcess & { output: () => string }
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`registered machine exited early: code=${child.exitCode} signal=${child.signalCode}\n${child.output()}`);
    }
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) =>
      item.machineId === machineId
      && item.type === "registered"
      && item.name === machineName
      && item.online
      && item.capabilities?.projectLauncher
    );
    if (machine) return machine;
    await delay(250);
  }
  throw new Error(`registered machine did not appear: ${machineId}\n${child.output()}`);
};

const waitForMachineUnregistered = async (apiBase: string, machineId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) => item.machineId === machineId);
    if (machine && !machine.online && machine.offlineReason === "unregistered") return machine;
    await delay(250);
  }
  throw new Error(`registered machine did not unregister cleanly: ${machineId}`);
};

const waitForSessionStopped = async (apiBase: string, sessionId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const data = await apiJson<{ sessions?: SessionState[] }>(apiBase, "/api/sessions?includeOffline=true").catch(() => ({ sessions: [] }));
    const session = data.sessions?.find((item) => item.sessionId === sessionId);
    if (!session || (!session.online && session.offlineReason === "unregistered")) return session;
    await delay(250);
  }
  throw new Error(`registered session did not stop cleanly: ${sessionId}`);
};

const waitForNoCodexAppServerForCwd = async (cwd: string) => {
  const startedAt = Date.now();
  let matches: string[] = [];
  while (Date.now() - startedAt < 8000) {
    matches = await codexAppServersForCwd(cwd);
    if (!matches.length) return;
    await delay(250);
  }
  throw new Error(`codex app-server leaked after registered machine stop:\n${matches.join("\n")}`);
};

const codexAppServersForCwd = async (cwd: string) => {
  if (process.platform !== "linux") return [];
  const entries = await readdir("/proc").catch(() => []);
  const matches: string[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const procCwd = await readlink(`/proc/${entry}/cwd`).catch(() => "");
    if (procCwd !== cwd) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    const command = cmdline.replace(/\0/g, " ").trim();
    if (command.includes("codex app-server")) matches.push(`${entry} ${command}`);
  }
  return matches;
};

const waitForThreadRecords = async (apiBase: string, threadId: string, count: number) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const thread = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    if ((thread.records ?? []).length >= count) return thread;
    await delay(250);
  }
  throw new Error(`thread did not receive ${count} records: ${threadId}`);
};

const stopChild = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!await waitForChildExit(child, 5000)) {
    child.kill("SIGKILL");
    await waitForChildExit(child, 3000);
  }
};

const waitForChildExit = async (child: ChildProcess, timeoutMs: number) =>
  await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const apiJson = async <T = unknown>(
  apiBase: string,
  pathname: string,
  init?: RequestInit,
  timeoutMs = 30_000
): Promise<T> => {
  const response = await fetch(new URL(pathname, apiBase), {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${pathname}: ${text}`);
  return data as T;
};

const assertNoWorkerId = (value: unknown, label: string) => {
  const path = findKey(value, "workerId");
  if (path) throw new Error(`${label} exposed workerId at ${path}`);
};

const findKey = (value: unknown, key: string, trail = "$"): string | null => {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findKey(value[index], key, `${trail}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const entryTrail = `${trail}.${entryKey}`;
    if (entryKey === key) return entryTrail;
    const found = findKey(entryValue, key, entryTrail);
    if (found) return found;
  }
  return null;
};

const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("could not allocate tcp port")));
      return;
    }
    const port = address.port;
    server.close(() => resolve(port));
  });
});

const delay = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
