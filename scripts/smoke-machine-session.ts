import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { CodexRecord } from "../src/core/codexRecord.js";

type MachineSummary = {
  machineId: string;
  type?: string;
  online?: boolean;
  capabilities?: {
    projectLauncher?: boolean;
  };
};

type ProjectOpenResponse = {
  project?: {
    projectId?: string;
  };
  result?: {
    sessionId?: string;
    threadId?: string;
    cwd?: string;
  };
};

type ProjectsPayload = {
  projects?: unknown[];
};

type ThreadDetail = {
  threadId: string;
  records?: unknown[];
};

type RealtimeMessage = {
  type?: string;
  kind?: string;
  threadId?: string;
  thread?: {
    threadId?: string;
  };
};

type LocalTask = {
  taskId: string;
  name: string;
  enabled: boolean;
  schedule: string;
  machineId: string;
  projectPath: string;
  threadId?: string;
  input: string;
  lastStatus?: "queued" | "completed" | "failed" | "skipped";
};

type SshHost = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  proxyJump?: string;
};

type SshConnection = {
  connectionId: string;
  host: string;
  status: "starting" | "running" | "exited";
  remotePort: number;
  localHost: string;
  localPort: number;
  remoteMode?: "bootstrap" | "installed" | "custom";
  remoteClientHash?: string;
};

type TaskResponse = {
  task?: LocalTask;
};

type TaskRunResponse = TaskResponse & {
  sessionId?: string;
  threadId?: string;
  command?: string;
};

const main = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state."));
  const pluginDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-plugins."));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-project."));
  const secondProjectDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-project-shared."));
  const sshDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-ssh."));
  const fakeSshDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-bin."));
  const fakeSshArgsPath = path.join(fakeSshDir, "ssh-args.txt");
  await writeExternalPlugin(pluginDir);
  const sshConfigPath = await writeSshConfigFixture(sshDir);
  const remoteClient = await writeRemoteClientFixture(sshDir);
  await writeFakeSsh(fakeSshDir);

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_PLUGIN_DIR = pluginDir;
  process.env.CODEX_HUB_SSH_CONFIG = sshConfigPath;
  process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH = remoteClient.path;
  process.env.CODEXHUB_FAKE_SSH_ARGS_FILE = fakeSshArgsPath;
  process.env.PATH = `${fakeSshDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_HUB_LOCAL_MACHINE = "1";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "1";
  process.env.TELEGRAM_BOT_TOKEN = "";

  await assertTaskCronSemantics();
  await assertServerStateSnapshotPure();
  await assertServerStateDoesNotPersistThreadHistory();
  await assertTransientProjectsStayInMemory();
  await assertProjectNamesArePathBasenames();
  await assertProjectSessionProjection();
  await assertAppServerTurnLifecycleRecords();
  await assertAppServerTurnSnapshotPreservesAgentMessages();
  await assertAppServerAgentMessageDeltaStreams();
  await assertRollbackPreservesKeptTurnToolRecords();
  await assertForkPreservesKeptTurnToolRecords();
  await assertDeletedProjectSuppressesSessionCapture();
  await writeStartupSshHostState(dataDir, "included-host");

  const port = await findFreePort();
  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({ host: "127.0.0.1", port });
  const apiBase = `http://127.0.0.1:${port}`;

  try {
    const machine = await waitForLocalMachine(apiBase);
    console.log(`machine ok: ${machine.machineId}`);

    await assertSshStartupConnect(apiBase, port, fakeSshArgsPath, sshConfigPath, remoteClient.hash);
    console.log("ssh startup connect ok");

    await assertSshHosts(apiBase);
    console.log("ssh hosts ok");

    await assertSshRemoteClientEndpoint(apiBase, remoteClient);
    console.log("ssh remote client endpoint ok");

    await assertSshConnect(apiBase, port, fakeSshArgsPath, sshConfigPath, remoteClient.hash);
    console.log("ssh connect ok");

    const open = await apiJson<ProjectOpenResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: machine.machineId, path: projectDir })
    });
    assertNoWorkerId(open, "/api/projects/open");
    assertNoCurrentThread(open, "/api/projects/open");
    const sessionId = open.result?.sessionId;
    const threadId = open.result?.threadId;
    const projectId = open.project?.projectId;
    if (!sessionId || !threadId || !projectId) throw new Error("project open did not return project/session/thread ids");
    await assertProjectSession(apiBase, projectId, sessionId);
    console.log(`project ok: ${sessionId} ${threadId}`);
    await assertSessionTurnRequiresThread(apiBase, sessionId);
    console.log("session turn target validation ok");

    await assertWebRealtime(apiBase, threadId, async () => {
      await apiJson(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, input: "/status", source: "web" })
      });
    });
    console.log("web realtime ok");

    const sessions = await apiJson(apiBase, "/api/sessions");
    assertNoWorkerId(sessions, "/api/sessions");
    assertNoCurrentThread(sessions, "/api/sessions");
    const thread = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    assertNoWorkerId(thread, "/api/threads/:threadId");
    if ((thread.records ?? []).length < 2) throw new Error("/status did not write thread records");
    console.log("thread stream ok");

    const task = await createAndRunTask(apiBase, {
      machineId: machine.machineId,
      projectDir,
      sessionId,
      threadId
    });
    assertNoWorkerId(task, "/api/tasks");
    const taskThread = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    if ((taskThread.records ?? []).length < 4) throw new Error("task /status did not append thread records");
    console.log("task ok");

    await assertInvalidTaskSchedule(apiBase, machine.machineId, projectDir);
    console.log("task validation ok");

    const plugins = await apiJson(apiBase, "/api/plugins");
    assertNoWorkerId(plugins, "/api/plugins");
    await assertPluginState(apiBase, plugins);
    console.log("plugins ok");

    const secondOpen = await apiJson<ProjectOpenResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: machine.machineId, path: secondProjectDir })
    });
    const secondProjectId = secondOpen.project?.projectId;
    const secondThreadId = secondOpen.result?.threadId;
    if (secondOpen.result?.sessionId !== sessionId || !secondProjectId || !secondThreadId) {
      throw new Error(`second project did not reuse runtime session: ${JSON.stringify(secondOpen)}`);
    }
    if (secondOpen.result?.cwd !== secondProjectDir) {
      throw new Error(`second project opened unexpected cwd: ${secondOpen.result?.cwd}`);
    }
    if (secondThreadId === threadId) {
      throw new Error("second project reused the first project thread");
    }
    await assertProjectSession(apiBase, secondProjectId, sessionId);
    console.log("shared project session ok");

    await assertProjectDeleteKeepsSharedSession(apiBase, projectId, sessionId);
    console.log("project delete kept shared session ok");

    await assertSessionStaysOnlineAfterWatcherIdle(apiBase, machine.machineId);
    console.log("session stays online after watcher idle ok");

    const legacyError = await sendLegacySessionRegistration(port);
    if (!legacyError.includes("workerId") || !legacyError.includes("unrecognized_keys")) {
      throw new Error(`legacy session registration was not rejected as expected: ${legacyError}`);
    }
    console.log("legacy registration rejected");
  } finally {
    await server.stop();
  }
};

