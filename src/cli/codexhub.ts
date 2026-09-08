#!/usr/bin/env tsx
import path from "node:path";
import { Command } from "commander";
import { codexHubDataDirectory } from "../core/authorityPaths.js";
import { loadDotEnv } from "../core/dotenv.js";
import { readAndApplyServerConfigEnv } from "../core/serverConfigEnv.js";
import {
  parseCodexApprovalPolicy,
  parseCodexApprovalsReviewer,
  parseCodexSandboxMode,
  resolveCodexAppServerLaunchOptions,
  type CodexAppServerLaunchOptions
} from "./codexAppServerProcess.js";
import { runCodexhubMachine } from "./codexhubMachine.js";
import { runConversation, type ConversationRunOptions, ConversationInterruptedError } from "./conversation.js";
import {
  ConversationStreamRenderer,
  type ConversationStreamOutput
} from "./conversationStreamRenderer.js";
import { defaultLocalServerUrl, ensureLocalServer } from "./localServerBootstrap.js";
import { registerParent, resolveRegisterParentTarget } from "./registerParent.js";
import { threadRunOptionsSchema } from "../shared/apiContract.js";

type ServerCommandOptions = {
  host?: string;
  port?: string;
  serveStatic?: string;
  registerTo?: string;
  registerAuthToken?: string;
  registerMachineId?: string;
  registerName?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox?: string;
};

type MachineCommandOptions = {
  connect?: string;
  server?: string;
  authToken?: string;
  machineId?: string;
  type?: "local" | "ssh" | "registered";
  name?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox?: string;
};

type RegisterCommandOptions = {
  to: string;
  authToken?: string;
  machineId?: string;
  name?: string;
};

type SshConnectCommandOptions = {
  name?: string;
  remotePort?: string;
};

type InstallVSCodeCommandOptions = {
  vsix?: string;
};

type TaskCreateCommandOptions = {
  name: string;
  schedule: string;
  machine: string;
  project: string;
  input: string;
  thread?: string;
  disabled?: boolean;
};

type ConversationCommandOptions = {
  name?: string;
  machine?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  stream?: boolean;
  output?: string;
  wait?: boolean;
  noWait?: boolean;
  json?: boolean;
  timeout?: string;
};

type LocalTask = {
  taskId: string;
  name: string;
  enabled: boolean;
  schedule: string;
  machineId: string;
  projectPath: string;
  projectId?: string;
  threadId?: string;
  input: string;
  updatedAt: string;
  nextRunAt?: string | null;
  lastRunAt?: string;
  lastStatus?: "queued" | "completed" | "failed" | "skipped";
  lastError?: string;
};

await loadDotEnv();
await readAndApplyServerConfigEnv(path.join(codexHubDataDirectory(), "config.yaml"));

const program = new Command()
  .name("codexhub")
  .description("Start and manage CodexHub")
  .option("--connect <url>", "CodexHub backend URL")
  .option("--server <url>", "compatibility alias for --connect");

program
  .command("server")
  .description("Start the CodexHub web/API server")
  .option("--host <host>", "listen host (overrides CODEX_HUB_HOST)")
  .option("--port <port>", "listen port (overrides CODEX_HUB_PORT)")
  .option("--serve-static <dir>", "serve built web assets from this directory")
  .option("--register-to <url>", "also register this server as a machine with a parent CodexHub server")
  .option("--register-auth-token <token>", "parent CodexHub auth token (defaults to CODEX_HUB_REGISTER_AUTH_TOKEN)")
  .option("--register-machine-id <id>", "stable machine id for parent registration")
  .option("--register-name <name>", "display name for parent registration")
  .option("--approval-policy <policy>", "approval policy override for launched Codex app-server")
  .option("--approvals-reviewer <reviewer>", "approval reviewer override for launched Codex app-server")
  .option("--sandbox <mode>", "default sandbox mode for launched Codex app-server")
  .action(async (options: ServerCommandOptions = {}) => {
    const rootOptions = program.opts<{ port?: string }>();
    const { startServer } = await import("../server/index.js");
    const appServerLaunch = appServerLaunchOptions(options);
    let handle: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      handle = await startServer({
        host: options.host,
        port: parsePortOption(options.port ?? rootOptions.port),
        staticDirectory: options.serveStatic,
        appServerLaunch,
        parentRegistration: {
          url: options.registerTo,
          authToken: options.registerAuthToken,
          machineId: options.registerMachineId,
          name: options.registerName
        }
      });
      const localUrl = serverUrl(handle.host, handle.port);
      console.error(`codexhub server listening: ${localUrl}`);
      await waitForShutdown();
    } finally {
      await handle?.stop();
    }
  });

