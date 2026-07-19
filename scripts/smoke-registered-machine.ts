import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, readlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { startCodexhubMachine } from "../src/cli/codexhubMachine.js";
import type { MachineRegistrationProject } from "../src/shared/machineTypes.js";
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
  const commandSecondaryProjectDir = path.join(root, "project-machine-command-secondary");
  const serverProjectDir = path.join(root, "project-server-register");
  const dynamicProjectDir = path.join(root, "project-dynamic-server-register");
  const childServerDataDir = path.join(root, "child-server-state");
  const dynamicServerDataDir = path.join(root, "dynamic-server-state");
  const sharedProfileDataDir = path.join(root, "shared-vscode-profile-state");
  await mkdir(dataDir, { recursive: true });
  await mkdir(commandProjectDir, { recursive: true });
  await mkdir(commandSecondaryProjectDir, { recursive: true });
  await mkdir(serverProjectDir, { recursive: true });
  await mkdir(dynamicProjectDir, { recursive: true });
  await mkdir(childServerDataDir, { recursive: true });
  await mkdir(dynamicServerDataDir, { recursive: true });
  await mkdir(sharedProfileDataDir, { recursive: true });

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_LOCAL_MACHINE = "0";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "0";
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.CODEX_HUB_AUTH_TOKEN = "";
  process.env.CODEX_HUB_REGISTER_AUTH_TOKEN = "";

  const port = await findFreePort();
  const { startServer } = await import("../src/server/index.js");
  let server = await startServer({ host: "127.0.0.1", port });
  const apiBase = `http://127.0.0.1:${port}`;

  try {
    await assertRegisteredProjectCatalogRefresh(apiBase, root);

    const commandMachineId = `registered-machine-smoke-${process.pid}`;
    const commandMachineName = "Registered Machine Command Smoke";
    await runRegisteredParentRestartScenario({
      label: "registered machine parent restart",
      apiBase,
      machineId: commandMachineId,
      machineName: commandMachineName,
      projectDir: commandProjectDir,
      secondaryProjectDir: commandSecondaryProjectDir,
      child: startRegisteredMachine(apiBase, commandMachineId, commandMachineName),
      restartParent: async () => {
        await server.stop();
        server = await startServer({ host: "127.0.0.1", port });
      }
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
    let dynamicChild = await startDynamicRegisteredServer(dynamicServerDataDir);
    try {
      await waitForChildServer(dynamicChild.apiBase, dynamicChild);
      await assertSelfRegistrationRejected(dynamicChild.apiBase);
      await connectDynamicParent(dynamicChild.apiBase, apiBase, dynamicMachineId, dynamicMachineName);
      await waitForRegisteredMachine(apiBase, dynamicMachineId, dynamicMachineName, dynamicChild);
      await stopChild(dynamicChild);
      await waitForRegisteredMachineRemoved(apiBase, dynamicMachineId);
      await assertPersistedParentRegistration(dynamicServerDataDir, apiBase, dynamicMachineId, dynamicMachineName, true);

      dynamicChild = await startDynamicRegisteredServer(dynamicServerDataDir);
      await waitForChildServer(dynamicChild.apiBase, dynamicChild);
      await waitForRegisteredMachine(apiBase, dynamicMachineId, dynamicMachineName, dynamicChild);
      await waitForParentRegistrationOnline(dynamicChild.apiBase);
      console.log("registered server persisted startup reconnect ok");

      const disconnected = await apiJson<{ registration?: { status?: string } }>(dynamicChild.apiBase, "/api/registered/parent", {
        method: "DELETE"
      });
      if (disconnected.registration?.status !== "idle") {
        throw new Error(`dynamic server disconnect did not return idle: ${JSON.stringify(disconnected)}`);
      }
      await waitForRegisteredMachineRemoved(apiBase, dynamicMachineId);
      await stopChild(dynamicChild);
      await assertPersistedParentRegistration(dynamicServerDataDir, apiBase, dynamicMachineId, dynamicMachineName, false);

      dynamicChild = await startDynamicRegisteredServer(dynamicServerDataDir);
      await waitForChildServer(dynamicChild.apiBase, dynamicChild);
      await assertParentRegistrationIdle(dynamicChild.apiBase);
      await assertMachineStaysOffline(apiBase, dynamicMachineId);
      console.log("registered server disconnect persistence clear ok");

      await connectDynamicParent(dynamicChild.apiBase, apiBase, dynamicMachineId, dynamicMachineName);
      await runRegisteredScenario({
        label: "registered server dynamic",
        apiBase,
        machineId: dynamicMachineId,
        machineName: dynamicMachineName,
        projectDir: dynamicProjectDir,
        child: dynamicChild
      });
    } finally {
      await stopChild(dynamicChild).catch(() => undefined);
    }

    const sharedMachineA = `registered-vscode-workspace-a-${process.pid}`;
    const sharedMachineB = `registered-vscode-workspace-b-${process.pid}`;
    const sharedMachineAName = "VSCode Workspace A";
    const sharedMachineBName = "VSCode Workspace B";
    const seedPort = await findFreePort();
    const seed = await startServer({
      host: "127.0.0.1",
      port: seedPort,
      dataDir: sharedProfileDataDir,
      surface: "vscode",
      parentRegistrationIdentity: { machineId: sharedMachineA, name: sharedMachineAName },
      features: { localMachine: false, ssh: false, tasks: false, integrations: false }
    });
    try {
      await apiJson(`http://127.0.0.1:${seedPort}`, "/api/registered/parent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: apiBase, authToken: "" })
      });
      await waitForOnlineMachine(apiBase, sharedMachineA, sharedMachineAName);
    } finally {
      await seed.stop();
    }
    await waitForRegisteredMachineRemoved(apiBase, sharedMachineA);
    await assertSharedParentProfile(sharedProfileDataDir, apiBase);

    const sharedPortA = await findFreePort();
    const sharedPortB = await findFreePort();
    const sharedA = await startServer({
      host: "127.0.0.1",
      port: sharedPortA,
      dataDir: sharedProfileDataDir,
      surface: "vscode",
      parentRegistrationIdentity: { machineId: sharedMachineA, name: sharedMachineAName },
      features: { localMachine: false, ssh: false, tasks: false, integrations: false }
    });
    const sharedB = await startServer({
      host: "127.0.0.1",
      port: sharedPortB,
      dataDir: sharedProfileDataDir,
      surface: "vscode",
      parentRegistrationIdentity: { machineId: sharedMachineB, name: sharedMachineBName },
      features: { localMachine: false, ssh: false, tasks: false, integrations: false }
    });
    try {
      await Promise.all([
        waitForOnlineMachine(apiBase, sharedMachineA, sharedMachineAName),
        waitForOnlineMachine(apiBase, sharedMachineB, sharedMachineBName)
      ]);
      console.log("registered server shared profile distinct workspace identities ok");
    } finally {
      await Promise.all([sharedA.stop(), sharedB.stop()]);
    }
    await Promise.all([
      waitForRegisteredMachineRemoved(apiBase, sharedMachineA),
      waitForRegisteredMachineRemoved(apiBase, sharedMachineB)
    ]);
  } finally {
    await server.stop();
  }
  await assertParentDidNotPersistRegisteredMachines(dataDir);
};