const assertTaskCronSemantics = async () => {
  const { cronMatches, cronMinuteKey, cronMinuteKeyFromIso } = await import("../src/core/taskCron.js");
  const mondayNotFirst = new Date("2026-06-08T09:00:00.000Z");
  const mondayFirst = new Date("2026-06-01T09:00:00.000Z");
  if (!cronMatches("0 9 1 * 1", mondayNotFirst, "UTC")) {
    throw new Error("cron day-of-month/day-of-week should match when day-of-week matches");
  }
  if (!cronMatches("0 9 1 * 2", mondayFirst, "UTC")) {
    throw new Error("cron day-of-month/day-of-week should match when day-of-month matches");
  }
  if (cronMatches("0 9 1 * *", mondayNotFirst, "UTC")) {
    throw new Error("cron day-of-month with wildcard day-of-week matched the wrong date");
  }
  if (!cronMatches("0 9 * * 1", mondayNotFirst, "UTC")) {
    throw new Error("cron day-of-week with wildcard day-of-month did not match");
  }
  if (cronMinuteKeyFromIso(mondayNotFirst.toISOString(), "UTC") !== cronMinuteKey(mondayNotFirst, "UTC")) {
    throw new Error("cron lastRunAt minute key did not match date minute key");
  }
};

const writeFakeSsh = async (root: string) => {
  const filePath = path.join(root, "ssh");
  await writeFile(filePath, [
    "#!/bin/sh",
    "if [ -n \"$CODEXHUB_FAKE_SSH_ARGS_FILE\" ]; then",
    "  : > \"$CODEXHUB_FAKE_SSH_ARGS_FILE\"",
    "  for arg in \"$@\"; do",
    "    printf '%s\\000' \"$arg\" >> \"$CODEXHUB_FAKE_SSH_ARGS_FILE\"",
    "  done",
    "fi",
    "echo 'fake ssh started'",
    "trap 'exit 0' TERM INT",
    "while :; do",
    "  sleep 0.2 &",
    "  wait $!",
    "done",
    ""
  ].join("\n"), "utf8");
  await chmod(filePath, 0o755);
};

const writeSshConfigFixture = async (root: string) => {
  const includeDir = path.join(root, "conf.d");
  await mkdir(includeDir, { recursive: true });
  await writeFile(path.join(root, "config"), [
    "Include conf.d/*.conf",
    "Host direct-host",
    "  HostName 192.0.2.10",
    "  User direct",
    "  Port 2222",
    "Host *",
    "  User ignored",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(includeDir, "remote.conf"), [
    "Host included-host",
    "  HostName included.example.com",
    "  User ubuntu",
    "  ProxyJump jump-host",
    ""
  ].join("\n"), "utf8");
  return path.join(root, "config");
};

const writeRemoteClientFixture = async (root: string) => {
  const filePath = path.join(root, "remote-client.cjs");
  const content = [
    "#!/usr/bin/env node",
    "console.error('codexhub remote client smoke fixture');",
    ""
  ].join("\n");
  await writeFile(filePath, content, "utf8");
  return {
    path: filePath,
    hash: createHash("sha256").update(content).digest("hex")
  };
};

const writeStartupSshHostState = async (dataDir: string, alias: string) => {
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  state.upsertSshHost({ alias });
  await state.flush();
};

const assertSshHosts = async (apiBase: string) => {
  const configData = await apiJson<{ hosts?: SshHost[] }>(apiBase, "/api/ssh/config-hosts");
  assertNoWorkerId(configData, "/api/ssh/config-hosts");
  const configHosts = configData.hosts ?? [];
  const direct = configHosts.find((host) => host.alias === "direct-host");
  if (!direct || direct.hostName !== "192.0.2.10" || direct.user !== "direct" || direct.port !== 2222) {
    throw new Error(`direct ssh host fixture was not parsed: ${JSON.stringify(direct)}`);
  }
  const included = configHosts.find((host) => host.alias === "included-host");
  if (!included || included.hostName !== "included.example.com" || included.user !== "ubuntu" || included.proxyJump !== "jump-host") {
    throw new Error(`included ssh host fixture was not parsed: ${JSON.stringify(included)}`);
  }
  if (configHosts.some((host) => host.alias === "*")) throw new Error("wildcard ssh host was exposed");

  const savedData = await apiJson<{ hosts?: SshHost[] }>(apiBase, "/api/ssh/hosts");
  assertNoWorkerId(savedData, "/api/ssh/hosts");
  const existing = savedData.hosts?.find((host) => host.alias === "included-host");
  if (!existing || existing.hostName !== "included.example.com" || existing.user !== "ubuntu") {
    throw new Error(`codexhub ssh hosts did not load saved alias from state: ${JSON.stringify(savedData.hosts)}`);
  }

  const added = await apiJson<{ hosts?: SshHost[] }>(apiBase, "/api/ssh/hosts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias: "included-host" })
  });
  assertNoWorkerId(added, "POST /api/ssh/hosts");
  const saved = added.hosts?.find((host) => host.alias === "included-host");
  if (!saved || saved.hostName !== "included.example.com" || saved.user !== "ubuntu") {
    throw new Error(`codexhub ssh host was not stored as an alias backed by ssh config: ${JSON.stringify(saved)}`);
  }
};

const assertSshConnect = async (
  apiBase: string,
  serverPort: number,
  argsPath: string,
  sshConfigPath: string,
  remoteClientHash: string
) => {
  const remotePort = 19001;
  const started = await apiJson<{ connection?: SshConnection }>(apiBase, "/api/ssh/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      host: "included-host",
      name: "Included Host",
      remotePort
    })
  });
  assertNoWorkerId(started, "POST /api/ssh/connect");
  const connection = started.connection;
  if (!connection?.connectionId || connection.host !== "included-host" || connection.remotePort !== remotePort) {
    throw new Error(`ssh connect did not return expected connection: ${JSON.stringify(connection)}`);
  }
  if (connection.remoteMode !== "bootstrap" || connection.remoteClientHash !== remoteClientHash) {
    throw new Error(`ssh connect did not use bootstrap remote client: ${JSON.stringify(connection)}`);
  }

  const args = await waitForFakeSshArgs(argsPath);
  const configIndex = args.indexOf("-F");
  if (configIndex < 0 || args[configIndex + 1] !== sshConfigPath) {
    throw new Error(`fake ssh args did not include configured ssh config: ${JSON.stringify(args)}`);
  }
  const reverseIndex = args.indexOf("-R");
  if (reverseIndex < 0) throw new Error(`fake ssh args did not include -R: ${JSON.stringify(args)}`);
  const expectedReverse = `127.0.0.1:${remotePort}:127.0.0.1:${serverPort}`;
  if (args[reverseIndex + 1] !== expectedReverse) {
    throw new Error(`unexpected ssh reverse tunnel: ${args[reverseIndex + 1]} expected ${expectedReverse}`);
  }
  if (!args.includes("ExitOnForwardFailure=yes")) throw new Error("ssh args missing ExitOnForwardFailure=yes");
  if (!args.includes("included-host")) throw new Error(`ssh args missing target host: ${JSON.stringify(args)}`);
  const remoteCommand = args.at(-1) ?? "";
  if (remoteCommand.includes("codexhub machine")
    || !remoteCommand.includes("sh -lc")
    || !remoteCommand.includes(`/api/ssh/remote-client/${remoteClientHash}`)
    || !remoteCommand.includes("CODEXHUB_REMOTE_CLIENT_HASH")
    || !remoteCommand.includes("export CODEXHUB_REMOTE_CLIENT_HASH CODEXHUB_REMOTE_CLIENT_URL")
    || !remoteCommand.includes("node \"$client\"")
    || !remoteCommand.includes("http://127.0.0.1:19001")
    || !remoteCommand.includes("--type ssh")
    || !remoteCommand.includes("Included Host")) {
    throw new Error(`unexpected ssh remote command: ${remoteCommand}`);
  }

  const listed = await apiJson<{ connections?: SshConnection[] }>(apiBase, "/api/ssh/connections");
  assertNoWorkerId(listed, "GET /api/ssh/connections");
  const listedConnection = listed.connections?.find((item) => item.connectionId === connection.connectionId);
  if (!listedConnection || listedConnection.status === "exited") {
    throw new Error(`ssh connection was not listed as active: ${JSON.stringify(listedConnection)}`);
  }

  const stopped = await apiJson<{ connection?: SshConnection }>(
    apiBase,
    `/api/ssh/connections/${encodeURIComponent(connection.connectionId)}`,
    { method: "DELETE" }
  );
  if (stopped.connection?.status !== "exited") {
    throw new Error(`ssh connection did not stop: ${JSON.stringify(stopped.connection)}`);
  }
};