program
  .command("machine")
  .description("Register this machine so it can start runtime threads for project paths")
  .option("--connect <url>", "CodexHub backend URL for this machine command")
  .option("--server <url>", "compatibility alias for the machine command's --connect")
  .option("--auth-token <token>", "codexhub API auth token (defaults to CODEX_HUB_AUTH_TOKEN)")
  .option("--machine-id <id>", "stable machine id")
  .option("--type <type>", "machine connection type: local, ssh, or registered", "registered")
  .option("--name <name>", "display name")
  .option("--approval-policy <policy>", "approval policy override for launched Codex app-server")
  .option("--approvals-reviewer <reviewer>", "approval reviewer override for launched Codex app-server")
  .option("--sandbox <mode>", "default sandbox mode for launched Codex app-server")
  .action(async (options: MachineCommandOptions = {}) => {
    const appServerLaunch = appServerLaunchOptions(options);
    await runCodexhubMachine({
      apiBase: resolveConnectionUrl(
        program.opts<{ connect?: string; server?: string }>().connect,
        program.opts<{ connect?: string; server?: string }>().server,
        options.connect,
        options.server
      ),
      authToken: options.authToken ?? process.env.CODEX_HUB_AUTH_TOKEN,
      machineId: options.machineId,
      type: parseMachineType(options.type),
      name: options.name,
      appServerLaunch
    });
  });

program
  .command("start")
  .argument("<input>", "first message to send")
  .requiredOption("--name <name>", "thread name")
  .option("--machine <machineId>", "target machine id")
  .option("--cwd <path>", "working directory on the target machine")
  .option("--model <model>", "model override for this turn")
  .option("--effort <effort>", "reasoning effort override for this turn")
  .option("--stream", "stream canonical records as they arrive")
  .option("--output <mode>", "stream output mode: normal or raw")
  .option("--no-wait", "return after the backend accepts the submission")
  .option("--timeout <seconds>", "wait timeout in seconds", String(600))
  .option("--json", "print a JSON result")
  .description("Create a thread, name it, and send its first message")
  .action(async (input: string, options: ConversationCommandOptions) => {
    await runConversationCommand({
      operation: "start",
      input,
      name: options.name,
      machine: options.machine,
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      stream: options.stream,
      output: options.output,
      noWait: options.wait === false,
      json: options.json,
      timeout: options.timeout
    });
  });

program
  .command("send")
  .argument("<threadId>", "official Codex thread id")
  .argument("<input>", "message to send")
  .option("--machine <machineId>", "target machine id when the thread is not known by this backend")
  .option("--cwd <path>", "working directory on the target machine")
  .option("--model <model>", "model override for this turn")
  .option("--effort <effort>", "reasoning effort override for this turn")
  .option("--stream", "stream canonical records as they arrive")
  .option("--output <mode>", "stream output mode: normal or raw")
  .option("--no-wait", "return after the backend accepts the submission")
  .option("--timeout <seconds>", "wait timeout in seconds", String(600))
  .option("--json", "print a JSON result")
  .description("Resume a thread and send a message")
  .action(async (threadId: string, input: string, options: ConversationCommandOptions) => {
    await runConversationCommand({
      operation: "send",
      input,
      threadId,
      machine: options.machine,
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      stream: options.stream,
      output: options.output,
      noWait: options.wait === false,
      json: options.json,
      timeout: options.timeout
    });
  });

