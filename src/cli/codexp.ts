import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerConnectCommand } from "./codexpConnect.js";
import {
  CodexpTaskScheduler,
  loadTaskFiles,
  resolveTaskThread,
  safeTaskName,
  taskTargetLabel,
  taskTemplate,
  type ThreadSummary
} from "./taskScheduler.js";

type TaskCommandOptions = {
  intervalMs?: string;
};

const program = new Command()
  .name("codexp")
  .description("Manage codex-proxy threads")
  .option("--api <url>", "codex-proxy API URL", process.env.CODEX_PROXY_API_URL ?? "http://127.0.0.1:18788")
  .option("--cwd <path>", "directory used by folder-relative commands", process.cwd());

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

program
  .command("task")
  .argument("[first]", "ls, template, run, daemon, or thread target")
  .argument("[second]", "ls or template name")
  .option("--interval-ms <ms>", "task daemon scan interval in milliseconds")
  .description("Manage codexp task YAML files")
  .action(async (first?: string, second?: string, options: TaskCommandOptions = {}) => {
    const action = taskAction(first, second);
    if (action.kind === "template") {
      await createTaskTemplate(action.name ?? "daily-summary");
      return;
    }
    if (action.kind === "run") {
      await runTaskScan(options);
      return;
    }
    if (action.kind === "daemon") {
      await runTaskDaemon(options);
      return;
    }
    if (action.kind === "ls") {
      const data = await apiJson<{ threads?: ThreadSummary[] }>("/api/threads");
      const threads = data.threads ?? [];
      const target = action.target ? resolveThreadTarget(action.target, threads) : undefined;
      await printTasks(threads, target);
      return;
    }
    throw new Error('Usage: codexp task ls | codexp task <thread> ls | codexp task template [name] | codexp task run | codexp task daemon');
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

function apiUrl(path: string) {
  return new URL(path, apiBase()).toString();
}

function apiBase() {
  const options = program.opts<{ api: string }>();
  return options.api;
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

async function runTaskScan(options: TaskCommandOptions) {
  const scheduler = new CodexpTaskScheduler({
    apiBase: apiBase(),
    workspace: commandCwd(),
    scanIntervalMs: parseIntervalMs(options.intervalMs)
  });
  await scheduler.scan(new Date());
}

async function runTaskDaemon(options: TaskCommandOptions) {
  const scheduler = new CodexpTaskScheduler({
    apiBase: apiBase(),
    workspace: commandCwd(),
    scanIntervalMs: parseIntervalMs(options.intervalMs)
  });
  scheduler.start();
  console.error(`codexp task daemon started: ${commandCwd()}`);
  await waitForShutdown();
  scheduler.stop();
}

async function createTaskTemplate(taskName: string) {
  const safeName = safeTaskName(taskName);
  const directory = resolveCommandPath(".codexp", "tasks");
  const filePath = path.join(directory, `${safeName}.yaml`);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, taskTemplate(safeName), { encoding: "utf8", flag: "wx" });
  console.log(`Created ${filePath}`);
}

function taskAction(first?: string, second?: string):
  | { kind: "template"; name?: string }
  | { kind: "ls"; target?: string }
  | { kind: "run" }
  | { kind: "daemon" }
  | { kind: "unknown" } {
  if (!first || first === "ls" || first === "list") return { kind: "ls", target: second };
  if (first === "template") return { kind: "template", name: second };
  if (first === "run" || first === "run-once" || first === "once") return { kind: "run" };
  if (first === "daemon" || first === "watch") return { kind: "daemon" };
  if (second === "ls" || second === "list") return { kind: "ls", target: first };
  return { kind: "unknown" };
}

async function printTasks(threads: ThreadSummary[], target?: ThreadSummary) {
  const workspaces = target
    ? [target.workingDirectory]
    : uniqueStrings([commandCwd(), ...threads.map((thread) => thread.workingDirectory)]);
  const tasks = await loadTaskFiles(workspaces);
  const rows = tasks.map((task) => ({
    task: task.name,
    enabled: task.valid ? (task.enabled ? "yes" : "no") : "invalid",
    schedule: task.schedule,
    thread: task.thread ?? "",
    target: taskTargetLabel(task, threads, target),
    file: path.relative(task.workspace, task.filePath) || task.filePath,
    folder: task.workspace
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
