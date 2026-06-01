#!/usr/bin/env tsx
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "../core/dotenv.js";
import { registerConnectCommand } from "./codexpConnect.js";
import {
  CodexpTaskScheduler,
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

await loadDotEnv();

const program = new Command()
  .name("codexp")
  .description("Manage codex-proxy threads")
  .option("--server <url>", "codex-proxy server URL", defaultServerUrl())
  .option("--cwd <path>", "directory used by folder-relative commands", process.cwd());

program
  .command("server")
  .description("Start the codex-proxy API server")
  .option("--host <host>", "listen host (overrides CODEX_PROXY_HOST)")
  .option("--port <port>", "listen port (overrides CODEX_PROXY_PORT)")
  .option("--serve-static <dir>", "serve built web assets from this directory")
  .action(async (options: ServerCommandOptions = {}) => {
    const { startServer } = await import("../server/index.js");
    const handle = await startServer({
      host: options.host,
      port: parsePortOption(options.port),
      staticDirectory: options.serveStatic
    });
    console.error(`codex-proxy server listening: ${serverUrl(handle.host, handle.port)}`);
    await waitForShutdown();
    await handle.stop();
  });

program
  .command("list")
  .description("List running/restored codex-proxy threads")
  .action(async () => {
    const data = await apiJson<{ threads?: ThreadSummary[] }>("/api/threads");
    await printThreads(data.threads ?? []);
  });

program
  .command("delete")
  .argument("<target>", "thread index, full id, or unique id prefix to delete")
  .description("Delete a thread")
  .action(async (target: string) => {
    const data = await apiJson<{ threads?: ThreadSummary[] }>("/api/threads");
    const thread = resolveThreadTarget(target, data.threads ?? []);
    await apiJson(`/api/threads/${encodeURIComponent(thread.threadId)}`, { method: "DELETE" });
    console.log(`Deleted ${formatThread(thread)}`);
  });

registerConnectCommand(program);

const taskCommand = program
  .command("task")
  .description("Manage codexp task YAML files")
  .action(() => {
    taskCommand.help();
  });

taskCommand
  .command("ls")
  .argument("[thread]", "optional thread index, full id, or unique id prefix")
  .description("List local task YAML files; server connection is optional")
  .action(async (thread?: string) => {
    const { threads, online } = await tryListThreadsForTaskList();
    if (thread && !online) throw new Error(`Cannot filter by thread while server is offline: ${apiBase()}`);
    const target = thread ? resolveThreadTarget(thread, threads) : undefined;
    await printTasks(threads, { serverOnline: online, target });
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
    const data = await apiJson<{ threads?: ThreadSummary[] }>("/api/threads");
    return { online: true, threads: data.threads ?? [] };
  } catch {
    return { online: false, threads: [] };
  }
}

async function tryListThreadsForTaskList() {
  if (!shouldProbeServerForTaskList()) return { online: false, threads: [] };
  return tryListThreads();
}

function shouldProbeServerForTaskList() {
  const source = program.getOptionValueSource("server");
  return source !== "default" || Boolean(process.env.CODEX_PROXY_SERVER_URL);
}

function apiUrl(path: string) {
  return new URL(path, apiBase()).toString();
}

function apiBase() {
  const options = program.opts<{ server: string }>();
  return options.server;
}

function resolveCommandPath(...segments: string[]) {
  const options = program.opts<{ cwd: string }>();
  return path.resolve(options.cwd, ...segments);
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
      throw new Error(`No thread at index ${index}. Run "pnpm codexp list" to see valid targets.`);
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

  throw new Error(`Thread not found: ${trimmed}. Run "pnpm codexp list" to see valid targets.`);
}

function formatThread(thread: ThreadSummary) {
  return `${thread.threadId.slice(0, 8)} (${thread.workingDirectory}, ${thread.title})`;
}

async function startTaskScheduler(options: TaskCommandOptions) {
  const scheduler = new CodexpTaskScheduler({
    apiBase: apiBase(),
    workspace: commandCwd(),
    scanIntervalMs: parseIntervalMs(options.intervalMs)
  });
  scheduler.start();
  console.error(`codexp task scheduler started: ${commandCwd()}`);
  await waitForShutdown();
  scheduler.stop();
}

async function runTaskFile(taskYamlPath: string) {
  const scheduler = new CodexpTaskScheduler({
    apiBase: apiBase(),
    workspace: commandCwd()
  });
  const result = await scheduler.runFile(taskYamlPath);
  console.log(`Task ${result.status}: ${result.task}${result.threadId ? ` (${result.threadId.slice(0, 8)})` : ""}`);
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
  options: { serverOnline: boolean; target?: ThreadSummary }
) {
  const workspaces = options.target
    ? [options.target.workingDirectory]
    : uniqueStrings([commandCwd(), ...threads.map((thread) => thread.workingDirectory)]);
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
  const options = program.opts<{ cwd: string }>();
  return path.resolve(options.cwd);
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

function serverUrl(host: string, port: number) {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}`;
}

function defaultServerUrl() {
  if (process.env.CODEX_PROXY_SERVER_URL) return process.env.CODEX_PROXY_SERVER_URL;
  const host = process.env.CODEX_PROXY_HOST ?? "127.0.0.1";
  const port = process.env.CODEX_PROXY_PORT ?? "18788";
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
