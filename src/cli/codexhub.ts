#!/usr/bin/env tsx
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "../core/dotenv.js";
import { listLoadableCodexThreads } from "../core/codexhubLog.js";
import type { CodexSessionSummary } from "../core/codexSession.js";
import { registerCodexHubWorkerCommands, startHeadlessCodexhubWorker, type HeadlessCodexhubWorkerHandle } from "./codexhubConnect.js";
import {
  CodexhubTaskScheduler,
  loadTaskFiles,
  resolveTaskThread,
  safeTaskName,
  taskTemplate,
  type ThreadSummary
} from "./taskScheduler.js";

type TaskCommandOptions = {
  intervalMs?: string;
};

type ServerCommandOptions = {
  host?: string;
  port?: string;
  serveStatic?: string;
};

type ThreadsCommandOptions = {
  show?: string;
};

type WorkerSummary = {
  workerId: string;
  name?: string;
  workingDirectory: string;
  online: boolean;
  lastSeenAt: string;
  currentThreadId?: string;
  currentThread?: ThreadSummary;
  threads?: ThreadSummary[];
};

await loadDotEnv();

const program = new Command()
  .name("codexhub")
  .description("Run Codex through codexhub")
  .option("--server <url>", "codexhub server URL", defaultServerUrl());

program
  .command("server")
  .description("Start the codexhub API server")
  .option("--host <host>", "listen host (overrides CODEX_HUB_HOST)")
  .option("--port <port>", "listen port (overrides CODEX_HUB_PORT)")
  .option("--serve-static <dir>", "serve built web assets from this directory")
  .action(async (options: ServerCommandOptions = {}) => {
    const { startServer } = await import("../server/index.js");
    const handle = await startServer({
      host: options.host,
      port: parsePortOption(options.port),
      staticDirectory: options.serveStatic
    });
    console.error(`codexhub server listening: ${serverUrl(handle.host, handle.port)}`);
    await waitForShutdown();
    await handle.stop();
  });

program
  .command("list")
  .description("List online codexhub workers")
  .action(async () => {
    const data = await apiJson<{ workers?: WorkerSummary[] }>("/api/workers");
    printWorkers((data.workers ?? []).filter((worker) => worker.online));
  });

program
  .command("threads")
  .description("List local Codex threads for the current directory")
  .option("--show <count>", "number of recent threads to show", "20")
  .action(async (options: ThreadsCommandOptions = {}) => {
    const limit = parsePositiveIntegerOption(options.show, "show");
    const threads = await listLoadableCodexThreads(commandCwd(), { limit });
    printCodexSessions(threads);
  });

program
  .command("delete")
  .argument("<target>", "thread index, full id, or unique id prefix to delete")
  .description("Delete a thread")
  .action(async (target: string) => {
    const { threads } = await listWorkerThreads();
    const thread = resolveThreadTarget(target, threads);
    await apiJson(`/api/threads/${encodeURIComponent(thread.threadId)}`, { method: "DELETE" });
    console.log(`Deleted ${formatThread(thread)}`);
  });

registerCodexHubWorkerCommands(program);

const taskCommand = program
  .command("task")
  .description("Manage codexhub task YAML files")
  .action(() => {
    taskCommand.help();
  });

taskCommand
  .command("list")
  .argument("[thread]", "optional thread index, full id, or unique id prefix")
  .description("List local task YAML files; server connection is optional")
  .action(async (thread?: string) => {
    const { threads, online } = await tryListThreadsForTaskList();
    if (thread && !online) throw new Error(`Cannot filter by thread while server is offline: ${apiBase()}`);
    const target = thread ? resolveThreadTarget(thread, threads) : undefined;
    await printTasks(threads, { serverOnline: online, target, cwd: commandCwd() });
  });

taskCommand
  .command("template")
  .argument("[name]", "task name", "daily-summary")
  .description("Create a task YAML template")
  .action(async (name: string) => {
    await createTaskTemplate(name);
  });

taskCommand
  .command("start")
  .option("--interval-ms <ms>", "task scheduler scan interval in milliseconds")
  .description("Start the local task scheduler; cron schedules are read from task YAML files")
  .action(async (options: TaskCommandOptions = {}) => {
    await startTaskScheduler(options);
  });