const assertSshStartupConnect = async (
  apiBase: string,
  serverPort: number,
  argsPath: string,
  sshConfigPath: string,
  remoteClientHash: string
) => {
  const connection = await waitForSshConnection(apiBase, "included-host");
  if (connection.remoteMode !== "bootstrap" || connection.remoteClientHash !== remoteClientHash) {
    throw new Error(`startup ssh connection did not use bootstrap remote client: ${JSON.stringify(connection)}`);
  }
  const args = await waitForFakeSshArgs(argsPath);
  const configIndex = args.indexOf("-F");
  if (configIndex < 0 || args[configIndex + 1] !== sshConfigPath) {
    throw new Error(`startup fake ssh args did not include configured ssh config: ${JSON.stringify(args)}`);
  }
  const reverseIndex = args.indexOf("-R");
  if (reverseIndex < 0) throw new Error(`startup fake ssh args did not include -R: ${JSON.stringify(args)}`);
  const reverse = args[reverseIndex + 1];
  if (!reverse.startsWith("127.0.0.1:") || !reverse.endsWith(`:127.0.0.1:${serverPort}`)) {
    throw new Error(`startup ssh reverse tunnel did not target server port ${serverPort}: ${reverse}`);
  }
  const remoteCommand = args.at(-1) ?? "";
  if (!remoteCommand.includes(`/api/ssh/remote-client/${remoteClientHash}`) || !remoteCommand.includes("--type ssh")) {
    throw new Error(`startup ssh remote command did not use remote client: ${remoteCommand}`);
  }
  await apiJson(apiBase, `/api/ssh/connections/${encodeURIComponent(connection.connectionId)}`, { method: "DELETE" });
  await writeFile(argsPath, "", "utf8");
};

const assertSshRemoteClientEndpoint = async (
  apiBase: string,
  remoteClient: { path: string; hash: string }
) => {
  const response = await fetch(new URL(`/api/ssh/remote-client/${remoteClient.hash}`, apiBase));
  const text = await response.text();
  if (!response.ok) throw new Error(`remote client endpoint returned HTTP ${response.status}: ${text}`);
  const expected = await readFile(remoteClient.path, "utf8");
  if (text !== expected) throw new Error("remote client endpoint returned unexpected content");
  if (response.headers.get("x-codexhub-remote-client-sha256") !== remoteClient.hash) {
    throw new Error("remote client endpoint returned unexpected checksum header");
  }
};

const waitForFakeSshArgs = async (argsPath: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const text = await readFile(argsPath, "utf8").catch(() => "");
    const args = text.split("\0").filter(Boolean);
    if (args.length) return args;
    await delay(50);
  }
  throw new Error("fake ssh did not receive arguments");
};

const waitForSshConnection = async (apiBase: string, host: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const listed = await apiJson<{ connections?: SshConnection[] }>(apiBase, "/api/ssh/connections").catch(() => ({ connections: [] }));
    const connection = listed.connections?.find((item) => item.host === host && item.status !== "exited");
    if (connection) return connection;
    await delay(50);
  }
  throw new Error(`SSH host did not autoconnect: ${host}`);
};

const assertWebRealtime = async (apiBase: string, threadId: string, trigger: () => Promise<void>) => {
  const messages: RealtimeMessage[] = [];
  const ws = new WebSocket(webRealtimeUrl(apiBase));
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as RealtimeMessage);
  });

  try {
    await waitForWebSocketOpen(ws, "web realtime websocket failed");
    ws.send(JSON.stringify({ type: "hello", sessionsAfter: 0, projectsAfter: 0, tasksAfter: 0, connectionsAfter: 0 }));
    await waitForRealtimeMessage(messages, (message) => message.type === "ready", "web realtime ready");

    ws.send(JSON.stringify({ type: "subscribe_thread", threadId, after: 0 }));
    await waitForRealtimeMessage(
      messages,
      (message) => message.type === "thread_subscribed" && message.threadId === threadId,
      "web realtime thread subscription"
    );

    const startIndex = messages.length;
    await trigger();
    await waitForRealtimeMessage(
      messages,
      (message) => (message.type ?? message.kind) === "record" && message.thread?.threadId === threadId,
      "web realtime thread record",
      startIndex
    );
    const controlSnapshot = messages
      .slice(startIndex)
      .find((message) => message.type === "sessions" || message.type === "projects");
    if (controlSnapshot) {
      throw new Error(`thread realtime emitted ${controlSnapshot.type} snapshot after record trigger`);
    }
  } finally {
    await closeWebSocket(ws);
  }
};

const waitForRealtimeMessage = async (
  messages: RealtimeMessage[],
  predicate: (message: RealtimeMessage) => boolean,
  label: string,
  startIndex = 0,
  timeoutMs = 3_000
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = messages.slice(startIndex).find(predicate);
    if (found) return found;
    await delay(50);
  }
  throw new Error(`${label} did not arrive: ${JSON.stringify(messages.slice(startIndex))}`);
};

const createAndRunTask = async (
  apiBase: string,
  input: { machineId: string; projectDir: string; sessionId: string; threadId: string }
) => {
  const created = await apiJson<TaskResponse>(apiBase, "/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Smoke status",
      enabled: false,
      schedule: "* * * * *",
      machineId: input.machineId,
      projectPath: input.projectDir,
      threadId: input.threadId,
      input: "/status"
    })
  });
  assertNoWorkerId(created, "POST /api/tasks");
  const taskId = created.task?.taskId;
  if (!taskId) throw new Error("task create did not return taskId");

  const run = await apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, {
    method: "POST"
  });
  assertNoWorkerId(run, "POST /api/tasks/:taskId/run");
  if (run.sessionId !== input.sessionId || run.threadId !== input.threadId) {
    throw new Error("task run did not target the expected session/thread");
  }
  if (run.command !== "status") throw new Error("task /status was not handled as a local command");
  if (run.task?.lastStatus !== "completed") throw new Error("task run did not complete");

  const listed = await apiJson<{ tasks?: LocalTask[] }>(apiBase, "/api/tasks");
  assertNoWorkerId(listed, "GET /api/tasks");
  const stored = listed.tasks?.find((task) => task.taskId === taskId);
  if (!stored || stored.lastStatus !== "completed" || stored.threadId !== input.threadId) {
    throw new Error("task state was not persisted after run");
  }
  return run;
};

