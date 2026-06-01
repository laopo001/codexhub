import { Command } from "commander";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { registerConnectCommand } from "./codexpConnect.js";

type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  runtime?: { workerId?: string; name?: string; online: boolean; runnable: boolean };
  status: "running" | "idle";
  running: boolean;
  title: string;
  updatedAt: string;
};

type TaskFile = {
  workspace: string;
  filePath: string;
  valid: boolean;
  name: string;
  enabled: boolean;
  schedule: string;
  thread?: string;
  error?: string;
};

const program = new Command()
  .name("codexp")
  .description("Manage codex-proxy threads")
  .option("--api <url>", "codex-proxy API URL", process.env.CODEX_PROXY_API_URL ?? "http://127.0.0.1:18788")
  .option("--cwd <path>", "directory used by folder-relative commands", process.env.CODEX_PROXY_CWD ?? process.env.INIT_CWD ?? process.cwd());

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
  .argument("[first]", "ls, template, or thread target")
  .argument("[second]", "ls or template name")
  .description("Manage codexp task YAML files")
  .action(async (first?: string, second?: string) => {
    const action = taskAction(first, second);
    if (action.kind === "template") {
      await createTaskTemplate(action.name ?? "daily-summary");
      return;
    }
    if (action.kind === "ls") {
      const data = await apiJson<{ threads?: ThreadSummary[] }>("/api/threads");
      const threads = data.threads ?? [];
      const target = action.target ? resolveThreadTarget(action.target, threads) : undefined;
      await printTasks(threads, target);
      return;
    }
    throw new Error('Usage: codexp task ls | codexp task <thread> ls | codexp task template [name]');
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
  const options = program.opts<{ api: string }>();
  return new URL(path, options.api).toString();
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
  if (!thread.runtime) return "offline";
  const state = thread.runtime.runnable ? "online" : "offline";
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

async function createTaskTemplate(taskName: string) {
  const safeName = safeTaskName(taskName);
  const directory = resolveCommandPath(".codexp", "tasks");
  const filePath = path.join(directory, `${safeName}.yaml`);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, taskTemplate(safeName), { encoding: "utf8", flag: "wx" });
  console.log(`Created ${filePath}`);
}

function taskTemplate(name: string) {
  return `version: 1
name: ${name}
enabled: true
schedule: "0 9 * * *"
thread:
input: |
  检查这个项目昨天到今天的变更，给我总结风险和下一步。
`;
}

function safeTaskName(name: string) {
  return name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "daily-summary";
}

function taskAction(first?: string, second?: string):
  | { kind: "template"; name?: string }
  | { kind: "ls"; target?: string }
  | { kind: "unknown" } {
  if (!first || first === "ls" || first === "list") return { kind: "ls", target: second };
  if (first === "template") return { kind: "template", name: second };
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

async function loadTaskFiles(workspaces: string[]) {
  const tasks: TaskFile[] = [];
  for (const workspace of workspaces) {
    const directory = path.join(workspace, ".codexp", "tasks");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort()) {
      const filePath = path.join(directory, entry);
      tasks.push(await readTaskFile(workspace, filePath));
    }
  }
  return tasks;
}

async function readTaskFile(workspace: string, filePath: string): Promise<TaskFile> {
  try {
    const parsed = YAML.parse(await readFile(filePath, "utf8"));
    if (isTaskFile(parsed)) {
      return {
        workspace,
        filePath,
        valid: true,
        name: parsed.name,
        enabled: parsed.enabled,
        schedule: parsed.schedule,
        thread: parsed.thread?.trim() || undefined
      };
    }
    return invalidTask(workspace, filePath, "invalid_schema");
  } catch (error) {
    return invalidTask(workspace, filePath, error instanceof Error ? error.message : String(error));
  }
}

function invalidTask(workspace: string, filePath: string, error: string): TaskFile {
  return {
    workspace,
    filePath,
    valid: false,
    name: path.basename(filePath, path.extname(filePath)),
    enabled: false,
    schedule: "",
    error
  };
}

function isTaskFile(value: unknown): value is { name: string; enabled: boolean; schedule: string; thread?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.name === "string"
    && typeof record.enabled === "boolean"
    && typeof record.schedule === "string"
    && typeof record.input === "string"
    && (record.thread == null || typeof record.thread === "string");
}

function resolveTaskThread(task: TaskFile, threads: ThreadSummary[]) {
  if (!task.valid) return null;
  const workspaceThreads = threads.filter((thread) => thread.workingDirectory === task.workspace);
  if (task.thread) {
    const matches = workspaceThreads.filter((thread) => thread.threadId.startsWith(task.thread!));
    return matches.length === 1 ? matches[0] : null;
  }
  return workspaceThreads.length === 1 ? workspaceThreads[0] : null;
}

function taskTargetLabel(task: TaskFile, threads: ThreadSummary[], selected?: ThreadSummary) {
  if (!task.valid) return task.error ?? "invalid";
  const workspaceThreads = threads.filter((thread) => thread.workingDirectory === task.workspace);
  if (task.thread) {
    const matches = workspaceThreads.filter((thread) => thread.threadId.startsWith(task.thread!));
    if (matches.length === 0) return "missing";
    if (matches.length > 1) return "ambiguous";
    if (selected) return matches[0].threadId === selected.threadId ? "this" : `other:${matches[0].threadId.slice(0, 8)}`;
    return matches[0].threadId.slice(0, 8);
  }
  if (workspaceThreads.length === 0) return "create";
  if (workspaceThreads.length > 1) return "ambiguous";
  if (selected) return workspaceThreads[0].threadId === selected.threadId ? "this" : `other:${workspaceThreads[0].threadId.slice(0, 8)}`;
  return workspaceThreads[0].threadId.slice(0, 8);
}

function commandCwd() {
  const options = program.opts<{ cwd: string }>();
  return path.resolve(options.cwd);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
