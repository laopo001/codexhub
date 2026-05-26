import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { InstanceHub, InstanceSummary } from "./instanceHub.js";
import { listWorkspaces, type WorkspaceEntry } from "./workspaceState.js";

type TaskDefinition = {
  version: 1;
  name: string;
  enabled: boolean;
  schedule: string;
  instance?: string;
  input: string;
};

type LoadedTask = {
  key: string;
  filePath: string;
  workspace: string;
  task: TaskDefinition;
};

type TaskRunLog = {
  timestamp: string;
  task: string;
  taskFile: string;
  workspace: string;
  status: "queued" | "started" | "completed" | "failed" | "skipped";
  reason?: string;
  instanceId?: string;
  message?: string;
};

const defaultTimezone = "Asia/Shanghai";
const defaultScanIntervalMs = 30_000;

export class TaskScheduler {
  private readonly queuedTasks = new Set<string>();
  private readonly runningTasks = new Set<string>();
  private readonly instanceQueues = new Map<string, Promise<void>>();
  private readonly triggeredMinutes = new Map<string, string>();
  private interval: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    private readonly instances: InstanceHub,
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
    for (const instance of this.instances.listInstances()) {
      byPath.set(instance.workingDirectory, {
        path: instance.workingDirectory,
        name: path.basename(instance.workingDirectory) || instance.workingDirectory,
        lastOpenedAt: instance.updatedAt
      });
    }
    return [...byPath.values()];
  }

  private async enqueue(loaded: LoadedTask) {
    if (this.queuedTasks.has(loaded.key) || this.runningTasks.has(loaded.key)) {
      await writeTaskLog(loaded, { status: "skipped", reason: "already_queued_or_running" });
      return;
    }

    const instance = await this.resolveTaskInstance(loaded);
    if (!instance) return;

    this.queuedTasks.add(loaded.key);
    await writeTaskLog(loaded, { status: "queued", instanceId: instance.instanceId });

    const previous = this.instanceQueues.get(instance.instanceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.runTask(loaded, instance.instanceId));
    this.instanceQueues.set(instance.instanceId, next);
    void next.finally(() => {
      if (this.instanceQueues.get(instance.instanceId) === next) this.instanceQueues.delete(instance.instanceId);
    });
  }

  private async resolveTaskInstance(loaded: LoadedTask): Promise<InstanceSummary | null> {
    const instances = this.instances.listInstances().filter((instance) => instance.workingDirectory === loaded.workspace);
    const target = loaded.task.instance?.trim();
    if (target) {
      const matches = instances.filter((instance) => instance.instanceId.startsWith(target));
      if (matches.length === 1) return matches[0];
      await writeTaskLog(loaded, {
        status: "skipped",
        reason: matches.length ? "ambiguous_instance" : "instance_not_found",
        message: target
      });
      return null;
    }
    if (instances.length === 1) return instances[0];
    if (instances.length > 1) {
      await writeTaskLog(loaded, { status: "skipped", reason: "ambiguous_instance" });
      return null;
    }
    return this.instances.createInstance(loaded.workspace, {});
  }

  private async runTask(loaded: LoadedTask, instanceId: string) {
    this.queuedTasks.delete(loaded.key);
    this.runningTasks.add(loaded.key);
    await writeTaskLog(loaded, { status: "started", instanceId });
    try {
      await this.waitForInstanceIdle(instanceId);
      await this.instances.runTurn(instanceId, loaded.task.input, "task");
      await this.instances.saveInstances();
      await writeTaskLog(loaded, { status: "completed", instanceId });
    } catch (error) {
      await writeTaskLog(loaded, {
        status: "failed",
        instanceId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.runningTasks.delete(loaded.key);
    }
  }

  private async waitForInstanceIdle(instanceId: string) {
    while (this.instances.getInstance(instanceId)?.running) {
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
    && (record.instance == null || typeof record.instance === "string");
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

const writeTaskLog = async (loaded: LoadedTask, log: Omit<TaskRunLog, "timestamp" | "task" | "taskFile" | "workspace">) => {
  const directory = path.join(loaded.workspace, ".codexp", "task-runs");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${safeTaskName(loaded.task.name)}.jsonl`);
  const entry: TaskRunLog = {
    timestamp: new Date().toISOString(),
    task: loaded.task.name,
    taskFile: loaded.filePath,
    workspace: loaded.workspace,
    ...log
  };
  await writeFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
};

const safeTaskName = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";

const compareLoadedTasks = (left: LoadedTask, right: LoadedTask) =>
  left.filePath.localeCompare(right.filePath);