taskCommand
  .command("run")
  .argument("<task_yaml_path>", "task YAML file to run once")
  .description("Run one task YAML file immediately")
  .action(async (taskYamlPath: string) => {
    await runTaskFile(taskYamlPath);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function apiJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init);
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function tryListThreads() {
  try {
    return { online: true, ...(await listWorkerThreads()) };
  } catch {
    return { online: false, threads: [] };
  }
}

async function listWorkerThreads() {
  const data = await apiJson<{ workers?: WorkerSummary[] }>("/api/workers");
  return { threads: workerThreads(data.workers) };
}

function workerThreads(workers: WorkerSummary[] | undefined) {
  const byId = new Map<string, ThreadSummary>();
  for (const worker of workers ?? []) {
    for (const thread of worker.threads ?? []) byId.set(thread.threadId, thread);
    if (worker.currentThread) byId.set(worker.currentThread.threadId, worker.currentThread);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function tryListThreadsForTaskList() {
  if (!shouldProbeServerForTaskList()) return { online: false, threads: [] };
  return tryListThreads();
}

function shouldProbeServerForTaskList() {
  const source = program.getOptionValueSource("server");
  return source !== "default" || Boolean(process.env.CODEX_HUB_SERVER_URL);
}

function apiUrl(path: string) {
  return new URL(path, apiBase()).toString();
}

function apiBase() {
  const options = program.opts<{ server: string }>();
  return options.server;
}

function resolveCommandPath(...segments: string[]) {
  return path.resolve(commandCwd(), ...segments);
}

async function printThreads(threads: ThreadSummary[]) {
  if (!threads.length) {
    console.log("No threads.");
    return;
  }
  const taskCounts = await taskCountsByThread(threads);
  console.table(threads.map((thread) => ({
    thread: thread.threadId ? thread.threadId.slice(0, 8) : "",
    status: thread.status,
    runtime: formatRuntime(thread),
    tasks: taskCounts.get(thread.threadId) ?? 0,
    folder: thread.workingDirectory,
    title: thread.title
  })));
}

function printWorkers(workers: WorkerSummary[]) {
  if (!workers.length) {
    console.log("No connected codexhub.");
    return;
  }
  console.table(workers.map((worker) => ({
    worker: worker.name ?? worker.workerId.slice(0, 8),
    status: worker.currentThread?.status ?? "idle",
    folder: worker.workingDirectory,
    thread: worker.currentThreadId ? worker.currentThreadId.slice(0, 8) : "",
    title: worker.currentThread?.title ?? ""
  })));
}

function printCodexSessions(threads: CodexSessionSummary[]) {
  if (!threads.length) {
    console.log("No Codex threads for this directory.");
    return;
  }
  console.table(threads.map((thread) => ({
    updated: formatLocalTime(thread.updatedAt),
    threadId: thread.threadId,
    title: truncate(singleLine(thread.firstUserMessage) || "(untitled)", 96),
    messages: thread.messageCount,
    artifacts: thread.artifactCount
  })));
}

function formatRuntime(thread: ThreadSummary) {
  if (!thread.runtime) return "unavailable";
  const state = thread.runtime.runnable ? "runnable" : "unavailable";
  const worker = thread.runtime.workerId ? `:${thread.runtime.name ?? thread.runtime.workerId.slice(0, 8)}` : "";
  return `${state}${worker}`;
}

function resolveThreadTarget(target: string, threads: ThreadSummary[]) {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("Missing thread target.");

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed);
    const thread = threads[index];
    if (!thread) {
      throw new Error(`No server-mirrored thread at index ${index}.`);
    }
    return thread;
  }

  const matches = threads.filter((thread) => thread.threadId.startsWith(trimmed));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error([
      `Thread target "${trimmed}" is ambiguous. Matching threads:`,
      ...matches.map((thread) => `  ${formatThread(thread)}`)
    ].join("\n"));
  }

  throw new Error(`Server-mirrored thread not found: ${trimmed}.`);
}