const assertInvalidTaskSchedule = async (apiBase: string, machineId: string, projectDir: string) => {
  const response = await fetch(new URL("/api/tasks", apiBase), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Invalid schedule",
      enabled: false,
      schedule: "*/0 * * * *",
      machineId,
      projectPath: projectDir,
      input: "/status"
    })
  });
  const text = await response.text();
  if (response.ok) throw new Error("invalid task cron schedule was accepted");
  if (!text.includes("Invalid cron schedule")) {
    throw new Error(`invalid task cron schedule returned unexpected error: HTTP ${response.status} ${text}`);
  }
};

const writeExternalPlugin = async (pluginDir: string) => {
  const root = path.join(pluginDir, "external-channel");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "plugin.yaml"), [
    "version: 1",
    "id: external-channel",
    "name: External Channel",
    "enabled: true",
    "contributes:",
    "  web:",
    "    styles:",
    "      - style.css",
    "  integrations:",
    "    - type: external-channel",
    "      label: External Channel",
    "      requiredEnv:",
    "        - EXTERNAL_CHANNEL_TOKEN",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "style.css"), [
    ":root {",
    "  --codexhub-smoke-plugin: #123456;",
    "}",
    ""
  ].join("\n"), "utf8");
};

const waitForLocalMachine = async (apiBase: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) =>
      item.type === "local" && item.online && item.capabilities?.projectLauncher
    );
    if (machine) return machine;
    await delay(200);
  }
  throw new Error("local machine did not register");
};

const assertServerStateSnapshotPure = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-pure."));
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  state.upsertMachine({
    machineId: "machine-pure-smoke",
    type: "local",
    hostname: "pure-smoke",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    capabilities: { projectLauncher: true }
  });
  state.upsertProject({
    machineId: "machine-pure-smoke",
    path: "/tmp/codexhub-pure-smoke",
    now: "2026-01-01T00:00:00.000Z"
  });
  await state.flush();
  const before = await readFile(state.path, "utf8");
  state.snapshot({
    machines: [{
      machineId: "machine-pure-smoke",
      type: "local",
      hostname: "pure-smoke",
      online: true,
      status: "online",
      lastSeenAt: "2026-01-01T00:10:00.000Z",
      capabilities: { projectLauncher: true }
    }],
    sessions: [],
    threads: []
  });
  await state.flush();
  const after = await readFile(state.path, "utf8");
  if (after !== before) throw new Error("CodexhubServerState.snapshot mutated server-state.yaml");
};

const assertServerStateDoesNotPersistThreadHistory = async () => {
  const legacyDataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-thread-history-legacy."));
  await writeFile(path.join(legacyDataDir, "server-state.yaml"), [
    "version: 1",
    "updatedAt: 2026-01-01T00:00:00.000Z",
    "machines: []",
    "projects: []",
    "threads:",
    "  - threadId: legacy-thread",
    "    projectId: legacy-project",
    "    title: legacy",
    "    updatedAt: 2026-01-01T00:00:00.000Z",
    "    status: idle",
    "    messageCount: 1",
    "deletedProjects: []",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"), "utf8");
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const legacyState = await CodexhubServerState.load({ dataDir: legacyDataDir });
  const migrated = await readFile(legacyState.path, "utf8");
  if (migrated.includes("\nthreads:")) throw new Error(`legacy thread history was not migrated out:\n${migrated}`);

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-thread-history."));
  const state = await CodexhubServerState.load({ dataDir });
  const machineId = "machine-thread-history-smoke";
  const projectPath = "/tmp/codexhub-thread-history-smoke";
  const machine = {
    machineId,
    type: "local" as const,
    hostname: "thread-history-smoke",
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    capabilities: { projectLauncher: true }
  };
  const session = {
    sessionId: "session-thread-history-smoke",
    machineId,
    name: "thread-history-smoke",
    workingDirectory: projectPath,
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:02:00.000Z",
    hostname: "thread-history-smoke",
    threads: []
  };
  const thread = {
    threadId: "thread-history-smoke",
    workingDirectory: projectPath,
    session: {
      sessionId: session.sessionId,
      name: session.name,
      online: true,
      runnable: true,
      lastSeenAt: session.lastSeenAt
    },
    status: "idle" as const,
    running: false,
    title: "external codex thread",
    updatedAt: "2026-01-01T00:03:00.000Z",
    messageCount: 3,
    threadUsage: {
      context: null,
      primaryRateLimit: null,
      secondaryRateLimit: null,
      observedAt: null
    }
  };
  const project = state.upsertProject({ machineId, path: projectPath, now: "2026-01-01T00:00:00.000Z" });
  if (!project) throw new Error("thread history smoke project upsert failed");
  state.captureSessions({ sessions: [session], threads: [thread] });
  const snapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [thread] });
  const projected = snapshot.projects.find((item) => item.projectId === project.projectId);
  if (!projected) throw new Error("thread history smoke project missing from snapshot");
  if (projected.threads.length !== 1) throw new Error("runtime project threads should still be projected");
  if ("storedThreads" in asRecord(projected)) throw new Error("project snapshot exposed persisted thread history");
  await state.flush();
  const saved = await readFile(state.path, "utf8");
  if (saved.includes("\nthreads:")) throw new Error(`server state persisted thread history:\n${saved}`);
};

const assertTransientProjectsStayInMemory = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-transient-project."));
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  const machineId = "machine-transient-project-smoke";
  const transientPath = "/tmp/codexhub-transient-project-smoke";
  const persistedPath = "/tmp/codexhub-persisted-project-smoke";
  const machine = {
    machineId,
    type: "local" as const,
    hostname: "transient-project-smoke",
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    capabilities: { projectLauncher: true }
  };
  state.upsertTransientProject({
    machineId,
    path: transientPath,
    sessionId: "session-transient-project-smoke",
    threadId: "thread-transient-project-smoke",
    source: {
      kind: "vscode",
      groupId: "workspace",
      label: "VSCode: smoke"
    }
  });
  const transientSnapshot = state.snapshot({ machines: [machine], sessions: [], threads: [] });
  const transientProject = transientSnapshot.projects.find((project) => project.path === transientPath);
  if (!transientProject?.transient) throw new Error(`transient project missing from snapshot: ${JSON.stringify(transientSnapshot.projects)}`);
  if (transientProject.source?.kind !== "vscode") throw new Error(`transient project source missing: ${JSON.stringify(transientProject)}`);
  await state.flush();
  const statePath = path.join(dataDir, "server-state.yaml");
  const transientSaved = await readFile(statePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  if (transientSaved.includes(transientPath)) throw new Error(`transient project was persisted:\n${transientSaved}`);

  state.upsertProject({ machineId, path: persistedPath, now: "2026-01-01T00:02:00.000Z" });
  await state.flush();
  const persistedSaved = await readFile(statePath, "utf8");
  if (!persistedSaved.includes(persistedPath)) throw new Error(`persisted project was not saved:\n${persistedSaved}`);
  if (persistedSaved.includes(transientPath)) throw new Error(`transient project leaked into state after persistent save:\n${persistedSaved}`);

  state.upsertTransientProject({
    machineId,
    path: persistedPath,
    sessionId: "session-persisted-vscode-overlay-smoke",
    threadId: "thread-persisted-vscode-overlay-smoke",
    source: {
      kind: "vscode",
      groupId: "workspace",
      label: "VSCode: smoke"
    }
  });
  const overlaySnapshot = state.snapshot({ machines: [machine], sessions: [], threads: [] });
  const overlayProject = overlaySnapshot.projects.find((project) => project.path === persistedPath);
  if (overlayProject?.source?.kind !== "vscode") {
    throw new Error(`persisted project missing VSCode overlay source: ${JSON.stringify(overlayProject)}`);
  }
  if (overlayProject.transient) throw new Error(`persisted project should not become transient: ${JSON.stringify(overlayProject)}`);
  await state.flush();
  const overlaySaved = await readFile(statePath, "utf8");
  if (overlaySaved.includes("VSCode: smoke") || overlaySaved.includes("source:")) {
    throw new Error(`VSCode overlay was persisted:\n${overlaySaved}`);
  }
};

