import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoWorkerId } from "./smoke/support/assertions.js";
import { apiJson } from "./smoke/support/http.js";
import { findFreePort } from "./smoke/support/network.js";
import { delay } from "./smoke/support/time.js";

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

type ProjectThreadStartResponse = {
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
  const dataDir = path.join(root, "parent-state");
  const commandProjectDir = path.join(root, "project-machine-command");
  const serverProjectDir = path.join(root, "project-server-register");
  const dynamicProjectDir = path.join(root, "project-dynamic-server-register");
  const childServerDataDir = path.join(root, "child-server-state");
  const dynamicServerDataDir = path.join(root, "dynamic-server-state");
  await mkdir(dataDir, { recursive: true });
  await mkdir(commandProjectDir, { recursive: true });
  await mkdir(serverProjectDir, { recursive: true });
  await mkdir(dynamicProjectDir, { recursive: true });
  await mkdir(childServerDataDir, { recursive: true });
  await mkdir(dynamicServerDataDir, { recursive: true });

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_LOCAL_MACHINE = "0";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "0";
  process.env.TELEGRAM_BOT_TOKEN = "";

  const port = await findFreePort();
  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({ host: "127.0.0.1", port });
  const apiBase = `http://127.0.0.1:${port}`;

  try {
    const commandMachineId = `registered-machine-smoke-${process.pid}`;
    const commandMachineName = "Registered Machine Command Smoke";
    await runRegisteredScenario({
      label: "registered machine command",
      apiBase,
      machineId: commandMachineId,
      machineName: commandMachineName,
      projectDir: commandProjectDir,
      child: startRegisteredMachine(apiBase, commandMachineId, commandMachineName)
    });
    const serverMachineId = `registered-server-smoke-${process.pid}`;
    const serverMachineName = "Registered Server Smoke";
    await runRegisteredScenario({
      label: "registered server",
      apiBase,
      machineId: serverMachineId,
      machineName: serverMachineName,
      projectDir: serverProjectDir,
      child: await startRegisteredServer(apiBase, serverMachineId, serverMachineName, childServerDataDir)
    });
    const dynamicMachineId = `registered-dynamic-server-smoke-${process.pid}`;
    const dynamicMachineName = "Registered Dynamic Server Smoke";
    const dynamicChild = await startDynamicRegisteredServer(dynamicServerDataDir);
    await waitForChildServer(dynamicChild.apiBase, dynamicChild);
    await assertSelfRegistrationRejected(dynamicChild.apiBase);
    const parentRegistration = await apiJson<{ registration?: { status?: string } }>(dynamicChild.apiBase, "/api/registered/parent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${apiBase}?token=dynamic-smoke-token`,
        machineId: dynamicMachineId,
        name: dynamicMachineName
      })
    });
    if (!parentRegistration.registration || parentRegistration.registration.status === "idle") {
      throw new Error(`dynamic server registration did not start: ${JSON.stringify(parentRegistration)}`);
    }
    await runRegisteredScenario({
      label: "registered server dynamic",
      apiBase,
      machineId: dynamicMachineId,
      machineName: dynamicMachineName,
      projectDir: dynamicProjectDir,
      child: dynamicChild
    });
  } finally {
    await server.stop();
  }
};

const assertSelfRegistrationRejected = async (apiBase: string) => {
  const response = await fetch(new URL("/api/registered/parent", apiBase), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: apiBase }),
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  if (response.status !== 400 || !text.includes("Cannot register this CodexHub server to itself.")) {
    throw new Error(`self registration was not rejected: HTTP ${response.status}: ${text}`);
  }
  console.log("registered server self-registration rejection ok");
};

const runRegisteredScenario = async (input: {
  label: string;
  apiBase: string;
  machineId: string;
  machineName: string;
  projectDir: string;
  child: ChildProcess & { output: () => string };
}) => {
  const { label, apiBase, machineId, machineName, projectDir, child } = input;
  try {
    const machine = await waitForRegisteredMachine(apiBase, machineId, machineName, child);
    console.log(`${label} ok: ${machine.machineId}`);

    const open = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: machine.machineId, path: projectDir })
    }, 120_000);
    assertNoWorkerId(open, "/api/projects/open");
    const sessionId = open.result?.sessionId;
    const threadId = open.result?.threadId;
    if (!sessionId || !threadId) throw new Error(`project thread start did not return session/thread: ${JSON.stringify(open)}`);
    if (open.result?.cwd !== projectDir) throw new Error(`registered machine opened unexpected cwd: ${open.result?.cwd}`);
    const session = await waitForSessionOnline(apiBase, sessionId);
    if (!session.appServerUrl?.startsWith("tunnel://")) {
      throw new Error(`registered session did not use app-server tunnel: ${session.appServerUrl ?? ""}`);
    }
    console.log(`${label} project thread ok: ${sessionId} ${threadId}`);

    const turn = await apiJson(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, input: "/status", source: "web" })
    });
    assertNoWorkerId(turn, "/api/sessions/:sessionId/turn");

    const thread = await waitForThreadRecords(apiBase, threadId, 2);
    assertNoWorkerId(thread, "/api/threads/:threadId");
    console.log(`${label} thread flow ok`);

    await stopChild(child);
    await waitForMachineUnregistered(apiBase, machine.machineId);
    await waitForSessionStopped(apiBase, sessionId);
    await waitForNoCodexAppServerForCwd(projectDir);
    console.log(`${label} lifecycle ok`);
  } catch (error) {
    const output = child.output();
    if (output.trim()) console.error(`${label} output:\n${output}`);
    throw error;
  } finally {
    await stopChild(child).catch(() => undefined);
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

const startRegisteredServer = async (apiBase: string, machineId: string, machineName: string, dataDir: string) => {
  const port = await findFreePort();
  let output = "";
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli/codexhub.ts",
    "server",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--register-to",
    apiBase,
    "--register-machine-id",
    machineId,
    "--register-name",
    machineName
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HUB_DATA_DIR: dataDir,
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

const startDynamicRegisteredServer = async (dataDir: string) => {
  const port = await findFreePort();
  let output = "";
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli/codexhub.ts",
    "server",
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HUB_DATA_DIR: dataDir,
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
  return Object.assign(child, {
    apiBase: `http://127.0.0.1:${port}`,
    output: () => output
  });
};

const waitForChildServer = async (apiBase: string, child: ChildProcess & { output: () => string }) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child server exited early: code=${child.exitCode} signal=${child.signalCode}\n${child.output()}`);
    }
    const health = await fetch(new URL("/api/health", apiBase), { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (health?.ok) return;
    await delay(250);
  }
  throw new Error(`child server did not become healthy: ${apiBase}\n${child.output()}`);
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