const assertRegisteredProjectCatalogRefresh = async (apiBase: string, root: string) => {
  const machineId = `registered-project-catalog-smoke-${process.pid}`;
  const machineName = "Registered Project Catalog Smoke";
  const projectA = path.join(root, "catalog-workspace-a");
  const projectB = path.join(root, "catalog-workspace-b");
  await Promise.all([mkdir(projectA, { recursive: true }), mkdir(projectB, { recursive: true })]);
  let projects: MachineRegistrationProject[] = [];
  const runner = startCodexhubMachine({
    apiBase,
    machineId,
    name: machineName,
    capabilities: { projectCatalog: "fixed" },
    projects: () => projects
  });
  try {
    await waitForOnlineMachine(apiBase, machineId, machineName);
    projects = [
      { path: projectA, source: { kind: "vscode", groupId: "workspace-a", label: "VSCode: A" } },
      { path: projectB, source: { kind: "vscode", groupId: "workspace-b", label: "VSCode: B" } }
    ];
    runner.refreshRegistration();
    await waitForRegisteredProjectPaths(apiBase, machineId, [projectA, projectB]);

    projects = [projects[1]!];
    runner.refreshRegistration();
    await waitForRegisteredProjectPaths(apiBase, machineId, [projectB]);
    console.log("registered machine heartbeat project catalog refresh ok");
  } finally {
    await runner.stop();
  }
  await waitForRegisteredMachineRemoved(apiBase, machineId);
  await waitForRegisteredProjectPaths(apiBase, machineId, []);
};

const waitForRegisteredProjectPaths = async (apiBase: string, machineId: string, expectedPaths: string[]) => {
  const expected = [...expectedPaths].sort();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const data = await apiJson<{ projects?: Array<{ machineId?: string; path?: string }> }>(apiBase, "/api/projects")
      .catch(() => ({ projects: [] }));
    const actual = (data.projects ?? [])
      .filter((project) => project.machineId === machineId)
      .map((project) => project.path ?? "")
      .sort();
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await delay(50);
  }
  throw new Error(`registered project catalog did not refresh for ${machineId}: ${expected.join(", ")}`);
};

