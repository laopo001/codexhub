import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  runtime?: { workerId?: string; name?: string; online: boolean; runnable: boolean };
  status: "running" | "idle";
  running: boolean;
  title: string;
  updatedAt: string;
};

type TaskDefinition = {
  version: 1;
  name: string;
  enabled: boolean;
  schedule: string;
  thread?: string;
  instance?: string;
  input: string;
};

export type TaskFile = {
  workspace: string;
  filePath: string;
  valid: boolean;
  name: string;
  enabled: boolean;
  schedule: string;
  input?: string;
  thread?: string;
  instance?: string;
  error?: string;
};

type LoadedTask = TaskFile & {
  key: string;
  valid: true;
  input: string;
};

export type TaskRunResult = {
  task: string;
  filePath: string;
  status: "completed" | "failed" | "skipped";
};

export type TaskRunner = (task: {
  workspace: string;
  filePath: string;
  name: string;
  input: string;
  thread?: string;
}) => Promise<void>;

type SchedulerOptions = {
  workspace: string;
  scanIntervalMs?: number;
  runner?: TaskRunner;
};

const defaultTimezone = "Asia/Shanghai";
const defaultScanIntervalMs = 30_000;

export class CodexpTaskScheduler {
  private readonly queuedTasks = new Set<string>();
  private readonly runningTasks = new Set<string>();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly triggeredMinutes = new Map<string, string>();
  private readonly scanIntervalMs: number;
  private interval: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(private readonly options: SchedulerOptions) {
    this.scanIntervalMs = options.scanIntervalMs ?? (Number(process.env.CODEX_PROXY_TASK_SCAN_INTERVAL_MS || 0) || defaultScanIntervalMs);
  }

  start() {
    if (this.interval) return;
    void this.scan(new Date());
    this.interval = setInterval(() => void this.scan(new Date()), this.scanIntervalMs);
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async scan(now = new Date()) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const tasks = (await loadTaskFiles([this.options.workspace]))
        .filter((task): task is LoadedTask => task.valid && task.enabled && typeof task.input === "string" && task.input.trim().length > 0)
        .map((task) => ({ ...task, key: `${task.workspace}:${task.filePath}` }));

      for (const task of tasks.sort((left, right) => left.filePath.localeCompare(right.filePath))) {
        if (!shouldTrigger(task, now)) continue;
        const minuteKey = triggerMinuteKey(now, defaultTimezone);
        if (this.triggeredMinutes.get(task.key) === minuteKey) continue;
        this.triggeredMinutes.set(task.key, minuteKey);
        await this.enqueue(task);
      }
    } finally {
      this.scanning = false;
    }
  }

  async runFile(filePath: string): Promise<TaskRunResult> {
    const absolutePath = path.resolve(this.options.workspace, filePath);
    const task = await loadTaskFile(absolutePath, this.options.workspace);
    if (!task.valid || typeof task.input !== "string" || task.input.trim().length === 0) {
      throw new Error(`Invalid task file: ${task.error ?? "invalid_schema"}`);
    }
    const loaded: LoadedTask = {
      ...task,
      valid: true,
      input: task.input,
      key: `${task.workspace}:${task.filePath}`
    };
    return this.runImmediate(loaded);
  }

  private async runImmediate(task: LoadedTask): Promise<TaskRunResult> {
    if (this.queuedTasks.has(task.key) || this.runningTasks.has(task.key)) {
      return { task: task.name, filePath: task.filePath, status: "skipped" };
    }

    this.runningTasks.add(task.key);
    try {
      const status = await this.runTask(task);
      return { task: task.name, filePath: task.filePath, status };
    } finally {
      this.runningTasks.delete(task.key);
    }
  }

  private async enqueue(task: LoadedTask) {
    if (this.queuedTasks.has(task.key) || this.runningTasks.has(task.key)) {
      return;
    }

    this.queuedTasks.add(task.key);

    const previous = this.taskQueues.get(task.key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.runTask(task);
      });
    this.taskQueues.set(task.key, next);
    void next.finally(() => {
      if (this.taskQueues.get(task.key) === next) this.taskQueues.delete(task.key);
    });
  }

  private async runTask(task: LoadedTask): Promise<"completed" | "failed"> {
    this.queuedTasks.delete(task.key);
    this.runningTasks.add(task.key);
    try {
      if (this.options.runner) {
        await this.options.runner(task);
      } else {
        await runCodexExec(task.workspace, task.input, task.thread);
      }
      return "completed";
    } catch (error) {
      return "failed";
    } finally {
      this.runningTasks.delete(task.key);
    }
  }

}

export function taskTemplate(name: string) {
  return `version: 1
name: ${name}
enabled: true
schedule: "0 9 * * *"
thread:
input: |
  检查这个项目昨天到今天的变更，给我总结风险和下一步。
`;
}

export function safeTaskName(name: string) {
  return name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "daily-summary";
}

