import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import YAML from "yaml";
import type { ThreadHub, ThreadSummary } from "./threadHub.js";
import { recordsToViews } from "./codexRecordView.js";
import { listWorkspaces, type WorkspaceEntry } from "./workspaceState.js";

type TaskDefinition = {
  version: 1;
  name: string;
  enabled: boolean;
  schedule: string;
  thread?: string;
  input: string;
};

type LoadedTask = {
  key: string;
  filePath: string;
  workspace: string;
  task: TaskDefinition;
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

const defaultTimezone = "Asia/Shanghai";
const defaultScanIntervalMs = 30_000;

export class TaskScheduler {
  private readonly queuedTasks = new Set<string>();
  private readonly runningTasks = new Set<string>();
  private readonly threadQueues = new Map<string, Promise<void>>();
  private readonly triggeredMinutes = new Map<string, string>();
  private interval: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    private readonly threads: ThreadHub,
    private readonly defaultWorkingDirectory: string,
    private readonly scanIntervalMs = Number(process.env.CODEX_PROXY_TASK_SCAN_INTERVAL_MS || 0) || defaultScanIntervalMs
  ) {}

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

  async scan(now: Date) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const tasks = await this.loadTasks();
      for (const loaded of tasks.sort(compareLoadedTasks)) {
        if (!shouldTrigger(loaded, now)) continue;
        const minuteKey = triggerMinuteKey(now, defaultTimezone);
        if (this.triggeredMinutes.get(loaded.key) === minuteKey) continue;
        this.triggeredMinutes.set(loaded.key, minuteKey);
        await this.enqueue(loaded);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async loadTasks(): Promise<LoadedTask[]> {
    const workspaces = await this.taskWorkspaces();
    const results: LoadedTask[] = [];
    for (const workspace of workspaces) {
      const taskDirectory = path.join(workspace.path, ".codexp", "tasks");
      let entries: string[];
      try {
        entries = await readdir(taskDirectory);
      } catch {
        continue;
      }
      for (const entry of entries.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort()) {
        const filePath = path.join(taskDirectory, entry);
        const task = await readTask(filePath);
        if (!task || !task.enabled) continue;
        results.push({
          key: `${workspace.path}:${filePath}`,
          filePath,
          workspace: workspace.path,
          task
        });
      }
    }
    return results;
  }

  private async taskWorkspaces(): Promise<WorkspaceEntry[]> {
    const byPath = new Map<string, WorkspaceEntry>();
    for (const workspace of await listWorkspaces(this.defaultWorkingDirectory)) byPath.set(workspace.path, workspace);
    for (const thread of this.threads.listThreads()) {
      byPath.set(thread.workingDirectory, {
        path: thread.workingDirectory,
        name: path.basename(thread.workingDirectory) || thread.workingDirectory,
        lastOpenedAt: thread.updatedAt
      });
    }
    return [...byPath.values()];
  }

  private async enqueue(loaded: LoadedTask) {
    if (this.queuedTasks.has(loaded.key) || this.runningTasks.has(loaded.key)) {
      await appendTaskRun(loaded, {
        runId: randomUUID(),
        status: "skipped",
        reason: "already_queued_or_running"
      });
      return;
    }

    const thread = await this.resolveTaskThread(loaded);
    if (!thread) return;

    const runId = randomUUID();
    const queuedAt = localTimestamp();
    this.queuedTasks.add(loaded.key);

    const previous = this.threadQueues.get(thread.threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.runTask(loaded, thread.threadId, runId, queuedAt));
    this.threadQueues.set(thread.threadId, next);
    void next.finally(() => {
      if (this.threadQueues.get(thread.threadId) === next) this.threadQueues.delete(thread.threadId);
    });
  }

  private async resolveTaskThread(loaded: LoadedTask): Promise<ThreadSummary | null> {
    const threads = this.threads.listThreads().filter((thread) => thread.workingDirectory === loaded.workspace);
    const target = loaded.task.thread?.trim();
    if (target) {
      const matches = threads.filter((thread) => thread.threadId.startsWith(target));
      if (matches.length === 1) return matches[0];
      await appendTaskRun(loaded, {
        runId: randomUUID(),
        status: "skipped",
        reason: matches.length ? "ambiguous_thread" : "thread_not_found",
        message: target
      });
      return null;
    }
    if (threads.length === 1) return threads[0];
    if (threads.length > 1) {
      await appendTaskRun(loaded, {
        runId: randomUUID(),
        status: "skipped",
        reason: "ambiguous_thread"
      });
      return null;
    }
    await appendTaskRun(loaded, {
      runId: randomUUID(),
      status: "skipped",
      reason: "thread_not_found"
    });
    return null;
  }

  private async runTask(loaded: LoadedTask, threadId: string, runId: string, queuedAt: string) {
    this.queuedTasks.delete(loaded.key);
    this.runningTasks.add(loaded.key);
    const startedAt = localTimestamp();
    try {
      await this.waitForThreadIdle(threadId);
      await this.threads.runTurn(threadId, loaded.task.input, "task");
      await appendTaskRun(loaded, {
        runId,
        status: "completed",
        queuedAt,
        startedAt,
        completedAt: localTimestamp(),
        threadId,
        conversation: taskConversation(this.threads.getThread(threadId))
      });
    } catch (error) {
      await appendTaskRun(loaded, {
        runId,
        status: "failed",
        queuedAt,
        startedAt,
        completedAt: localTimestamp(),
        threadId,
        conversation: taskConversation(this.threads.getThread(threadId)),
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.runningTasks.delete(loaded.key);
    }
  }

  private async waitForThreadIdle(threadId: string) {
    while (this.threads.getThread(threadId)?.running) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

const readTask = async (filePath: string): Promise<TaskDefinition | null> => {
  try {
    const parsed = YAML.parse(await readFile(filePath, "utf8"));
    return isTaskDefinition(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isTaskDefinition = (value: unknown): value is TaskDefinition => {
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
};

const shouldTrigger = (loaded: LoadedTask, now: Date) => {
  const parts = cronParts(loaded.task.schedule);
  if (!parts) return false;
  const local = localDateParts(now, defaultTimezone);
  return parts.minute.has(local.minute)
    && parts.hour.has(local.hour)
    && parts.dayOfMonth.has(local.dayOfMonth)
    && parts.month.has(local.month)
    && parts.dayOfWeek.has(local.dayOfWeek);
};

const cronParts = (expression: string) => {
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
};

const parseCronField = (field: string, min: number, max: number, normalize: (value: number) => number = (value) => value) => {
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
};

const rangeBounds = (value: string, min: number, max: number): [number | null, number | null] => {
  if (value === "*") return [min, max];
  if (value.includes("-")) {
    const [start, end] = value.split("-").map(Number);
    return Number.isInteger(start) && Number.isInteger(end) && start <= end ? [start, end] : [null, null];
  }
  const number = Number(value);
  return Number.isInteger(number) ? [number, number] : [null, null];
};

const localDateParts = (date: Date, timezone: string) => {
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
};

const triggerMinuteKey = (date: Date, timezone: string) => {
  const local = localDateParts(date, timezone);
  return `${local.year}-${local.month}-${local.dayOfMonth}-${local.hour}-${local.minute}`;
};

const appendTaskRun = async (
  loaded: LoadedTask,
  run: Omit<TaskRunRecord, "version" | "task" | "taskFile" | "workspace" | "input">
) => {
  const directory = path.join(loaded.workspace, ".codexp", "task-runs");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${safeTaskName(loaded.task.name)}.jsonl`);
  const completedAt = run.completedAt ?? (run.status === "skipped" ? localTimestamp() : undefined);
  const record: TaskRunRecord = {
    version: 1,
    task: loaded.task.name,
    taskFile: loaded.filePath,
    workspace: loaded.workspace,
    input: loaded.task.input,
    ...run,
    completedAt
  };
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
};

const taskConversation = (thread: ReturnType<ThreadHub["getThread"]>): TaskRunRecord["conversation"] | undefined => {
  if (!thread) return undefined;
  const views = recordsToViews(thread.records);
  const lastUserMessage = [...views].reverse().find((view) => view.role === "user")?.text ?? "";
  const lastAssistantMessage = [...views].reverse().find((view) => view.role === "codex")?.text ?? "";
  if (!lastUserMessage && !lastAssistantMessage) return undefined;
  return { lastUserMessage, lastAssistantMessage };
};

const localTimestamp = (date = new Date()) => {
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
};

const pad2 = (value: number) => String(value).padStart(2, "0");

const safeTaskName = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";

const compareLoadedTasks = (left: LoadedTask, right: LoadedTask) =>
  left.filePath.localeCompare(right.filePath);
