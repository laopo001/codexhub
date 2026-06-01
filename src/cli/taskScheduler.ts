import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { CodexRecord } from "../core/codexRecord.js";
import { recordsToViews } from "../core/codexRecordView.js";

export type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  runtime?: { workerId?: string; name?: string; online: boolean; runnable: boolean };
  status: "running" | "idle";
  running: boolean;
  title: string;
  updatedAt: string;
};

type ThreadDetail = ThreadSummary & {
  records: CodexRecord[];
};

type TaskDefinition = {
  version: 1;
  name: string;
  enabled: boolean;
  schedule: string;
  thread?: string;
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
  threadId?: string;
};

type TaskRunRecord = {
  version: 1;
  runId: string;
  task: string;
  taskFile: string;
  workspace: string;
  status: "completed" | "failed" | "skipped";
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  reason?: string;
  threadId?: string;
  input: string;
  conversation?: {
    lastUserMessage: string;
    lastAssistantMessage: string;
  };
  message?: string;
};

type SchedulerOptions = {
  apiBase: string;
  workspace: string;
  workerId?: string;
  scanIntervalMs?: number;
};

const defaultTimezone = "Asia/Shanghai";
const defaultScanIntervalMs = 30_000;

export class CodexpTaskScheduler {
  private readonly queuedTasks = new Set<string>();
  private readonly runningTasks = new Set<string>();
  private readonly threadQueues = new Map<string, Promise<void>>();
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
      await appendTaskRun(task, {
        runId: randomUUID(),
        status: "skipped",
        reason: "already_queued_or_running"
      });
      return { task: task.name, filePath: task.filePath, status: "skipped" };
    }

    const thread = await this.resolveTaskThread(task);
    if (!thread) return { task: task.name, filePath: task.filePath, status: "skipped" };

    const runId = randomUUID();
    const queuedAt = localTimestamp();
    this.runningTasks.add(task.key);
    try {
      const status = await this.runTask(task, thread.threadId, runId, queuedAt);
      return { task: task.name, filePath: task.filePath, status, threadId: thread.threadId };
    } finally {
      this.runningTasks.delete(task.key);
    }
  }

  private async enqueue(task: LoadedTask) {
    if (this.queuedTasks.has(task.key) || this.runningTasks.has(task.key)) {
      await appendTaskRun(task, {
        runId: randomUUID(),
        status: "skipped",
        reason: "already_queued_or_running"
      });
      return;
    }

    const thread = await this.resolveTaskThread(task);
    if (!thread) return;

    const runId = randomUUID();
    const queuedAt = localTimestamp();
    this.queuedTasks.add(task.key);

    const previous = this.threadQueues.get(thread.threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.runTask(task, thread.threadId, runId, queuedAt);
      });
    this.threadQueues.set(thread.threadId, next);
    void next.finally(() => {
      if (this.threadQueues.get(thread.threadId) === next) this.threadQueues.delete(thread.threadId);
    });
  }

  private async resolveTaskThread(task: LoadedTask): Promise<ThreadSummary | null> {
    const threads = (await this.listThreads()).filter((thread) => thread.workingDirectory === task.workspace);
    const target = task.thread?.trim();
    if (target) {
      const matches = threads.filter((thread) => thread.threadId.startsWith(target));
      if (matches.length === 1) return matches[0];
      await appendTaskRun(task, {
        runId: randomUUID(),
        status: "skipped",
        reason: matches.length ? "ambiguous_thread" : "thread_not_found",
        message: target
      });
      return null;
    }

    const workerCurrent = await this.currentWorkerThread(threads);
    if (workerCurrent) return workerCurrent;
    if (threads.length === 1) return threads[0];
    await appendTaskRun(task, {
      runId: randomUUID(),
      status: "skipped",
      reason: threads.length ? "ambiguous_thread" : "thread_not_found"
    });
    return null;
  }

  private async currentWorkerThread(threads: ThreadSummary[]) {
    if (!this.options.workerId) return null;
    const workers = await apiJson<{ workers?: Array<{ workerId: string; currentThreadId?: string }> }>(this.options.apiBase, "/api/workers");
    const currentThreadId = workers.workers?.find((worker) => worker.workerId === this.options.workerId)?.currentThreadId;
    return currentThreadId ? threads.find((thread) => thread.threadId === currentThreadId) ?? null : null;
  }

  private async runTask(task: LoadedTask, threadId: string, runId: string, queuedAt: string): Promise<"completed" | "failed"> {
    this.queuedTasks.delete(task.key);
    this.runningTasks.add(task.key);
    const startedAt = localTimestamp();
    try {
      await this.waitForThreadIdle(threadId);
      await postTurn(this.options.apiBase, threadId, task.input);
      await this.waitForThreadIdle(threadId, true);
      const thread = await getThread(this.options.apiBase, threadId).catch(() => null);
      await appendTaskRun(task, {
        runId,
        status: "completed",
        queuedAt,
        startedAt,
        completedAt: localTimestamp(),
        threadId,
        conversation: taskConversation(thread)
      });
      return "completed";
    } catch (error) {
      const thread = await getThread(this.options.apiBase, threadId).catch(() => null);
      await appendTaskRun(task, {
        runId,
        status: "failed",
        queuedAt,
        startedAt,
        completedAt: localTimestamp(),
        threadId,
        conversation: taskConversation(thread),
        message: error instanceof Error ? error.message : String(error)
      });
      return "failed";
    } finally {
      this.runningTasks.delete(task.key);
    }
  }

  private async waitForThreadIdle(threadId: string, afterStart = false) {
    const startedAt = Date.now();
    let observedRunning = false;
    while (true) {
      const thread = await getThread(this.options.apiBase, threadId);
      if (thread.running) observedRunning = true;
      if (!thread.running && (!afterStart || observedRunning || Date.now() - startedAt > 1500)) return;
      await delay(1000);
    }
  }

  private async listThreads() {
    const data = await apiJson<{ threads?: ThreadSummary[] }>(this.options.apiBase, "/api/threads");
    return data.threads ?? [];
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
    && (record.thread == null || typeof record.thread === "string");
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

async function postTurn(apiBase: string, threadId: string, input: string) {
  const response = await fetch(apiUrl(apiBase, `/api/threads/${encodeURIComponent(threadId)}/turn`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, source: "task" })
  });
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
}