export async function loadTaskFiles(workspaces: string[]) {
  const tasks: TaskFile[] = [];
  for (const workspace of uniqueStrings(workspaces).map((item) => path.resolve(item))) {
    const directory = path.join(workspace, ".codexp", "tasks");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort()) {
      const filePath = path.join(directory, entry);
      tasks.push(await loadTaskFile(filePath, workspace));
    }
  }
  return tasks;
}

export async function loadTaskFile(filePath: string, fallbackWorkspace: string) {
  const absolutePath = path.resolve(filePath);
  return readTaskFile(taskWorkspaceFromPath(absolutePath, fallbackWorkspace), absolutePath);
}

export function resolveTaskThread(task: TaskFile, threads: ThreadSummary[]) {
  if (!task.valid) return null;
  const workspaceThreads = threads.filter((thread) => thread.workingDirectory === task.workspace);
  if (task.thread) {
    const matches = workspaceThreads.filter((thread) => thread.threadId.startsWith(task.thread!));
    return matches.length === 1 ? matches[0] : null;
  }
  return workspaceThreads.length === 1 ? workspaceThreads[0] : null;
}

async function readTaskFile(workspace: string, filePath: string): Promise<TaskFile> {
  try {
    const parsed = YAML.parse(await readFile(filePath, "utf8"));
    if (isTaskDefinition(parsed)) {
      return {
        workspace,
        filePath,
        valid: true,
        name: parsed.name,
        enabled: parsed.enabled,
        schedule: parsed.schedule,
        input: parsed.input,
        thread: parsed.thread?.trim() || parsed.instance?.trim() || undefined,
        instance: parsed.instance?.trim() || undefined
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

function taskWorkspaceFromPath(filePath: string, fallbackWorkspace: string) {
  const parts = filePath.split(path.sep);
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] === ".codexp" && parts[index + 1] === "tasks") {
      const workspace = parts.slice(0, index).join(path.sep) || path.sep;
      return path.resolve(workspace);
    }
  }
  return path.resolve(fallbackWorkspace);
}

function isTaskDefinition(value: unknown): value is TaskDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.name === "string"
    && record.name.length > 0
    && typeof record.enabled === "boolean"
    && typeof record.schedule === "string"
    && typeof record.input === "string"
    && record.input.trim().length > 0
    && (record.thread == null || typeof record.thread === "string")
    && (record.instance == null || typeof record.instance === "string");
}

function shouldTrigger(task: LoadedTask, now: Date) {
  const parts = cronParts(task.schedule);
  if (!parts) return false;
  const local = localDateParts(now, defaultTimezone);
  return parts.minute.has(local.minute)
    && parts.hour.has(local.hour)
    && parts.dayOfMonth.has(local.dayOfMonth)
    && parts.month.has(local.month)
    && parts.dayOfWeek.has(local.dayOfWeek);
}

function cronParts(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, (value) => value === 7 ? 0 : value)
  };
}

function parseCronField(field: string, min: number, max: number, normalize: (value: number) => number = (value) => value) {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const [rangePart, stepPart] = rawPart.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) continue;
    const [start, end] = rangeBounds(rangePart, min, max);
    if (start == null || end == null) continue;
    for (let value = start; value <= end; value += step) {
      if (value >= min && value <= max) values.add(normalize(value));
    }
  }
  return values;
}

function rangeBounds(value: string, min: number, max: number): [number | null, number | null] {
  if (value === "*") return [min, max];
  if (value.includes("-")) {
    const [start, end] = value.split("-").map(Number);
    return Number.isInteger(start) && Number.isInteger(end) && start <= end ? [start, end] : [null, null];
  }
  const number = Number(value);
  return Number.isInteger(number) ? [number, number] : [null, null];
}

function localDateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    weekday: "short",
    hourCycle: "h23",
    hour12: false
  }).formatToParts(date);
  const getNumber = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  return {
    minute: getNumber("minute"),
    hour: getNumber("hour"),
    year: getNumber("year"),
    dayOfMonth: getNumber("day"),
    month: getNumber("month"),
    dayOfWeek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday)
  };
}

function triggerMinuteKey(date: Date, timezone: string) {
  const local = localDateParts(date, timezone);
  return `${local.year}-${local.month}-${local.dayOfMonth}-${local.hour}-${local.minute}`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

type CodexExecResult = {
  output: string;
  workerId?: string;
  threadId?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

class CodexExecError extends Error {
  constructor(
    message: string,
    readonly result: CodexExecResult
  ) {
    super(message);
  }
}

function runCodexExec(workspace: string, input: string, threadId?: string): Promise<CodexExecResult> {
  return new Promise((resolve, reject) => {
    const args = threadId
      ? ["exec", "-C", workspace, "resume", threadId, "-"]
      : ["exec", "-C", workspace, "-"];
    const child = spawn("codex", args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      const output = `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`.trim();
      const result = { output, exitCode, signal };
      if (exitCode === 0) resolve(result);
      else reject(new CodexExecError(`codex exec failed${exitCode == null ? "" : ` with exit code ${exitCode}`}`, result));
    });
    child.stdin.end(input);
  });
}