function formatThread(thread: ThreadSummary) {
  return `${thread.threadId.slice(0, 8)} (${thread.workingDirectory}, ${thread.title})`;
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

async function startTaskScheduler(options: TaskCommandOptions) {
  const cwd = commandCwd();
  console.error(`codexhub task worker starting: ${cwd}`);
  const worker = await startHeadlessCodexhubWorker({
    apiBase: apiBase(),
    cwd,
    readyLabel: "codexhub task worker ready"
  });
  await restoreSingleTaskThread(worker, cwd);
  const scheduler = new CodexhubTaskScheduler({
    workspace: cwd,
    scanIntervalMs: parseIntervalMs(options.intervalMs),
    runner: async (task) => sendTaskTurn(worker, task)
  });
  try {
    scheduler.start();
    console.error(`codexhub task scheduler started: ${cwd}`);
    await Promise.race([
      waitForShutdown(),
      worker.wait().then(({ code, signal }) => {
        throw new Error(`codexhub task worker exited: code=${code ?? ""} signal=${signal ?? ""}`);
      })
    ]);
  } finally {
    scheduler.stop();
    await worker.stop();
  }
}

async function restoreSingleTaskThread(worker: HeadlessCodexhubWorkerHandle, workspace: string) {
  const tasks = await loadTaskFiles([workspace]);
  const threadIds = uniqueStrings(tasks
    .filter((task) => task.valid && task.enabled && task.thread)
    .map((task) => task.thread!));

  if (threadIds.length === 0) return;
  if (threadIds.length > 1) {
    console.error("multiple task threads configured; waiting for schedule");
    return;
  }

  const threadId = await worker.ensureThread(threadIds[0]);
  console.error(`codexhub task worker restored thread: ${threadId}`);
}

async function sendTaskTurn(worker: HeadlessCodexhubWorkerHandle, task: { input: string; thread?: string }) {
  if (task.thread) {
    await worker.runTurn(task.input, task.thread);
    return;
  }

  await worker.runTurn(task.input);
}

async function runTaskFile(taskYamlPath: string) {
  const scheduler = new CodexhubTaskScheduler({
    workspace: commandCwd()
  });
  const result = await scheduler.runFile(taskYamlPath);
  console.log(`Task ${result.status}: ${result.task}`);
}

async function createTaskTemplate(taskName: string) {
  const safeName = safeTaskName(taskName);
  const directory = resolveCommandPath(".codexp", "tasks");
  const filePath = path.join(directory, `${safeName}.yaml`);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, taskTemplate(safeName), { encoding: "utf8", flag: "wx" });
  console.log(`Created ${filePath}`);
}

async function printTasks(
  threads: ThreadSummary[],
  options: { serverOnline: boolean; target?: ThreadSummary; cwd: string }
) {
  const workspaces = options.target
    ? [options.target.workingDirectory]
    : uniqueStrings([options.cwd, ...threads.map((thread) => thread.workingDirectory)]);
  const tasks = await loadTaskFiles(workspaces);
  const rows = tasks.map((task) => ({
    task: task.name,
    enabled: task.valid ? (task.enabled ? "yes" : "no") : "invalid",
    schedule: task.schedule,
    thread: task.thread ?? "",
    server: options.serverOnline ? "online" : "offline",
    file: path.relative(task.workspace, task.filePath) || task.filePath
  }));
  if (!rows.length) {
    console.log("No tasks.");
    return;
  }
  console.table(rows);
}

async function taskCountsByThread(threads: ThreadSummary[]) {
  const counts = new Map<string, number>();
  const tasks = await loadTaskFiles(uniqueStrings(threads.map((thread) => thread.workingDirectory)));
  for (const task of tasks) {
    if (!task.valid || !task.enabled) continue;
    const target = resolveTaskThread(task, threads);
    if (target) counts.set(target.threadId, (counts.get(target.threadId) ?? 0) + 1);
  }
  return counts;
}

function commandCwd() {
  return path.resolve(process.cwd());
}

function parseIntervalMs(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid interval: ${value}`);
  return parsed;
}

function parsePortOption(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function parsePositiveIntegerOption(value: string | undefined, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
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

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