program
  .command("register")
  .description("Register the local CodexHub server with a parent server and exit")
  .requiredOption("--to <url>", "parent CodexHub server URL (a codexhub_token query token is supported)")
  .option("--auth-token <token>", "parent server auth token (defaults to CODEX_HUB_REGISTER_AUTH_TOKEN)")
  .option("--machine-id <id>", "stable machine id for the parent registration")
  .option("--name <name>", "display name for the parent registration")
  .action(async (options: RegisterCommandOptions) => {
    const parent = resolveRegisterParentTarget(options.to, options.authToken);
    await registerParent({
      localServerUrl: apiBase(),
      localAuthToken: process.env.CODEX_HUB_AUTH_TOKEN,
      parentUrl: parent.url,
      parentAuthToken: parent.authToken,
      machineId: options.machineId,
      name: options.name
    });
    console.log("Registration request accepted by local CodexHub server.");
  });

const sshCommand = program
  .command("ssh")
  .description("Manage SSH machines from the local codexhub server")
  .action(() => {
    sshCommand.help();
  });

sshCommand
  .command("hosts")
  .description("List SSH host aliases added to CodexHub")
  .action(async () => {
    const data = await apiJson<{ hosts?: Array<{ alias: string; hostName?: string; user?: string; port?: number; proxyJump?: string }> }>("/api/ssh/hosts");
    const hosts = data.hosts ?? [];
    if (!hosts.length) {
      console.log("No CodexHub SSH hosts added.");
      return;
    }
    console.table(hosts.map((host) => ({
      host: host.alias,
      hostname: host.hostName ?? "",
      user: host.user ?? "",
      port: host.port ?? "",
      proxyJump: host.proxyJump ?? ""
    })));
  });

sshCommand
  .command("config-hosts")
  .description("List hosts discovered from ~/.ssh/config")
  .action(async () => {
    const data = await apiJson<{ hosts?: Array<{ alias: string; hostName?: string; user?: string; port?: number; proxyJump?: string }> }>("/api/ssh/config-hosts");
    const hosts = data.hosts ?? [];
    if (!hosts.length) {
      console.log("No SSH config hosts found.");
      return;
    }
    console.table(hosts.map((host) => ({
      host: host.alias,
      hostname: host.hostName ?? "",
      user: host.user ?? "",
      port: host.port ?? "",
      proxyJump: host.proxyJump ?? ""
    })));
  });

sshCommand
  .command("add")
  .argument("<alias>", "SSH config host alias to add to CodexHub")
  .description("Add a host alias from ~/.ssh/config to CodexHub")
  .action(async (alias: string) => {
    await apiJson("/api/ssh/hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias })
    });
    console.log(`Added CodexHub SSH host: ${alias}`);
  });

sshCommand
  .command("remove")
  .argument("<alias>", "SSH host alias to remove from CodexHub")
  .description("Remove a host alias from CodexHub without editing ~/.ssh/config")
  .action(async (alias: string) => {
    await apiJson(`/api/ssh/hosts/${encodeURIComponent(alias)}`, { method: "DELETE" });
    console.log(`Removed CodexHub SSH host: ${alias}`);
  });

sshCommand
  .command("connect")
  .argument("<host>", "SSH host alias or destination")
  .option("--name <name>", "display name for the remote machine")
  .option("--remote-port <port>", "remote loopback port for the reverse tunnel")
  .description("Connect to a remote machine over SSH and start the CodexHub remote client there")
  .action(async (host: string, options: SshConnectCommandOptions = {}) => {
    const payload = await apiJson<{ connection?: { connectionId: string; host: string; status: string; remotePort: number } }>("/api/ssh/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host,
        name: options.name,
        remotePort: options.remotePort ? parsePortOption(options.remotePort) : undefined
      })
    });
    const connection = payload.connection;
    if (!connection) throw new Error("SSH connect did not return a connection.");
    console.log(`SSH connection ${connection.status}: ${connection.host} (${connection.connectionId}, remote port ${connection.remotePort})`);
  });

program
  .command("install-vscode")
  .description("Install the bundled CodexHub extension into VS Code")
  .option("--vsix <path>", "CodexHub VSIX to install (defaults to the VSIX bundled with this CLI)")
  .action(async (options: InstallVSCodeCommandOptions = {}) => {
    const { installVSCodeExtension } = await import("../core/vscodeExtensionInstaller.js");
    const result = await installVSCodeExtension({ vsixPath: options.vsix });
    console.log(`Installed VS Code extension in current host: ${result.localExtension}`);
    if (result.localInsidersExtension) {
      console.log(`Installed VS Code extension in current host Insiders: ${result.localInsidersExtension}`);
    }
    if (result.windowsExtension) {
      console.log(`Installed VS Code extension in Windows host: ${result.windowsExtension}`);
    }
    if (result.windowsInsidersExtension) {
      console.log(`Installed VS Code extension in Windows host Insiders: ${result.windowsInsidersExtension}`);
    }
    console.log("Reload the VS Code window to activate the extension.");
  });

