import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

type MachineSummary = {
  machineId: string;
  type?: string;
  online?: boolean;
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

type ThreadDetail = {
  threadId: string;
  records?: unknown[];
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
  const sshDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-ssh."));
  const fakeSshDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-bin."));
  const fakeSshArgsPath = path.join(fakeSshDir, "ssh-args.txt");
  await writeExternalPlugin(pluginDir);
  const sshConfigPath = await writeSshConfigFixture(sshDir);
  await writeFakeSsh(fakeSshDir);

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_PLUGIN_DIR = pluginDir;
  process.env.CODEX_HUB_SSH_CONFIG = sshConfigPath;
  process.env.CODEXHUB_FAKE_SSH_ARGS_FILE = fakeSshArgsPath;
  process.env.PATH = `${fakeSshDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_HUB_LOCAL_MACHINE = "1";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "1";
  process.env.TELEGRAM_BOT_TOKEN = "";

  const port = await findFreePort();
  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({ host: "127.0.0.1", port });
  const apiBase = `http://127.0.0.1:${port}`;

  try {
    const machine = await waitForLocalMachine(apiBase);
    console.log(`machine ok: ${machine.machineId}`);

    await assertSshHosts(apiBase);
    console.log("ssh hosts ok");

    await assertSshConnect(apiBase, port, fakeSshArgsPath, sshConfigPath);
    console.log("ssh connect ok");

    const open = await apiJson<ProjectOpenResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: machine.machineId, path: projectDir })
    });
    assertNoWorkerId(open, "/api/projects/open");
    const sessionId = open.result?.sessionId;
    const threadId = open.result?.threadId;
    if (!sessionId || !threadId) throw new Error("project open did not return sessionId/threadId");
    console.log(`project ok: ${sessionId} ${threadId}`);

    await apiJson(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "/status", source: "web" })
    });

    const sessions = await apiJson(apiBase, "/api/sessions");
    assertNoWorkerId(sessions, "/api/sessions");
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

    const legacyError = await sendLegacySessionRegistration(port);
    if (!legacyError.includes("workerId") || !legacyError.includes("unrecognized_keys")) {
      throw new Error(`legacy session registration was not rejected as expected: ${legacyError}`);
    }
    console.log("legacy registration rejected");
  } finally {
    await server.stop();
  }
};

const writeFakeSsh = async (root: string) => {
  const filePath = path.join(root, "ssh");
  await writeFile(filePath, [
    "#!/bin/sh",
    "if [ -n \"$CODEXHUB_FAKE_SSH_ARGS_FILE\" ]; then",
    "  : > \"$CODEXHUB_FAKE_SSH_ARGS_FILE\"",
    "  for arg in \"$@\"; do",
    "    printf '%s\\n' \"$arg\" >> \"$CODEXHUB_FAKE_SSH_ARGS_FILE\"",
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

const assertSshHosts = async (apiBase: string) => {
  const data = await apiJson<{ hosts?: SshHost[] }>(apiBase, "/api/ssh/hosts");
  assertNoWorkerId(data, "/api/ssh/hosts");
  const hosts = data.hosts ?? [];
  const direct = hosts.find((host) => host.alias === "direct-host");
  if (!direct || direct.hostName !== "192.0.2.10" || direct.user !== "direct" || direct.port !== 2222) {
    throw new Error(`direct ssh host fixture was not parsed: ${JSON.stringify(direct)}`);
  }
  const included = hosts.find((host) => host.alias === "included-host");
  if (!included || included.hostName !== "included.example.com" || included.user !== "ubuntu" || included.proxyJump !== "jump-host") {
    throw new Error(`included ssh host fixture was not parsed: ${JSON.stringify(included)}`);
  }
  if (hosts.some((host) => host.alias === "*")) throw new Error("wildcard ssh host was exposed");
};

const assertSshConnect = async (apiBase: string, serverPort: number, argsPath: string, sshConfigPath: string) => {
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
  if (!remoteCommand.includes("codexhub machine")
    || !remoteCommand.includes("--server 'http://127.0.0.1:19001'")
    || !remoteCommand.includes("--type ssh")
    || !remoteCommand.includes("--name 'Included Host'")) {
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

const waitForFakeSshArgs = async (argsPath: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const text = await readFile(argsPath, "utf8").catch(() => "");
    const args = text.split(/\r?\n/).filter(Boolean);
    if (args.length) return args;
    await delay(50);
  }
  throw new Error("fake ssh did not receive arguments");
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
  if (telegramRecord.runtime !== "builtin") throw new Error("Telegram integration is not builtin");
  if (telegramRecord.configured !== false || telegramRecord.started !== false) {
    throw new Error("Telegram integration should be unconfigured and stopped without TELEGRAM_BOT_TOKEN");
  }

  const external = plugins.find((plugin) => asRecord(plugin).pluginId === "external-channel");
  if (!external) throw new Error("external integration fixture missing");
  const externalIntegration = integrationsOf(external).find((integration) => asRecord(integration).type === "external-channel");
  if (!externalIntegration || asRecord(externalIntegration).runtime !== "external") {
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
