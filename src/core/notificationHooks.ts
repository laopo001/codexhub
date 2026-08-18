import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  isTaskCompleteRecord,
  taskActivityTitle,
  taskCompleteNotification,
  taskCompleteRecordIsForLatestUserInput,
  taskCompletionNotificationKey,
  turnIdFromRecord,
  type TaskCompleteNotification
} from "../shared/taskNotifications.js";
import { asRecord, type CodexRecord } from "../shared/recordTypes.js";
import { readPositiveIntEnv } from "../shared/env.js";
import type { ThreadStreamEvent, ThreadSummary } from "../shared/threadTypes.js";

export type NotificationHookConfig = {
  command: string;
  timeoutMs: number;
};

export type NotificationHookPayload = {
  type: "task_complete";
  key: string;
  title: string;
  body: string;
  threadId: string;
  machineId?: string;
  workingDirectory: string;
  turnId?: string;
  recordId: string;
  timestamp?: string;
  duration?: string;
  notification: TaskCompleteNotification;
  thread: ThreadSummary;
};

export type NtfyNotificationStatus = "needs_input" | "running" | "completed" | "failed" | "cancelled";

export type NtfyNotificationPayload = {
  type: "task_lifecycle";
  status: NtfyNotificationStatus;
  sequenceId: string;
  title: string;
  body: string;
  threadId: string;
  machineId?: string;
  workingDirectory: string;
  turnId: string;
  timestamp?: string;
  duration?: string;
  durationMs?: number;
  progress?: number;
};

export type NtfyNotificationConfig = {
  url: string;
  token?: string;
  timeoutMs: number;
  updateIntervalMs: number;
};

type NotificationHookLogger = {
  error: (message: string) => void;
};

const maxRememberedNotificationKeys = 1000;

export class NotificationHookRunner {
  private readonly rememberedKeys: string[] = [];
  private readonly rememberedKeySet = new Set<string>();

  constructor(
    private readonly config: NotificationHookConfig,
    private readonly logger: NotificationHookLogger = console
  ) {}

  handleThreadEvent(event: ThreadStreamEvent, records: CodexRecord[]) {
    if (event.historical || event.kind !== "record" || !event.record) return;
    if (!isTaskCompleteRecord(event.record)) return;
    if (!taskCompleteRecordIsForLatestUserInput(event.record, records, event.thread)) return;
    const key = taskCompletionNotificationKey(event.threadId, event.record);
    if (!this.rememberKey(key)) return;
    const notification = taskCompleteNotification(event.thread, event.record, records);
    const payload = notificationHookPayload(event.thread, event.record, key, notification);
    void this.runCommand(payload, this.config.command).catch((error: unknown) => {
      this.logger.error(`codexhub notification hook failed: ${errorText(error)}`);
    });
  }