const taskCommand = program
  .command("task")
  .description("Manage local server-scheduled tasks")
  .action(() => {
    taskCommand.help();
  });

taskCommand
  .command("list")
  .description("List local tasks stored in the codexhub server")
  .action(async () => {
    const tasks = await listLocalTasks();
    printLocalTasks(tasks);
  });

taskCommand
  .command("create")
  .requiredOption("--name <name>", "task name")
  .requiredOption("--schedule <cron>", "cron schedule, for example \"0 9 * * *\"")
  .requiredOption("--machine <machineId>", "target machine id")
  .requiredOption("--project <path>", "target project path on that machine")
  .requiredOption("--input <text>", "message to send on each run")
  .option("--thread <threadId>", "optional thread to resume before sending")
  .option("--disabled", "create the task disabled")
  .description("Create a server-local scheduled conversation task")
  .action(async (options: TaskCreateCommandOptions) => {
    const payload = await apiJson<{ task?: LocalTask }>("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: options.name,
        enabled: !options.disabled,
        schedule: options.schedule,
        machineId: options.machine,
        projectPath: options.project,
        threadId: options.thread,
        input: options.input
      })
    });
    if (!payload.task) throw new Error("Task create did not return a task.");
    printLocalTasks([payload.task]);
  });

taskCommand
  .command("run")
  .argument("<task>", "task id, unique id prefix, or unique task name")
  .description("Run one server-local task immediately")
  .action(async (target: string) => {
    const task = resolveTaskTarget(target, await listLocalTasks());
    const payload = await apiJson<{ task?: LocalTask; threadId?: string; machineId?: string }>(
      `/api/tasks/${encodeURIComponent(task.taskId)}/run`,
      { method: "POST" }
    );
    if (payload.task) printLocalTasks([payload.task]);
    console.log(`Run queued on machine ${payload.machineId ?? "(unknown)"} thread ${payload.threadId ?? "(unknown)"}`);
  });

taskCommand
  .command("enable")
  .argument("<task>", "task id, unique id prefix, or unique task name")
  .description("Enable a server-local task")
  .action(async (target: string) => {
    await setTaskEnabled(target, true);
  });

taskCommand
  .command("disable")
  .argument("<task>", "task id, unique id prefix, or unique task name")
  .description("Disable a server-local task")
  .action(async (target: string) => {
    await setTaskEnabled(target, false);
  });