const assertProjectNamesArePathBasenames = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-project-name."));
  const projectPath = "/tmp/codexhub-custom-name-smoke";
  await writeFile(path.join(dataDir, "server-state.yaml"), [
    "version: 1",
    "updatedAt: 2026-01-01T00:00:00.000Z",
    "machines: []",
    "projects:",
    "  - projectId: project-custom-name-smoke",
    "    machineId: machine-custom-name-smoke",
    `    path: ${projectPath}`,
    "    name: Custom Project Label",
    "    createdAt: 2026-01-01T00:00:00.000Z",
    "    lastOpenedAt: 2026-01-01T00:00:00.000Z",
    "deletedProjects: []",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"), "utf8");

  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  const snapshot = state.snapshot({ machines: [], sessions: [], threads: [] });
  const project = snapshot.projects.find((item) => item.projectId === "project-custom-name-smoke");
  if (project?.name !== "codexhub-custom-name-smoke") {
    throw new Error(`project name should be the folder basename: ${JSON.stringify(project)}`);
  }
  const migrated = await readFile(state.path, "utf8");
  if (migrated.includes("Custom Project Label")) {
    throw new Error(`custom project name was not migrated out:\n${migrated}`);
  }
  if (migrated.includes("\n    name:")) {
    throw new Error(`project name should not be persisted separately:\n${migrated}`);
  }
};

const assertProjectSessionProjection = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-session."));
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  const machineId = "machine-session-smoke";
  const projectPath = "/tmp/codexhub-session-smoke";
  const runtimePath = "/tmp/codexhub-runtime-smoke";
  const machine = {
    machineId,
    type: "local" as const,
    hostname: "session-smoke",
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    capabilities: { projectLauncher: true }
  };
  const session = {
    sessionId: "session-projection-smoke",
    machineId,
    name: "session-smoke",
    workingDirectory: runtimePath,
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:02:00.000Z",
    hostname: "session-smoke",
    threads: []
  };

  state.captureSessions({ sessions: [session], threads: [] });
  const missingProjectSnapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [] });
  if (missingProjectSnapshot.projects.length !== 0) {
    throw new Error("session created a project without an explicit project");
  }

  const project = state.upsertProject({
    machineId,
    path: projectPath,
    sessionId: session.sessionId,
    now: "2026-01-01T00:03:00.000Z"
  });
  if (!project) throw new Error("session projection project upsert failed");
  state.captureSessions({ sessions: [session], threads: [] });
  const onlineSnapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [] });
  const onlineProject = onlineSnapshot.projects.find((item) => item.projectId === project.projectId);
  if (!onlineProject?.machineOnline) throw new Error("project session projection did not expose machineOnline");
  if (onlineProject.session?.sessionId !== session.sessionId || onlineProject.session.online !== true) {
    throw new Error(`project session projection did not attach online session: ${JSON.stringify(onlineProject?.session)}`);
  }
  if (onlineProject.session.workingDirectory !== projectPath) {
    throw new Error(`project session projection did not expose project cwd: ${JSON.stringify(onlineProject.session)}`);
  }

  const offlineSession = {
    ...session,
    online: false,
    status: "offline" as const,
    offlineSinceAt: "2026-01-01T00:04:00.000Z",
    offlineReason: "unregistered" as const
  };
  const offlineSnapshot = state.snapshot({ machines: [machine], sessions: [offlineSession], threads: [] });
  const offlineProject = offlineSnapshot.projects.find((item) => item.projectId === project.projectId);
  if (!offlineProject) throw new Error("project disappeared when session went offline");
  if (offlineProject.session !== null) {
    throw new Error(`offline session should not be projected as active session: ${JSON.stringify(offlineProject.session)}`);
  }
};

const assertAppServerTurnLifecycleRecords = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "app-server-lifecycle-session";
  const threadId = "app-server-lifecycle-thread";
  const turnId = "app-server-lifecycle-turn";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-lifecycle"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    heartbeat: false,
    turns: [{
      id: turnId,
      startedAt: 1,
      completedAt: 3.5,
      timeToFirstTokenMs: 750,
      items: [{
        id: "user-1",
        type: "userMessage",
        content: [{ type: "text", text: "hello" }]
      }, {
        id: "agent-1",
        type: "agentMessage",
        text: "done"
      }]
    }]
  });
  const thread = hub.getThread(threadId);
  const records = thread?.records ?? [];
  const started = records.find((record) => asRecord(record).id === `app:${threadId}:${turnId}:event:task_started`);
  const completed = records.find((record) => asRecord(record).id === `app:${threadId}:${turnId}:event:task_complete`);
  const startedPayload = asRecord(asRecord(started).payload);
  const completedPayload = asRecord(asRecord(completed).payload);
  if (!started || startedPayload.type !== "task_started") {
    throw new Error(`app-server turn snapshot did not create task_started: ${JSON.stringify(records)}`);
  }
  if (
    !completed
    || completedPayload.type !== "task_complete"
    || completedPayload.duration_ms !== 2500
    || completedPayload.time_to_first_token_ms !== 750
  ) {
    throw new Error(`app-server turn snapshot did not create task_complete duration: ${JSON.stringify(records)}`);
  }
};

const assertAppServerTurnSnapshotPreservesAgentMessages = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "app-server-order-session";
  const threadId = "app-server-order-thread";
  const turnId = "app-server-order-turn";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-order"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    heartbeat: false,
    message: {
      method: "thread/goal/cleared",
      params: { threadId }
    }
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    heartbeat: false,
    turns: [{
      id: turnId,
      startedAt: 1,
      completedAt: 2,
      items: [{
        id: "user-1",
        type: "userMessage",
        content: [{ type: "text", text: "run" }]
      }, {
        id: "agent-1",
        type: "agentMessage",
        text: "first commentary"
      }, {
        id: "agent-2",
        type: "agentMessage",
        text: "second commentary"
      }, {
        id: "agent-3",
        type: "agentMessage",
        text: "final",
        phase: "final_answer"
      }]
    }]
  });
  const records = hub.getThread(threadId)?.records ?? [];
  const messages = records
    .map((record) => asRecord(asRecord(record).payload))
    .filter((payload) => payload.type === "agent_message")
    .map((payload) => payload.message);
  if (JSON.stringify(messages) !== JSON.stringify(["first commentary", "second commentary", "final"])) {
    throw new Error(`app-server snapshot collapsed or reordered agent messages: ${JSON.stringify(records)}`);
  }
  const goalIndex = records.findIndex((record) => asRecord(asRecord(record).payload).type === "thread_goal_cleared");
  const startedIndex = records.findIndex((record) => asRecord(asRecord(record).payload).type === "task_started");
  if (goalIndex !== records.length - 1 || startedIndex !== 0) {
    throw new Error(`thread records were not timestamp ordered after snapshot: ${JSON.stringify(records)}`);
  }
};

