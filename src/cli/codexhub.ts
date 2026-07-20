#!/usr/bin/env tsx
import { Command } from "commander";
import { loadDotEnv } from "../core/dotenv.js";
import {
  parseCodexApprovalPolicy,
  parseCodexApprovalsReviewer,
  parseCodexSandboxMode,
  resolveCodexAppServerLaunchOptions,
  type CodexAppServerLaunchOptions
} from "./codexAppServerProcess.js";
import { runCodexhubMachine } from "./codexhubMachine.js";

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
  server?: string;
  authToken?: string;
  machineId?: string;
  type?: "local" | "ssh" | "registered";
  name?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox?: string;
};

type SshConnectCommandOptions = {
  name?: string;
  remotePort?: string;
};

type InstallTheiaCommandOptions = {
  configDir?: string;
  vsix?: string;
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

const program = new Command()
  .name("codexhub")
  .description("Start and manage CodexHub")
  .option("--server <url>", "codexhub server URL", defaultServerUrl());

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
  .option("--server <url>", "codexhub server URL")
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
      apiBase: options.server ?? apiBase(),
      authToken: options.authToken ?? process.env.CODEX_HUB_AUTH_TOKEN,
      machineId: options.machineId,
      type: parseMachineType(options.type),
      name: options.name,
      appServerLaunch
    });
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
    if (result.windowsExtension) {
      console.log(`Installed VS Code extension in Windows host: ${result.windowsExtension}`);
    }
    console.log("Reload the VS Code window to activate the extension.");
  });

program
  .command("install-theia")
  .description("Install the bundled CodexHub extension into Theia on this machine")
  .option("--vsix <path>", "CodexHub VSIX to install (defaults to the VSIX bundled with this CLI)")
  .option("--config-dir <path>", "Theia config directory (defaults to ~/.theia-ide)")
  .action(async (options: InstallTheiaCommandOptions = {}) => {
    const { installTheiaExtension } = await import("../core/theiaExtensionInstaller.js");
    const result = await installTheiaExtension({
      configDir: options.configDir,
      vsixPath: options.vsix,
    });
    console.log(`Installed Theia extension: ${result.extensionId}@${result.version}`);
    console.log(`Deployment: ${result.deploymentPath}`);
    if (result.replacedExisting) console.log("Replaced the existing deployment atomically.");
    if (result.removedStaleDropIn) console.log(`Removed stale VSIX drop-in: ${result.removedStaleDropIn}`);
    if (result.retainedBackupPath) console.warn(`Warning: retained old deployment backup: ${result.retainedBackupPath}`);
    console.log("Reconnect the Theia workspace to activate the extension.");
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
    const payload = await apiJson<{ task?: LocalTask; threadId?: string; sessionId?: string }>(
      `/api/tasks/${encodeURIComponent(task.taskId)}/run`,
      { method: "POST" }
    );
    if (payload.task) printLocalTasks([payload.task]);
    console.log(`Run queued on session ${payload.sessionId ?? "(unknown)"} thread ${payload.threadId ?? "(unknown)"}`);
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
  process.exitCode = 1;
});

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
  const options = program.opts<{ server: string }>();
  return options.server;
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
  if (process.env.CODEX_HUB_SERVER_URL) return process.env.CODEX_HUB_SERVER_URL;
  const host = process.env.CODEX_HUB_HOST ?? "127.0.0.1";
  const port = process.env.CODEX_HUB_PORT ?? "8788";
  return serverUrl(host, Number(port));
}

function waitForShutdown() {
  return new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    process.once("SIGHUP", resolve);
  });
}