taskCommand
  .command("delete")
  .argument("<task>", "task id, unique id prefix, or unique task name")
  .description("Delete a server-local task")
  .action(async (target: string) => {
    const task = resolveTaskTarget(target, await listLocalTasks());
    await apiJson(`/api/tasks/${encodeURIComponent(task.taskId)}`, { method: "DELETE" });
    console.log(`Deleted ${formatTask(task)}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof ConversationInterruptedError ? error.exitCode : 1;
});

async function runConversationCommand(
  options: ConversationCommandOptions & Pick<ConversationRunOptions, "operation" | "input"> & { threadId?: string }
) {
  const output = validateConversationCommand(options);
  const timeoutSeconds = parseTimeoutSecondsOption(options.timeout);
  const json = options.json === true;
  const input = await readConversationInput(options.input);
  if (!input.trim()) throw new Error("Conversation input must not be empty.");
  if (options.operation === "start" && !options.name?.trim()) {
    throw new Error("start requires a non-empty --name.");
  }
  const conversationDeadline = Date.now() + timeoutSeconds * 1000;
  const backend = await resolveConversationBackend(options.cwd, conversationDeadline);
  console.error(`codexhub backend: ${new URL(backend.baseUrl).origin} (${backend.status})`);
  const remainingTimeoutMs = conversationDeadline - Date.now();
  if (remainingTimeoutMs <= 0) throw new Error("CLI conversation timeout expired during local server startup; no turn was submitted.");
  const remainingTimeoutSeconds = remainingTimeoutMs / 1000;
  const renderer = options.stream
    ? new ConversationStreamRenderer(output)
    : undefined;
  const result = await runConversation({
    operation: options.operation,
    input,
    name: options.name,
    threadId: options.threadId,
    machineId: options.machine,
    cwd: options.cwd,
    model: options.model,
    effort: options.effort,
    noWait: options.noWait,
    json: options.json,
    baseUrl: backend.baseUrl,
    authToken: process.env.CODEX_HUB_AUTH_TOKEN,
    timeoutSeconds: remainingTimeoutSeconds,
    onThreadReady: renderer
      ? (target) => renderer.threadStarted(target)
      : json ? undefined : (target) => console.log(`Thread ID: ${target.threadId}`),
    onStreamEvent: renderer ? (event) => renderer.event(event) : undefined,
    onError: renderer
      ? (error, target) => renderer.error({ threadId: target?.threadId, message: error.message })
      : undefined
  });
  if (renderer) {
    if (result.waited) {
      // The HTTP response and this lastSeq wait are the completion boundary;
      // stream records themselves were emitted by the WS callback above.
      if (result.lastSeq === undefined) throw new Error("CodexHub completed a stream without a lastSeq barrier.");
      renderer.completed({
        threadId: result.threadId,
        lastSeq: result.lastSeq,
        submissionId: result.submissionId,
        delivery: result.delivery
      });
    }
    return;
  }
  if (json) {
    const { lastSeq, ...publicResult } = result;
    void lastSeq;
    console.log(JSON.stringify(publicResult));
    return;
  }
  if (options.noWait) {
    if (result.submissionId) console.log(`Submission ID: ${result.submissionId}`);
    if (result.delivery) console.log(`Delivery: ${result.delivery}`);
    return;
  }
  for (const text of result.assistant) console.log(text);
}

async function resolveConversationBackend(cwd: string | undefined, deadline: number) {
  const rootOptions = program.opts<{ connect?: string; server?: string }>();
  const explicitlySelected = Boolean(rootOptions.connect?.trim() || rootOptions.server?.trim());
  const environmentSelected = Boolean(process.env.CODEX_HUB_SERVER_URL?.trim());
  if (explicitlySelected || environmentSelected) {
    return { baseUrl: resolveConnectionUrl(rootOptions.connect, rootOptions.server), status: "connected" as const };
  }
  return await ensureLocalServer({
    baseUrl: defaultLocalServerUrl(),
    dataDir: codexHubDataDirectory(),
    authToken: process.env.CODEX_HUB_AUTH_TOKEN,
    cwd,
    deadline
  });
}

function validateConversationCommand(options: ConversationCommandOptions): ConversationStreamOutput {
  const stream = options.stream === true;
  if (stream && options.json) throw new Error("--stream cannot be combined with --json.");
  if (stream && options.noWait) throw new Error("--stream cannot be combined with --no-wait.");
  if (!stream && options.output !== undefined) throw new Error("--output is only valid with --stream.");
  if (options.output !== undefined && options.output !== "normal" && options.output !== "raw") {
    throw new Error("--output must be normal or raw.");
  }
  const parsed = threadRunOptionsSchema.safeParse({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { modelReasoningEffort: options.effort })
  });
  if (!parsed.success) throw new Error(`Invalid conversation turn options: ${parsed.error.issues[0]?.message ?? "invalid options"}`);
  return options.output === "raw" ? "raw" : "normal";
}

async function readConversationInput(input: string) {
  if (input !== "-") return input;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function apiJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), withAuth(init));
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function withAuth(init: RequestInit = {}): RequestInit {
  const token = process.env.CODEX_HUB_AUTH_TOKEN?.trim();
  if (!token) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

async function listLocalTasks() {
  const data = await apiJson<{ tasks?: LocalTask[] }>("/api/tasks");
  return (data.tasks ?? []).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function printLocalTasks(tasks: LocalTask[]) {
  if (!tasks.length) {
    console.log("No tasks.");
    return;
  }
  console.table(tasks.map((task) => ({
    task: task.name,
    id: task.taskId.slice(0, 8),
    enabled: task.enabled ? "yes" : "no",
    schedule: task.schedule,
    nextRun: task.nextRunAt ? formatLocalTime(task.nextRunAt) : "",
    status: task.lastStatus ?? "",
    lastRun: task.lastRunAt ? formatLocalTime(task.lastRunAt) : "",
    machine: task.machineId,
    project: task.projectPath,
    thread: task.threadId ? task.threadId.slice(0, 8) : "",
    error: task.lastError ? truncate(singleLine(task.lastError), 80) : ""
  })));
}

function resolveTaskTarget(target: string, tasks: LocalTask[]) {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("Missing task target.");

  const exactId = tasks.find((task) => task.taskId === trimmed);
  if (exactId) return exactId;

  const matches = tasks.filter((task) => task.taskId.startsWith(trimmed) || task.name === trimmed);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error([
      `Task target "${trimmed}" is ambiguous. Matching tasks:`,
      ...matches.map((task) => `  ${formatTask(task)}`)
    ].join("\n"));
  }

  throw new Error(`Task not found: ${trimmed}.`);
}

async function setTaskEnabled(target: string, enabled: boolean) {
  const task = resolveTaskTarget(target, await listLocalTasks());
  const payload = await apiJson<{ task?: LocalTask }>(`/api/tasks/${encodeURIComponent(task.taskId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!payload.task) throw new Error("Task update did not return a task.");
  printLocalTasks([payload.task]);
}

function formatTask(task: LocalTask) {
  return `${task.taskId.slice(0, 8)} (${task.name}, ${task.projectPath})`;
}

function apiUrl(path: string) {
  return new URL(path, apiBase()).toString();
}

function apiBase() {
  const options = program.opts<{ connect?: string; server?: string }>();
  return resolveConnectionUrl(options.connect, options.server);
}

function resolveConnectionUrl(...values: Array<string | undefined>) {
  const explicit = values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim());
  const unique = new Map(explicit.map((value) => [connectionKey(value), value]));
  if (unique.size > 1) {
    throw new Error("--connect and --server specify different CodexHub backends.");
  }
  const selected = unique.values().next().value as string | undefined;
  const value = selected ?? defaultServerUrl();
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("CodexHub backend URL must use http:// or https://.");
  }
  return parsed.toString();
}

function connectionKey(value: string) {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) {
    parsed.port = "";
  }
  return parsed.toString();
}