const assertAppServerAgentMessageDeltaStreams = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const { recordsToViews } = await import("../src/core/codexRecordView.js");
  const hub = new ThreadHub();
  const sessionId = "app-server-agent-delta-session";
  const threadId = "app-server-agent-delta-thread";
  const turnId = "app-server-agent-delta-turn";
  const itemId = "agent-delta-1";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-agent-delta"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_execution_changed",
    threadId,
    running: true,
    turnId,
    heartbeat: false
  });
  const events: Array<{ kind: string; record?: unknown }> = [];
  const unsubscribe = hub.subscribe(threadId, 0, (event) => {
    events.push(event);
  });
  try {
    for (const delta of ["你", "好"]) {
      hub.applySessionEvent(sessionId, {
        type: "thread_event",
        threadId,
        heartbeat: false,
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            itemId,
            delta,
            phase: "final_answer"
          }
        }
      });
    }
    const deltaRecord = agentMessageRecord(hub.getThread(threadId)?.records ?? [], itemId);
    const deltaPayload = asRecord(asRecord(deltaRecord).payload);
    if (!deltaRecord || deltaPayload.message !== "你好" || deltaPayload.status !== "in_progress") {
      throw new Error(`agent message delta did not stream into record: ${JSON.stringify(hub.getThread(threadId)?.records)}`);
    }
    const deltaViews = recordsToViews([deltaRecord]);
    if (deltaViews[0]?.canFork) {
      throw new Error(`in-progress final_answer should not be forkable: ${JSON.stringify(deltaViews[0])}`);
    }
    const deltaRecordEvents = events.filter((event) => event.kind === "record" && asRecord(event.record)?.id === deltaRecord.id);
    if (deltaRecordEvents.length < 2) {
      throw new Error(`agent message delta did not publish record updates: ${JSON.stringify(events)}`);
    }

    hub.applySessionEvent(sessionId, {
      type: "thread_event",
      threadId,
      heartbeat: false,
      message: {
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: itemId,
            type: "agentMessage",
            text: "你好。",
            phase: "final_answer"
          }
        }
      }
    });
    const records = hub.getThread(threadId)?.records ?? [];
    const agentRecords = records.filter((record) => asRecord(asRecord(record).payload).type === "agent_message");
    const completedRecord = agentMessageRecord(records, itemId);
    const completedPayload = asRecord(asRecord(completedRecord).payload);
    if (!completedRecord || agentRecords.length !== 1 || completedPayload.message !== "你好。" || completedPayload.status !== "completed") {
      throw new Error(`agent message completion did not replace streamed record: ${JSON.stringify(records)}`);
    }
    const completedViews = recordsToViews([completedRecord]);
    if (!completedViews[0]?.canFork) {
      throw new Error(`completed final_answer should be forkable: ${JSON.stringify(completedViews[0])}`);
    }
  } finally {
    unsubscribe();
  }
};

const agentMessageRecord = (records: unknown[], itemId: string): CodexRecord | undefined => {
  const found = records.find((record) => {
    const item = asRecord(record);
    const payload = asRecord(item.payload);
    return typeof item.id === "string" && item.id.endsWith(`:agent:${itemId}`) && payload.type === "agent_message";
  });
  return found as CodexRecord | undefined;
};

const assertRollbackPreservesKeptTurnToolRecords = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "rollback-tool-session";
  const threadId = "rollback-tool-thread";
  const keptTurnId = "rollback-kept-turn";
  const removedTurnId = "rollback-removed-turn";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-rollback-tool"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    heartbeat: false,
    turns: [{
      id: keptTurnId,
      startedAt: 1,
      completedAt: 2,
      items: [{
        id: "kept-user",
        type: "userMessage",
        content: [{ type: "text", text: "run tool" }]
      }, {
        id: "kept-tool",
        type: "commandExecution",
        command: "pwd",
        status: "completed",
        output: "/tmp/codexhub-rollback-tool",
        exitCode: 0
      }, {
        id: "kept-agent",
        type: "agentMessage",
        text: "kept",
        phase: "final_answer"
      }]
    }, {
      id: removedTurnId,
      startedAt: 3,
      completedAt: 4,
      items: [{
        id: "removed-user",
        type: "userMessage",
        content: [{ type: "text", text: "remove me" }]
      }, {
        id: "removed-agent",
        type: "agentMessage",
        text: "removed",
        phase: "final_answer"
      }]
    }]
  });
  const rollback = hub.rollbackThreadAfterRecord(threadId, `app:${threadId}:${keptTurnId}:agent:kept-agent`);
  const commandBatch = await hub.waitSessionCommands(sessionId, 0, 1);
  const command = commandBatch.commands[0];
  if (!command || command.type !== "rollback_thread" || command.keepTurns !== 1 || command.numTurns !== 1) {
    throw new Error(`rollback command did not preserve expected turn boundary: ${JSON.stringify(command)}`);
  }
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    commandId: command.commandId,
    heartbeat: false,
    message: {
      result: {
        thread: {
          id: threadId,
          cwd: "/tmp/codexhub-rollback-tool",
          turns: [{
            id: keptTurnId,
            startedAt: 1,
            completedAt: 2,
            items: [{
              id: "kept-user",
              type: "userMessage",
              content: [{ type: "text", text: "run tool" }]
            }, {
              id: "kept-agent",
              type: "agentMessage",
              text: "kept",
              phase: "final_answer"
            }]
          }]
        }
      }
    }
  });
  const detail = await rollback;
  const records = detail.records ?? [];
  if (!records.some((record) => asRecord(record).id === `app:${threadId}:${keptTurnId}:item:commandExecution:kept-tool`)) {
    throw new Error(`rollback dropped kept turn tool record: ${JSON.stringify(records)}`);
  }
  if (records.some((record) => String(asRecord(record).id).includes(removedTurnId))) {
    throw new Error(`rollback kept records from removed turn: ${JSON.stringify(records)}`);
  }
};