const assertSharedParentProfile = async (dataDir: string, apiBase: string) => {
  const raw = await readFile(path.join(dataDir, "config.yaml"), "utf8");
  const parsed = YAML.parse(raw) as { parentRegistration?: Record<string, unknown> };
  const registration = parsed.parentRegistration;
  if (
    registration?.url !== apiBase
    || "authToken" in registration
    || "machineId" in registration
    || "name" in registration
  ) {
    throw new Error(`shared parent profile persisted runtime identity or empty token: ${raw}`);
  }
};

const assertParentDidNotPersistRegisteredMachines = async (dataDir: string) => {
  const raw = await readFile(path.join(dataDir, "config.yaml"), "utf8");
  const parsed = YAML.parse(raw) as { machines?: Array<{ machineId?: string; type?: string }> };
  const registered = (parsed.machines ?? []).filter((machine) => machine.type === "registered");
  if (registered.length) {
    throw new Error(`parent server persisted dynamic registered machines: ${JSON.stringify(registered)}\n${raw}`);
  }
  console.log("parent server registered machines stayed runtime-only ok");
};

const waitForOnlineMachine = async (apiBase: string, machineId: string, machineName: string) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) =>
      item.machineId === machineId
      && item.name === machineName
      && item.online
    );
    if (machine) return machine;
    await delay(250);
  }
  throw new Error(`registered machine did not become online: ${machineId}`);
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

const connectDynamicParent = async (childApiBase: string, parentApiBase: string, machineId: string, name: string) => {
  const parentUrl = new URL(parentApiBase);
  parentUrl.username = "dynamic-smoke-user";
  parentUrl.password = "dynamic-smoke-password";
  parentUrl.searchParams.set("codexhub_token", "dynamic-smoke-token");
  const parentRegistration = await apiJson<{ registration?: { status?: string } }>(childApiBase, "/api/registered/parent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: parentUrl.toString(),
      machineId,
      name
    })
  });
  const publicPayload = JSON.stringify(parentRegistration);
  if (
    publicPayload.includes("dynamic-smoke-user")
    || publicPayload.includes("dynamic-smoke-password")
    || publicPayload.includes("dynamic-smoke-token")
  ) {
    throw new Error(`dynamic server registration exposed URL credentials: ${publicPayload}`);
  }
  if (!parentRegistration.registration || parentRegistration.registration.status === "idle") {
    throw new Error(`dynamic server registration did not start: ${JSON.stringify(parentRegistration)}`);
  }
};

const assertPersistedParentRegistration = async (
  dataDir: string,
  apiBase: string,
  machineId: string,
  name: string,
  expected: boolean
) => {
  const configPath = path.join(dataDir, "config.yaml");
  const raw = await readFile(configPath, "utf8");
  const parsed = YAML.parse(raw) as { parentRegistration?: Record<string, unknown> };
  if (!expected) {
    if (parsed.parentRegistration) throw new Error(`parent registration was not cleared: ${raw}`);
    return;
  }
  const registration = parsed.parentRegistration;
  if (
    registration?.url !== apiBase
    || registration.machineId !== machineId
    || registration.name !== name
    || registration.authToken !== "dynamic-smoke-token"
  ) {
    throw new Error(`parent registration was not persisted: ${raw}`);
  }
  const mode = (await stat(configPath)).mode & 0o777;
  if (mode !== 0o600) throw new Error(`config with parent auth token is not mode 0600: ${mode.toString(8)}`);
};

const waitForParentRegistrationOnline = async (apiBase: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const data = await apiJson<{ registration?: { status?: string; url?: string } }>(apiBase, "/api/registered/parent");
    if (data.registration?.status === "online") return data.registration;
    await delay(250);
  }
  throw new Error("persisted parent registration did not become online");
};

const assertParentRegistrationIdle = async (apiBase: string) => {
  const data = await apiJson<{ registration?: { status?: string } }>(apiBase, "/api/registered/parent");
  if (data.registration?.status !== "idle") {
    throw new Error(`cleared parent registration restarted unexpectedly: ${JSON.stringify(data)}`);
  }
};