function parseTimeoutSecondsOption(value: string | undefined) {
  if (value === undefined) return 600;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 86_400) {
    throw new Error("--timeout must be greater than 0 and no more than 86400 seconds.");
  }
  return parsed;
}

function formatLocalTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return [
    date.getFullYear(),
    "-",
    pad2(date.getMonth() + 1),
    "-",
    pad2(date.getDate()),
    " ",
    pad2(date.getHours()),
    ":",
    pad2(date.getMinutes()),
    ":",
    pad2(date.getSeconds())
  ].join("");
}

function singleLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function parsePortOption(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function parseMachineType(value: string | undefined): "local" | "ssh" | "registered" | undefined {
  if (!value) return undefined;
  if (value === "local" || value === "ssh" || value === "registered") return value;
  throw new Error(`Invalid machine type: ${value}`);
}

function appServerLaunchOptions(
  options: Pick<ServerCommandOptions, "approvalPolicy" | "approvalsReviewer" | "sandbox">
): CodexAppServerLaunchOptions {
  return resolveCodexAppServerLaunchOptions({
    approvalPolicy: parseCodexApprovalPolicy(options.approvalPolicy, "--approval-policy"),
    approvalsReviewer: parseCodexApprovalsReviewer(options.approvalsReviewer, "--approvals-reviewer"),
    sandbox: parseCodexSandboxMode(options.sandbox, "--sandbox")
  });
}

function serverUrl(host: string, port: number) {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}`;
}

function defaultServerUrl() {
  const configuredUrl = process.env.CODEX_HUB_SERVER_URL?.trim();
  if (configuredUrl) return configuredUrl;
  const host = process.env.CODEX_HUB_HOST ?? "127.0.0.1";
  const port = process.env.CODEX_HUB_PORT ?? "8788";
  return serverUrl(host, parsePortOption(port) ?? 8788);
}

function waitForShutdown() {
  return new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    process.once("SIGHUP", resolve);
  });
}