const assertForkPreservesKeptTurnToolRecords = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "fork-tool-session";
  const sourceThreadId = "fork-source-thread";
  const forkedThreadId = "fork-child-thread";
  const keptTurnId = "fork-kept-turn";
  const removedTurnId = "fork-removed-turn";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-fork-tool"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId: sourceThreadId,
    heartbeat: false,
    turns: [{
      id: keptTurnId,
      startedAt: 1,
      completedAt: 2,
      items: [{
        id: "kept-user",
        type: "userMessage",
        content: [{ type: "text", text: "run fork tool" }]
      }, {
        id: "kept-tool",
        type: "commandExecution",
        command: "pwd",
        status: "completed",
        output: "/tmp/codexhub-fork-tool",
        exitCode: 0
      }, {
        id: "kept-agent",
        type: "agentMessage",
        text: "kept",
        phase: "final_answer"
      }]
    }, {
      id: removedTurnId,
      startedAt: 3,
      completedAt: 4,
      items: [{
        id: "removed-user",
        type: "userMessage",
        content: [{ type: "text", text: "remove me" }]
      }, {
        id: "removed-agent",
        type: "agentMessage",
        text: "removed",
        phase: "final_answer"
      }]
    }]
  });
  const fork = hub.forkThread(sourceThreadId, `app:${sourceThreadId}:${keptTurnId}:agent:kept-agent`);
  const forkBatch = await hub.waitSessionCommands(sessionId, 0, 1);
  const forkCommand = forkBatch.commands[0];
  if (!forkCommand || forkCommand.type !== "fork_thread" || forkCommand.threadId !== sourceThreadId) {
    throw new Error(`fork command did not target source thread: ${JSON.stringify(forkCommand)}`);
  }
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId: forkedThreadId,
    commandId: forkCommand.commandId,
    heartbeat: false,
    message: {
      result: {
        thread: {
          id: forkedThreadId,
          cwd: "/tmp/codexhub-fork-tool",
          turns: [{
            id: keptTurnId,
            startedAt: 1,
            completedAt: 2,
            items: [{
              id: "kept-user",
              type: "userMessage",
              content: [{ type: "text", text: "run fork tool" }]
            }, {
              id: "kept-agent",
              type: "agentMessage",
              text: "kept",
              phase: "final_answer"
            }]
          }, {
            id: removedTurnId,
            startedAt: 3,
            completedAt: 4,
            items: [{
              id: "removed-user",
              type: "userMessage",
              content: [{ type: "text", text: "remove me" }]
            }, {
              id: "removed-agent",
              type: "agentMessage",
              text: "removed",
              phase: "final_answer"
            }]
          }]
        }
      }
    }
  });
  const rollbackBatch = await hub.waitSessionCommands(sessionId, forkCommand.seq, 1);
  const rollbackCommand = rollbackBatch.commands[0];
  if (!rollbackCommand || rollbackCommand.type !== "rollback_thread" || rollbackCommand.threadId !== forkedThreadId || rollbackCommand.keepTurns !== 1 || rollbackCommand.numTurns !== 1) {
    throw new Error(`fork rollback command did not preserve expected boundary: ${JSON.stringify(rollbackCommand)}`);
  }
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId: forkedThreadId,
    commandId: rollbackCommand.commandId,
    heartbeat: false,
    message: {
      result: {
        thread: {
          id: forkedThreadId,
          cwd: "/tmp/codexhub-fork-tool",
          turns: [{
            id: keptTurnId,
            startedAt: 1,
            completedAt: 2,
            items: [{
              id: "kept-user",
              type: "userMessage",
              content: [{ type: "text", text: "run fork tool" }]
            }, {
              id: "kept-agent",
              type: "agentMessage",
              text: "kept",
              phase: "final_answer"
            }]
          }]
        }
      }
    }
  });
  const detail = await fork;
  const records = detail.records ?? [];
  if (!records.some((record) => asRecord(record).id === `app:${forkedThreadId}:${keptTurnId}:item:commandExecution:kept-tool`)) {
    throw new Error(`fork dropped kept turn tool record: ${JSON.stringify(records)}`);
  }
  if (records.some((record) => String(asRecord(record).id).includes(removedTurnId))) {
    throw new Error(`fork kept records from removed turn: ${JSON.stringify(records)}`);
  }
  if (records.some((record) => String(asRecord(record).id).startsWith(`app:${sourceThreadId}:`))) {
    throw new Error(`fork leaked source thread record ids: ${JSON.stringify(records)}`);
  }
};

const assertDeletedProjectSuppressesSessionCapture = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-delete."));
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  const machineId = "machine-delete-smoke";
  const projectPath = "/tmp/codexhub-delete-smoke";
  const now = "2026-01-01T00:00:00.000Z";
  const project = state.upsertProject({ machineId, path: projectPath, now });
  const legacyProjectId = `${machineId}\0${projectPath}`;
  if (!project) throw new Error("explicit project upsert was suppressed");
  if (!state.deleteProject(legacyProjectId)) throw new Error("legacy project delete did not report success");
  if (!state.deleteProject(legacyProjectId)) throw new Error("deleted project tombstone was not idempotent");

  const machine = {
    machineId,
    type: "local" as const,
    hostname: "delete-smoke",
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    capabilities: { projectLauncher: true }
  };
  const session = {
    sessionId: "session-delete-smoke",
    machineId,
    name: "delete-smoke",
    workingDirectory: projectPath,
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    hostname: "delete-smoke",
    threads: []
  };
  state.captureSessions({ sessions: [session], threads: [] });
  const deletedSnapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [] });
  if (deletedSnapshot.projects.some((item) => item.projectId === project.projectId)) {
    throw new Error("deleted project was restored by session capture");
  }

  const restored = state.upsertProject({
    machineId,
    path: projectPath,
    now: "2026-01-01T00:02:00.000Z"
  });
  if (!restored || restored.projectId !== project.projectId) throw new Error("explicit project reopen did not restore deleted project");
  const restoredSnapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [] });
  if (!restoredSnapshot.projects.some((item) => item.projectId === project.projectId)) {
    throw new Error("restored project was missing from snapshot");
  }
};

const assertSessionTurnRequiresThread = async (apiBase: string, sessionId: string) => {
  const response = await fetch(new URL(`/api/sessions/${encodeURIComponent(sessionId)}/turn`, apiBase), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "/status", source: "web" })
  });
  if (response.ok) throw new Error("/api/sessions/:sessionId/turn accepted a missing threadId");
  if (response.status !== 400) {
    throw new Error(`/api/sessions/:sessionId/turn missing threadId returned HTTP ${response.status}: ${await response.text()}`);
  }
};

const assertProjectSession = async (apiBase: string, projectId: string, sessionId: string) => {
  const payload = await apiJson<ProjectsPayload>(apiBase, "/api/projects");
  assertNoWorkerId(payload, "/api/projects");
  const project = (payload.projects ?? []).map(asRecord).find((item) => item.projectId === projectId);
  if (!project) throw new Error(`/api/projects missing opened project ${projectId}`);
  if (project.machineOnline !== true) throw new Error(`/api/projects did not expose machineOnline for ${projectId}`);
  const session = asRecord(project.session);
  if (session.sessionId !== sessionId || session.online !== true) {
    throw new Error(`/api/projects did not project active session for ${projectId}: ${JSON.stringify(project.session)}`);
  }
};