const assertMachineStaysOffline = async (apiBase: string, machineId: string) => {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines");
    if (data.machines?.find((machine) => machine.machineId === machineId)?.online) {
      throw new Error(`cleared parent registration reconnected unexpectedly: ${machineId}`);
    }
    await delay(250);
  }
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

    const turn = await apiJson(apiBase, `/api/threads/${encodeURIComponent(threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "/status", source: "web" })
    });
    assertNoWorkerId(turn, "/api/threads/:threadId/turn");

    const thread = await waitForThreadRecords(apiBase, threadId, 2);
    assertNoWorkerId(thread, "/api/threads/:threadId");
    console.log(`${label} thread flow ok`);

    await stopChild(child);
    await waitForRegisteredMachineRemoved(apiBase, machine.machineId);
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

const runRegisteredParentRestartScenario = async (input: {
  label: string;
  apiBase: string;
  machineId: string;
  machineName: string;
  projectDir: string;
  secondaryProjectDir: string;
  child: ChildProcess & { output: () => string };
  restartParent: () => Promise<void>;
}) => {
  const { label, apiBase, machineId, machineName, projectDir, secondaryProjectDir, child, restartParent } = input;
  let sessionId = "";
  try {
    await waitForRegisteredMachine(apiBase, machineId, machineName, child);
    const firstOpen = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, path: projectDir })
    }, 120_000);
    sessionId = firstOpen.result?.sessionId ?? "";
    const initialThreadId = firstOpen.result?.threadId ?? "";
    if (!sessionId || !initialThreadId) {
      throw new Error(`initial project open did not return session/thread: ${JSON.stringify(firstOpen)}`);
    }
    const firstSecondaryOpen = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, path: secondaryProjectDir })
    }, 120_000);
    const initialSecondaryThreadId = firstSecondaryOpen.result?.threadId ?? "";
    if (firstSecondaryOpen.result?.sessionId !== sessionId || !initialSecondaryThreadId || initialSecondaryThreadId === initialThreadId) {
      throw new Error(`initial secondary project open did not share runtime with a distinct thread: ${JSON.stringify(firstSecondaryOpen)}`);
    }
    const initialSession = await waitForSessionOnline(apiBase, sessionId);
    if (!initialSession.appServerUrl?.startsWith("tunnel://")) {
      throw new Error(`initial registered session did not use app-server tunnel: ${initialSession.appServerUrl ?? ""}`);
    }

    await restartParent();
    await waitForRegisteredMachine(apiBase, machineId, machineName, child);
    const reattachedSession = await waitForSessionOnline(apiBase, sessionId);
    if (!reattachedSession.appServerUrl?.startsWith("tunnel://")) {
      throw new Error(`reattached registered session did not use app-server tunnel: ${reattachedSession.appServerUrl ?? ""}`);
    }

    const reopened = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, path: projectDir })
    }, 120_000);
    const threadId = reopened.result?.threadId ?? "";
    if (reopened.result?.sessionId !== sessionId || !threadId) {
      throw new Error(`parent restart did not reuse registered runtime: ${JSON.stringify(reopened)}`);
    }
    if (threadId === initialThreadId) {
      throw new Error(`parent restart unexpectedly restored the previous thread: ${threadId}`);
    }
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "/status", source: "web" })
    });
    await waitForThreadRecords(apiBase, threadId, 2);

    const reopenedSecondary = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, path: secondaryProjectDir })
    }, 120_000);
    const secondaryThreadId = reopenedSecondary.result?.threadId ?? "";
    if (reopenedSecondary.result?.sessionId !== sessionId || !secondaryThreadId) {
      throw new Error(`secondary project did not reuse registered runtime after parent restart: ${JSON.stringify(reopenedSecondary)}`);
    }
    if (secondaryThreadId === initialSecondaryThreadId || secondaryThreadId === threadId) {
      throw new Error(`secondary project did not create its own new thread after parent restart: ${secondaryThreadId}`);
    }

    await restartParent();
    await waitForRegisteredMachine(apiBase, machineId, machineName, child);
    await waitForSessionOnline(apiBase, sessionId);
    const resumed = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, path: projectDir })
    }, 120_000);
    const resumedThreadId = resumed.result?.threadId ?? "";
    if (resumed.result?.sessionId !== sessionId || !resumedThreadId) {
      throw new Error(`second parent restart did not reuse registered runtime: ${JSON.stringify(resumed)}`);
    }
    if (resumedThreadId === threadId) {
      throw new Error(`second parent restart unexpectedly restored the previous thread: ${threadId}`);
    }
    console.log(`${label} reattach ok: ${sessionId} ${initialThreadId} -> ${threadId} -> ${resumedThreadId}`);

    await stopChild(child);
    await waitForRegisteredMachineRemoved(apiBase, machineId);
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

const waitForRegisteredMachineRemoved = async (apiBase: string, machineId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) => item.machineId === machineId);
    if (!machine) return;
    await delay(250);
  }
  throw new Error(`registered machine did not disappear after disconnect: ${machineId}`);
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