async function getThread(apiBase: string, threadId: string) {
  return apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
}

async function apiJson<T = unknown>(apiBase: string, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(apiBase, pathname), init);
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function apiUrl(apiBase: string, pathname: string) {
  return new URL(pathname, apiBase).toString();
}

async function appendTaskRun(
  task: LoadedTask,
  run: Omit<TaskRunRecord, "version" | "task" | "taskFile" | "workspace" | "input">
) {
  const directory = path.join(task.workspace, ".codexp", "task-runs");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${safeTaskName(task.name)}.jsonl`);
  const completedAt = run.completedAt ?? (run.status === "skipped" ? localTimestamp() : undefined);
  const record: TaskRunRecord = {
    version: 1,
    task: task.name,
    taskFile: task.filePath,
    workspace: task.workspace,
    input: task.input,
    ...run,
    completedAt
  };
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function taskConversation(thread: ThreadDetail | null): TaskRunRecord["conversation"] | undefined {
  if (!thread) return undefined;
  const views = recordsToViews(thread.records);
  const lastUserMessage = [...views].reverse().find((view) => view.role === "user")?.text ?? "";
  const lastAssistantMessage = [...views].reverse().find((view) => view.role === "codex")?.text ?? "";
  if (!lastUserMessage && !lastAssistantMessage) return undefined;
  return { lastUserMessage, lastAssistantMessage };
}

function localTimestamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
  return [
    date.getFullYear(),
    "-",
    pad2(date.getMonth() + 1),
    "-",
    pad2(date.getDate()),
    "T",
    pad2(date.getHours()),
    ":",
    pad2(date.getMinutes()),
    ":",
    pad2(date.getSeconds()),
    offset
  ].join("");
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