const assertProjectDeleteKeepsSharedSession = async (apiBase: string, projectId: string, sessionId: string) => {
  const deleted = await apiJson<{ stoppedSessions?: unknown[] }>(apiBase, `/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE"
  });
  assertNoWorkerId(deleted, "DELETE /api/projects/:projectId");
  const stoppedSession = (deleted.stoppedSessions ?? [])
    .map(asRecord)
    .find((item) => item.sessionId === sessionId);
  if (!stoppedSession || stoppedSession.stopped !== false || stoppedSession.reason !== "shared_session") {
    throw new Error(`DELETE /api/projects did not preserve shared session ${sessionId}: ${JSON.stringify(deleted.stoppedSessions)}`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    const payload = await apiJson<{ sessions?: unknown[] }>(apiBase, "/api/sessions?includeOffline=true");
    const session = (payload.sessions ?? []).map(asRecord).find((item) => item.sessionId === sessionId);
    if (session?.online === true) return;
    await delay(100);
  }
  const payload = await apiJson<{ sessions?: unknown[] }>(apiBase, "/api/sessions?includeOffline=true");
  throw new Error(`shared project session went offline after delete: ${JSON.stringify(payload.sessions)}`);
};

const assertSessionStaysOnlineAfterWatcherIdle = async (apiBase: string, machineId: string) => {
  const previousTimeout = process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS;
  process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS = "25";
  try {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-idle-project."));
    const open = await apiJson<ProjectOpenResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, path: projectDir })
    });
    const sessionId = open.result?.sessionId;
    const threadId = open.result?.threadId;
    if (!sessionId || !threadId) throw new Error(`idle project open did not return session/thread ids: ${JSON.stringify(open)}`);
    await subscribeThreadOnce(apiBase, threadId);

    const startedAt = Date.now();
    while (Date.now() - startedAt < 6000) {
      const payload = await apiJson<{ sessions?: unknown[] }>(apiBase, "/api/sessions?includeOffline=true");
      const session = (payload.sessions ?? []).map(asRecord).find((item) => item.sessionId === sessionId);
      if (!session || session.online !== true) {
        throw new Error(`runtime session went offline after watcher idle: ${JSON.stringify(payload.sessions)}`);
      }
      await delay(100);
    }
  } finally {
    if (previousTimeout === undefined) delete process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS;
    else process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS = previousTimeout;
  }
};

const subscribeThreadOnce = async (apiBase: string, threadId: string) => {
  const messages: RealtimeMessage[] = [];
  const ws = new WebSocket(webRealtimeUrl(apiBase));
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as RealtimeMessage);
  });
  try {
    await waitForWebSocketOpen(ws, "idle websocket failed");
    ws.send(JSON.stringify({ type: "hello", sessionsAfter: 0, projectsAfter: 0, tasksAfter: 0, connectionsAfter: 0 }));
    await waitForRealtimeMessage(messages, (message) => message.type === "ready", "idle websocket ready");
    ws.send(JSON.stringify({ type: "subscribe_thread", threadId, after: 0 }));
    await waitForRealtimeMessage(
      messages,
      (message) => message.type === "thread_subscribed" && message.threadId === threadId,
      "idle thread subscription"
    );
  } finally {
    await closeWebSocket(ws);
  }
};

const apiJson = async <T = unknown>(apiBase: string, pathname: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(new URL(pathname, apiBase), init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${pathname}: ${text}`);
  return data as T;
};

const assertNoWorkerId = (value: unknown, label: string) => {
  const path = findKey(value, "workerId");
  if (path) throw new Error(`${label} exposed workerId at ${path}`);
};

const assertNoCurrentThread = (value: unknown, label: string) => {
  const currentThreadId = findKey(value, "currentThreadId");
  if (currentThreadId) throw new Error(`${label} exposed currentThreadId at ${currentThreadId}`);
  const currentThread = findKey(value, "currentThread");
  if (currentThread) throw new Error(`${label} exposed currentThread at ${currentThread}`);
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

const assertPluginState = async (apiBase: string, value: unknown) => {
  const plugins = asRecord(value).plugins;
  if (!Array.isArray(plugins)) throw new Error("/api/plugins did not return plugins");
  const telegram = plugins.find((plugin) => asRecord(plugin).pluginId === "codexhub.telegram");
  if (!telegram) throw new Error("builtin Telegram plugin missing");
  const telegramIntegration = integrationsOf(telegram).find((integration) => asRecord(integration).type === "telegram");
  if (!telegramIntegration) throw new Error("Telegram integration missing");
  const telegramRecord = asRecord(telegramIntegration);
  if (telegramRecord.runner !== "builtin") throw new Error("Telegram integration is not builtin");
  if (telegramRecord.configured !== false || telegramRecord.started !== false) {
    throw new Error("Telegram integration should be unconfigured and stopped without TELEGRAM_BOT_TOKEN");
  }

  const external = plugins.find((plugin) => asRecord(plugin).pluginId === "external-channel");
  if (!external) throw new Error("external integration fixture missing");
  const externalIntegration = integrationsOf(external).find((integration) => asRecord(integration).type === "external-channel");
  if (!externalIntegration || asRecord(externalIntegration).runner !== "external") {
    throw new Error("external integration fixture was not reported as external");
  }
  const style = stylesOf(external).find((item) => asRecord(item).path === "style.css");
  const styleUrl = asRecord(style).url;
  if (typeof styleUrl !== "string" || !styleUrl.includes("/api/plugins/external-channel/assets/style.css")) {
    throw new Error(`external plugin style fixture missing url: ${JSON.stringify(style)}`);
  }
  const response = await fetch(new URL(styleUrl, apiBase));
  const css = await response.text();
  if (!response.ok || !css.includes("--codexhub-smoke-plugin")) {
    throw new Error(`external plugin style asset did not load: HTTP ${response.status} ${css}`);
  }
};

const integrationsOf = (plugin: unknown) => {
  const contributions = asRecord(asRecord(plugin).contributions);
  const integrations = contributions.integrations;
  return Array.isArray(integrations) ? integrations : [];
};

const stylesOf = (plugin: unknown) => {
  const contributions = asRecord(asRecord(plugin).contributions);
  const web = asRecord(contributions.web);
  const styles = web.styles;
  return Array.isArray(styles) ? styles : [];
};

const sendLegacySessionRegistration = async (port: number) => {
  const messages: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/machines/connect`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("legacy websocket failed")), { once: true });
  });

  ws.addEventListener("message", (event) => {
    const text = String(event.data);
    messages.push(text);
    const data = JSON.parse(text) as { type?: string };
    if (data.type === "registered") {
      ws.send(JSON.stringify({
        type: "session_register",
        sessionId: "legacy-session",
        registration: {
          workerId: "legacy-worker",
          workingDirectory: os.tmpdir(),
          name: "legacy",
          hostname: "legacy-host"
        }
      }));
    }
  });

  ws.send(JSON.stringify({
    type: "register",
    registration: {
      machineId: "legacy-machine",
      hostname: "legacy-host",
      type: "registered",
      capabilities: { projectLauncher: true }
    }
  }));

  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const error = messages.find((message) => message.includes("invalid machine transport message"));
    if (error) {
      await closeWebSocket(ws);
      return error;
    }
    await delay(50);
  }
  await closeWebSocket(ws);
  return messages.join("\n");
};

const webRealtimeUrl = (apiBase: string) => {
  const url = new URL("/api/events/ws", apiBase);
  url.protocol = "ws:";
  return url.toString();
};

const waitForWebSocketOpen = async (ws: WebSocket, label: string) => await new Promise<void>((resolve, reject) => {
  if (ws.readyState === WebSocket.OPEN) {
    resolve();
    return;
  }
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error(label)), { once: true });
});

const closeWebSocket = async (ws: WebSocket) => {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    ws.addEventListener("close", finish, { once: true });
    ws.close();
  });
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const delay = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