  private async runCommand(payload: NotificationHookPayload, commandLine: string) {
    const argv = parseNotificationCommand(commandLine);
    if (!argv.length) return;
    const launch = notificationCommandLaunch(argv[0], argv.slice(1));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        env: process.env,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true
      });
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error(`command timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      timer.unref?.();
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-1000);
      });
      child.on("error", finish);
      child.on("close", (code, signal) => {
        if (code === 0) {
          finish();
          return;
        }
        const detail = stderr.trim() ? `: ${stderr.trim()}` : signal ? ` (${signal})` : "";
        finish(new Error(`command exited with ${code ?? "signal"}${detail}`));
      });
      child.stdin?.end(`${JSON.stringify(payload)}\n`);
    });
  }

  private rememberKey(key: string) {
    if (this.rememberedKeySet.has(key)) return false;
    this.rememberedKeySet.add(key);
    this.rememberedKeys.push(key);
    while (this.rememberedKeys.length > maxRememberedNotificationKeys) {
      const oldKey = this.rememberedKeys.shift();
      if (oldKey) this.rememberedKeySet.delete(oldKey);
    }
    return true;
  }
}

type NtfyTurnState = {
  sequenceId: string;
  lastSentAt: number;
  queued?: NtfyNotificationPayload;
  timer?: ReturnType<typeof setTimeout>;
  chain: Promise<void>;
};

/**
 * Publishes the same task lifecycle as one ntfy notification sequence.
 *
 * ntfy clients replace an existing notification when a later message uses the
 * same sequence ID. We deliberately keep this separate from the legacy
 * command hook so an existing `curl -d "Hi"` completion hook does not start
 * sending one fixed message for every streamed record.
 */
export class NtfyNotificationRunner {
  private readonly turns = new Map<string, NtfyTurnState>();
  private readonly completedKeys: string[] = [];
  private readonly completedKeySet = new Set<string>();

  constructor(
    private readonly config: NtfyNotificationConfig,
    private readonly logger: NotificationHookLogger = console
  ) {}

  handleThreadEvent(event: ThreadStreamEvent, records: CodexRecord[]) {
    if (event.historical || event.kind !== "record" || !event.record) return;

    const payload = asRecord(event.record.payload);
    const eventType = typeof payload?.type === "string" ? payload.type : "";
    const turnId = turnIdFromRecord(event.record) ?? event.thread.activeTurnId;
    if (!turnId) return;
    const sequenceId = ntfySequenceId(event.threadId, turnId);

    if (eventType === "task_started") {
      if (this.completedKeySet.has(sequenceId) || this.turns.has(sequenceId)) return;
      const state = this.createTurnState(sequenceId);
      this.sendNow(state, runningNtfyPayload(event.thread, event.record, records, sequenceId, turnId));
      return;
    }

    if (eventType === "task_complete" || eventType === "turn_aborted") {
      if (!taskCompleteRecordIsForLatestUserInput(event.record, records, event.thread)) return;
      if (!this.rememberCompletedKey(sequenceId)) return;
      const state = this.turns.get(sequenceId) ?? this.createTurnState(sequenceId);
      this.sendNow(state, terminalNtfyPayload(event.thread, event.record, records, sequenceId, turnId));
      return;
    }

    // Streamed item/message records are the equivalent of the desktop pet's
    // live activity refresh. Coalesce them so token deltas do not create an
    // HTTP request for every character.
    if (!event.thread.running) return;
    if (event.thread.activeTurnId && event.thread.activeTurnId !== turnId) return;
    const state = this.turns.get(sequenceId) ?? this.createTurnState(sequenceId);
    this.scheduleProgress(
      state,
      runningNtfyPayload(event.thread, event.record, records, sequenceId, turnId)
    );
  }

  private createTurnState(sequenceId: string) {
    const state: NtfyTurnState = {
      sequenceId,
      lastSentAt: 0,
      chain: Promise.resolve()
    };
    this.turns.set(sequenceId, state);
    return state;
  }

  private sendNow(state: NtfyTurnState, payload: NtfyNotificationPayload) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    state.queued = undefined;
    state.lastSentAt = Date.now();
    this.enqueue(state, payload, isNtfyTerminalStatus(payload.status));
  }

  private scheduleProgress(state: NtfyTurnState, payload: NtfyNotificationPayload) {
    state.queued = payload;
    const waitMs = Math.max(0, this.config.updateIntervalMs - (Date.now() - state.lastSentAt));
    if (waitMs === 0) {
      const next = state.queued;
      state.queued = undefined;
      state.lastSentAt = Date.now();
      if (next) this.enqueue(state, next, false);
      return;
    }
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const next = state.queued;
      state.queued = undefined;
      state.lastSentAt = Date.now();
      if (next) this.enqueue(state, next, false);
    }, waitMs);
    state.timer.unref?.();
  }

  private enqueue(state: NtfyTurnState, payload: NtfyNotificationPayload, terminal: boolean) {
    const next = state.chain
      .then(() => this.publish(payload))
      .catch((error: unknown) => {
        this.logger.error(`codexhub ntfy notification failed: ${errorText(error)}`);
      });
    state.chain = terminal
      ? next.finally(() => {
        if (this.turns.get(state.sequenceId) === state) this.turns.delete(state.sequenceId);
      })
      : next;
  }

  private async publish(payload: NtfyNotificationPayload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(ntfySequenceUrl(this.config.url, payload.sequenceId), {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Title": ntfyHeaderValue(payload.title),
          "Tags": ntfyTags(payload.status),
          "Priority": ntfyPriority(payload.status),
          ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {})
        },
        body: payload.body,
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private rememberCompletedKey(key: string) {
    if (this.completedKeySet.has(key)) return false;
    this.completedKeySet.add(key);
    this.completedKeys.push(key);
    while (this.completedKeys.length > maxRememberedNotificationKeys) {
      const oldKey = this.completedKeys.shift();
      if (oldKey) this.completedKeySet.delete(oldKey);
    }
    return true;
  }
}

export const notificationHookConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): NotificationHookConfig | null => {
  const command = env.CODEX_HUB_NOTIFICATION_COMMAND?.trim() || undefined;
  if (!command) return null;
  const timeoutMs = readPositiveIntEnv(env, "CODEX_HUB_NOTIFICATION_TIMEOUT_MS", 5000);
  return { command, timeoutMs };
};

export const notificationHookRunnerFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  logger?: NotificationHookLogger
) => {
  const config = notificationHookConfigFromEnv(env);
  return config ? new NotificationHookRunner(config, logger) : null;
};

export const ntfyNotificationConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env
): NtfyNotificationConfig | null => {
  const rawUrl = env.CODEX_HUB_NTFY_URL?.trim();
  if (!rawUrl) return null;
  const url = normalizeNtfyUrl(rawUrl);
  if (!url) return null;
  return {
    url,
    ...(env.CODEX_HUB_NTFY_TOKEN?.trim() ? { token: env.CODEX_HUB_NTFY_TOKEN.trim() } : {}),
    timeoutMs: readPositiveIntEnv(
      env,
      "CODEX_HUB_NTFY_TIMEOUT_MS",
      readPositiveIntEnv(env, "CODEX_HUB_NOTIFICATION_TIMEOUT_MS", 5000)
    ),
    updateIntervalMs: readPositiveIntEnv(env, "CODEX_HUB_NTFY_UPDATE_INTERVAL_MS", 3000)
  };
};

export const ntfyNotificationRunnerFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  logger?: NotificationHookLogger
) => {
  const config = ntfyNotificationConfigFromEnv(env);
  return config ? new NtfyNotificationRunner(config, logger) : null;
};

export const notificationHookPayload = (
  thread: ThreadSummary,
  record: CodexRecord,
  key: string,
  notification = taskCompleteNotification(thread, record, [record])
): NotificationHookPayload => ({
  type: "task_complete",
  key,
  title: notification.title,
  body: notification.body,
  threadId: thread.threadId,
  ...(thread.runtime.machineId ? { machineId: thread.runtime.machineId } : {}),
  workingDirectory: thread.workingDirectory,
  ...(turnIdFromRecord(record) ? { turnId: turnIdFromRecord(record) } : {}),
  recordId: record.id,
  ...(record.timestamp ? { timestamp: record.timestamp } : {}),
  ...(notification.duration ? { duration: notification.duration } : {}),
  notification,
  thread
});

export const parseNotificationCommand = (value: string) => {
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote === "\"") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("notification command has an unterminated quote");
  if (current) parts.push(current);
  return parts;
};

const notificationCommandLaunch = (command: string, args: string[]) => {
  if (process.platform !== "win32" || !isWindowsCommandScript(command)) return { command, args };
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", "call", command, ...args]
  };
};

const normalizeNtfyUrl = (value: string) => {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.pathname.replace(/\/+$/, "")) {
      return null;
    }
    if (url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

const ntfySequenceUrl = (baseUrl: string, sequenceId: string) =>
  `${baseUrl}/${encodeURIComponent(sequenceId)}`;

const ntfySequenceId = (threadId: string, turnId: string) =>
  `codexhub-${createHash("sha256").update(`${threadId}:${turnId}`).digest("hex").slice(0, 32)}`;

const ntfyTags = (status: NtfyNotificationStatus) => {
  if (status === "completed") return "white_check_mark";
  if (status === "failed") return "x";
  if (status === "cancelled") return "stop_sign";
  if (status === "needs_input") return "question";
  return "hourglass_flowing_sand";
};

const ntfyPriority = (status: NtfyNotificationStatus) => {
  if (status === "failed") return "high";
  if (status === "needs_input") return "high";
  if (status === "running") return "low";
  return "default";
};

const isNtfyTerminalStatus = (status: NtfyNotificationStatus) =>
  status === "completed" || status === "failed" || status === "cancelled";

// Node's fetch rejects non-Latin-1 header values even though ntfy accepts
// UTF-8 headers. RFC 2047 keeps Chinese titles intact across HTTP clients.
const ntfyHeaderValue = (value: string) => /[^\x00-\x7f]/.test(value)
  ? `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
  : value;

const runningNtfyPayload = (
  thread: ThreadSummary,
  record: CodexRecord,
  records: CodexRecord[],
  sequenceId: string,
  turnId: string
): NtfyNotificationPayload => {
  const startedAt = thread.activeTurnStartedAt ?? taskStartedAt(records, turnId);
  const elapsedMs = startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : undefined;
  const progress = latestPlanProgress(records, turnId);
  const needsInput = hasPendingNtfyInteraction(records);
  const activityTitle = taskActivityTitle(thread, records);
  return {
    type: "task_lifecycle",
    status: needsInput ? "needs_input" : "running",
    sequenceId,
    title: activityTitle,
    body: notificationText([
      needsInput ? "等待输入" : "运行中",
      progress === undefined ? null : `进度 ${progress}%`,
      elapsedMs === undefined ? null : `已用 ${formatStatusDuration(elapsedMs)}`
    ].filter((value): value is string => Boolean(value)).join(" · ")),
    threadId: thread.threadId,
    ...(thread.runtime.machineId ? { machineId: thread.runtime.machineId } : {}),
    workingDirectory: thread.workingDirectory,
    turnId,
    ...(record.timestamp ? { timestamp: record.timestamp } : {}),
    ...(progress === undefined ? {} : { progress }),
    ...(elapsedMs === undefined ? {} : { durationMs: elapsedMs, duration: formatStatusDuration(elapsedMs) })
  };
};

const terminalNtfyPayload = (
  thread: ThreadSummary,
  record: CodexRecord,
  records: CodexRecord[],
  sequenceId: string,
  turnId: string
): NtfyNotificationPayload => {
  const payload = asRecord(record.payload);
  if (payload?.type === "task_complete") {
    const notification = taskCompleteNotification(thread, record, records);
    return {
      type: "task_lifecycle",
      status: "completed",
      sequenceId,
      title: notification.title,
      body: notification.body,
      threadId: thread.threadId,
      ...(thread.runtime.machineId ? { machineId: thread.runtime.machineId } : {}),
      workingDirectory: thread.workingDirectory,
      turnId,
      ...(record.timestamp ? { timestamp: record.timestamp } : {}),
      ...(notification.duration ? { duration: notification.duration } : {}),
      ...(notification.durationMs === undefined ? {} : { durationMs: notification.durationMs })
    };
  }

  const interrupted = payload?.status === "interrupted";
  const durationMs = typeof payload?.duration_ms === "number" ? payload.duration_ms : undefined;
  const duration = durationMs === undefined ? undefined : formatStatusDuration(durationMs);
  const reason = typeof payload?.reason === "string" && payload.reason.trim()
    ? payload.reason.trim()
    : interrupted ? "Turn interrupted" : "Turn failed";
  return {
    type: "task_lifecycle",
    status: interrupted ? "cancelled" : "failed",
    sequenceId,
    title: taskActivityTitle(thread, records),
    body: notificationText([
      threadContext(thread),
      interrupted ? "已停止" : "失败",
      reason,
      duration ? `用时 ${duration}` : null
    ].filter((value): value is string => Boolean(value)).join(" · ")),
    threadId: thread.threadId,
    ...(thread.runtime.machineId ? { machineId: thread.runtime.machineId } : {}),
    workingDirectory: thread.workingDirectory,
    turnId,
    ...(record.timestamp ? { timestamp: record.timestamp } : {}),
    ...(duration ? { duration } : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  };
};

const taskStartedAt = (records: CodexRecord[], turnId: string) => {
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (payload?.type === "task_started" && turnIdFromRecord(record) === turnId) return record.timestamp;
  }
  return undefined;
};

const latestPlanProgress = (records: CodexRecord[], turnId: string) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (turnIdFromRecord(record) !== turnId) continue;
    const payload = asRecord(record.payload);
    if (payload?.type !== "turn_plan_updated" || !Array.isArray(payload.plan)) continue;
    const steps = payload.plan
      .map((step) => asRecord(step))
      .filter((step): step is Record<string, unknown> => Boolean(step));
    if (!steps.length) return undefined;
    const completed = steps.filter((step) => step.status === "completed").length;
    return Math.round((completed / steps.length) * 100);
  }
  return undefined;
};

const hasPendingNtfyInteraction = (records: CodexRecord[]) => records.some((record) => {
  const payload = asRecord(record.payload);
  if (!payload) return false;
  const approval = asRecord(payload.approval);
  if (approval?.status === "pending") return true;
  const userInput = asRecord(payload.userInput);
  return payload.type === "user_input_request"
    && (userInput?.status === "pending" || payload.status === "pending_user_input");
});

const threadContext = (thread: ThreadSummary) =>
  thread.title.trim()
  || thread.workingDirectory.split(/[\\/]/).filter(Boolean).pop()
  || "Codex 任务";

const notificationText = (value: string) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
};

const formatStatusDuration = (value: number) => {
  if (value >= 60_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
};

const isWindowsCommandScript = (command: string) => {
  const extension = path.extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
