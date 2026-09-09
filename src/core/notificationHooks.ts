import { createHash } from "node:crypto";
import {
  taskActivityTitle,
  taskCompleteNotification,
  taskCompleteRecordIsForLatestUserInput,
  turnIdFromRecord
} from "../shared/taskNotifications.js";
import { asRecord, type CodexRecord } from "../shared/recordTypes.js";
import { formatPlanProgress, planProgressFromPlan, type PlanProgress } from "../shared/planProgress.js";
import { readPositiveIntEnv } from "../shared/env.js";
import type { ThreadStreamEvent, ThreadSummary } from "../shared/threadTypes.js";

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
};

export type NtfyNotificationConfig = {
  url: string;
  token?: string;
  timeoutMs: number;
  updateIntervalMs: number;
  requestIntervalMs: number;
};

type NtfyNotificationLogger = {
  error: (message: string) => void;
};

type NtfyTimer = ReturnType<typeof setTimeout>;

type NtfyNotificationRuntime = {
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => NtfyTimer;
  clearTimeout?: (timer: NtfyTimer) => void;
  fetch?: typeof fetch;
};

const maxRememberedNotificationKeys = 1000;
const ntfyTerminalRepeatWindowMs = 60_000;
const ntfyTerminalRepeatIntervalMs = 10_000;

type NtfyTurnState = {
  sequenceId: string;
  lastSentAt: number;
  queued?: NtfyNotificationPayload;
  progressTimer?: NtfyTimer;
  terminal?: {
    payload: NtfyNotificationPayload;
    repeatUntil: number;
  };
};

type NtfyQueuedPublish = {
  payload: NtfyNotificationPayload;
  terminal: boolean;
  repeat: boolean;
  attempt: number;
  readyAt: number;
  order: number;
};

const ntfyTerminalMaxAttempts = 8;
const ntfyRetryMaxDelayMs = 30_000;

/**
 * Publishes the same task lifecycle as one ntfy notification sequence.
 *
 * ntfy clients replace an existing notification when a later message uses the
 * same sequence ID.
 */
export class NtfyNotificationRunner {
  private readonly turns = new Map<string, NtfyTurnState>();
  private readonly completedKeys: string[] = [];
  private readonly completedKeySet = new Set<string>();
  private readonly publishQueue = new Map<string, NtfyQueuedPublish>();
  private publishInFlight = false;
  private publishTimer?: NtfyTimer;
  private publishOrder = 0;
  private nextPublishAt = 0;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => NtfyTimer;
  private readonly clearTimer: (timer: NtfyTimer) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: NtfyNotificationConfig,
    private readonly logger: NtfyNotificationLogger = console,
    runtime: NtfyNotificationRuntime = {}
  ) {
    this.now = runtime.now ?? Date.now;
    this.setTimer = runtime.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = runtime.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.fetchImpl = runtime.fetch ?? fetch;
  }

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
      this.sendNow(state, runningNtfyPayload(event.thread, event.record, records, sequenceId, turnId, this.now()));
      return;
    }

    if (eventType === "task_complete" || eventType === "turn_aborted") {
      if (!taskCompleteRecordIsForLatestUserInput(event.record, records, event.thread)) return;
      if (!this.rememberCompletedKey(sequenceId)) return;
      const state = this.turns.get(sequenceId) ?? this.createTurnState(sequenceId);
      this.startTerminal(state, terminalNtfyPayload(event.thread, event.record, records, sequenceId, turnId));
      return;
    }

    // Streamed item/message records are the equivalent of the desktop pet's
    // live activity refresh. Coalesce them so token deltas do not create an
    // HTTP request for every character.
    if (this.completedKeySet.has(sequenceId)) return;
    if (!event.thread.running) return;
    if (event.thread.activeTurnId && event.thread.activeTurnId !== turnId) return;
    const state = this.turns.get(sequenceId) ?? this.createTurnState(sequenceId);
    this.scheduleProgress(
      state,
      runningNtfyPayload(event.thread, event.record, records, sequenceId, turnId, this.now())
    );
  }

  private createTurnState(sequenceId: string) {
    const state: NtfyTurnState = {
      sequenceId,
      lastSentAt: 0
    };
    this.turns.set(sequenceId, state);
    return state;
  }

  private sendNow(state: NtfyTurnState, payload: NtfyNotificationPayload) {
    if (state.progressTimer) {
      this.clearTimer(state.progressTimer);
      state.progressTimer = undefined;
    }
    state.queued = undefined;
    state.lastSentAt = this.now();
    this.enqueue(payload, isNtfyTerminalStatus(payload.status));
  }

  private startTerminal(state: NtfyTurnState, payload: NtfyNotificationPayload) {
    state.terminal = {
      payload,
      repeatUntil: this.now() + ntfyTerminalRepeatWindowMs
    };
    this.sendNow(state, payload);
  }

  private scheduleProgress(state: NtfyTurnState, payload: NtfyNotificationPayload) {
    state.queued = payload;
    const waitMs = Math.max(0, this.config.updateIntervalMs - (this.now() - state.lastSentAt));
    if (waitMs === 0) {
      const next = state.queued;
      state.queued = undefined;
      state.lastSentAt = this.now();
      if (next) this.enqueue(next, false);
      return;
    }
    if (state.progressTimer) return;
    state.progressTimer = this.setTimer(() => {
      state.progressTimer = undefined;
      const next = state.queued;
      state.queued = undefined;
      state.lastSentAt = this.now();
      if (next) this.enqueue(next, false);
    }, waitMs);
    state.progressTimer.unref?.();
  }

  private enqueue(
    payload: NtfyNotificationPayload,
    terminal: boolean,
    repeat = false,
    readyAt = this.now()
  ) {
    const existing = this.publishQueue.get(payload.sequenceId);
    if (existing?.terminal && !terminal) return;
    if (existing?.terminal && terminal) return;
    this.publishQueue.set(payload.sequenceId, {
      payload,
      terminal,
      repeat,
      attempt: 1,
      readyAt,
      order: existing?.order ?? ++this.publishOrder
    });
    this.schedulePublish();
  }

  private schedulePublish() {
    if (this.publishInFlight || !this.publishQueue.size) return;
    if (this.publishTimer) {
      this.clearTimer(this.publishTimer);
      this.publishTimer = undefined;
    }
    const now = this.now();
    const nextReadyAt = Math.max(
      this.nextPublishAt,
      Math.min(...[...this.publishQueue.values()].map((item) => item.readyAt))
    );
    const waitMs = Math.max(0, nextReadyAt - now);
    if (waitMs === 0) {
      void this.drainPublishQueue();
      return;
    }
    this.publishTimer = this.setTimer(() => {
      this.publishTimer = undefined;
      void this.drainPublishQueue();
    }, waitMs);
    this.publishTimer.unref?.();
  }

  private async drainPublishQueue() {
    if (this.publishInFlight || !this.publishQueue.size) return;
    const now = this.now();
    if (now < this.nextPublishAt) {
      this.schedulePublish();
      return;
    }
    const ready = [...this.publishQueue.values()]
      .filter((item) => item.readyAt <= now)
      .sort((left, right) => Number(right.terminal) - Number(left.terminal) || left.order - right.order);
    const item = ready[0];
    if (!item) {
      this.schedulePublish();
      return;
    }
    if (this.publishQueue.get(item.payload.sequenceId) === item) {
      this.publishQueue.delete(item.payload.sequenceId);
    }
    if (item.repeat && item.attempt === 1 && !this.terminalRepeatIsActive(item.payload.sequenceId, now)) {
      this.clearTurnState(item.payload.sequenceId);
      this.schedulePublish();
      return;
    }
    this.publishInFlight = true;
    this.nextPublishAt = now + this.config.requestIntervalMs;
    let retryScheduled = false;
    let published = false;
    try {
      await this.publish(item.payload);
      published = true;
    } catch (error: unknown) {
      if (item.terminal && item.attempt < ntfyTerminalMaxAttempts && ntfyPublishIsRetryable(error)) {
        const delayMs = ntfyRetryDelayMs(error, item.attempt, this.config.requestIntervalMs);
        retryScheduled = true;
        this.publishQueue.set(item.payload.sequenceId, {
          ...item,
          attempt: item.attempt + 1,
          readyAt: this.now() + delayMs,
          order: ++this.publishOrder
        });
        this.logger.error(
          `codexhub ntfy notification failed (${item.payload.status}, attempt ${item.attempt}/${ntfyTerminalMaxAttempts}): ${errorText(error)}; retrying in ${delayMs}ms`
        );
      } else {
        this.logger.error(
          `codexhub ntfy notification failed (${item.payload.status}, attempt ${item.attempt}/${item.terminal ? ntfyTerminalMaxAttempts : 1}): ${errorText(error)}`
        );
      }
    } finally {
      this.publishInFlight = false;
      if (item.terminal && !retryScheduled) {
        if (published) {
          this.handleTerminalPublishSuccess(item.payload.sequenceId);
        } else {
          this.clearTurnState(item.payload.sequenceId);
        }
      }
      this.schedulePublish();
    }
  }

  private async publish(payload: NtfyNotificationPayload) {
    const controller = new AbortController();
    const timeout = this.setTimer(() => controller.abort(), this.config.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(ntfySequenceUrl(this.config.url, payload.sequenceId), {
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
      const responseBody = await response.text();
      if (!response.ok) {
        throw new NtfyPublishError(
          response.status,
          ntfyRetryAfterMs(response.headers.get("retry-after"), this.now()),
          responseBody
        );
      }
    } finally {
      this.clearTimer(timeout);
    }
  }

  private handleTerminalPublishSuccess(sequenceId: string) {
    const state = this.turns.get(sequenceId);
    const terminal = state?.terminal;
    const now = this.now();
    if (!state || !terminal || now >= terminal.repeatUntil) {
      this.clearTurnState(sequenceId);
      return;
    }

    const nextRepeatAt = now + ntfyTerminalRepeatIntervalMs;
    if (nextRepeatAt >= terminal.repeatUntil) {
      this.clearTurnState(sequenceId);
      return;
    }

    this.enqueue(terminal.payload, true, true, nextRepeatAt);
  }

  private terminalRepeatIsActive(sequenceId: string, now: number) {
    const terminal = this.turns.get(sequenceId)?.terminal;
    return Boolean(terminal && now < terminal.repeatUntil);
  }

  private clearTurnState(sequenceId: string) {
    const state = this.turns.get(sequenceId);
    if (!state) return;
    if (state.progressTimer) this.clearTimer(state.progressTimer);
    state.progressTimer = undefined;
    state.queued = undefined;
    this.turns.delete(sequenceId);
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

class NtfyPublishError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
    responseBody: string
  ) {
    const detail = responseBody.replace(/\s+/g, " ").trim().slice(0, 200);
    super(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "NtfyPublishError";
  }
}

const ntfyPublishIsRetryable = (error: unknown) => !(error instanceof NtfyPublishError)
  || error.status === 408
  || error.status === 429
  || error.status >= 500;

const ntfyRetryDelayMs = (error: unknown, attempt: number, requestIntervalMs: number) => {
  const exponentialDelay = Math.min(
    ntfyRetryMaxDelayMs,
    requestIntervalMs * (2 ** Math.max(0, attempt - 1))
  );
  const retryAfterMs = error instanceof NtfyPublishError ? error.retryAfterMs ?? 0 : 0;
  return Math.max(requestIntervalMs, exponentialDelay, retryAfterMs);
};

const ntfyRetryAfterMs = (value: string | null, now = Date.now()) => {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
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
    timeoutMs: readPositiveIntEnv(env, "CODEX_HUB_NTFY_TIMEOUT_MS", 5000),
    updateIntervalMs: readPositiveIntEnv(env, "CODEX_HUB_NTFY_UPDATE_INTERVAL_MS", 3000),
    requestIntervalMs: readPositiveIntEnv(env, "CODEX_HUB_NTFY_REQUEST_INTERVAL_MS", 5000)
  };
};

export const ntfyNotificationRunnerFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  logger?: NtfyNotificationLogger
) => {
  const config = ntfyNotificationConfigFromEnv(env);
  return config ? new NtfyNotificationRunner(config, logger) : null;
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

const ntfyActivityTitle = (thread: ThreadSummary, records: CodexRecord[]) => {
  const title = taskActivityTitle(thread, records);
  return thread.source === "cli" ? `[cli] ${title}` : title;
};

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
  turnId: string,
  now: number
): NtfyNotificationPayload => {
  const startedAt = thread.activeTurnStartedAt ?? taskStartedAt(records, turnId);
  const elapsedMs = startedAt ? Math.max(0, now - Date.parse(startedAt)) : undefined;
  const progress = latestPlanProgress(records, turnId);
  const needsInput = hasPendingNtfyInteraction(records);
  const activityTitle = ntfyActivityTitle(thread, records);
  const directoryName = thread.workingDirectory.split(/[\\/]/).filter(Boolean).pop() || "";
  const stateLabel = needsInput ? "等待输入" : "运行中";
  return {
    type: "task_lifecycle",
    status: needsInput ? "needs_input" : "running",
    sequenceId,
    title: activityTitle,
    body: notificationText([
      directoryName,
      [
        stateLabel,
        progress === undefined ? null : `进度 ${formatPlanProgress(progress)}`,
        elapsedMs === undefined ? null : `已用 ${formatStatusDuration(elapsedMs)}`
      ].filter((value): value is string => Boolean(value)).join(" · ")
    ].filter(Boolean).join("\n")),
    threadId: thread.threadId,
    ...(thread.runtime.machineId ? { machineId: thread.runtime.machineId } : {}),
    workingDirectory: thread.workingDirectory,
    turnId,
    ...(record.timestamp ? { timestamp: record.timestamp } : {}),
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
      title: ntfyActivityTitle(thread, records),
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
  const directoryName = thread.workingDirectory.split(/[\\/]/).filter(Boolean).pop() || "";
  const stateLabel = interrupted ? "已停止" : "失败";
  return {
    type: "task_lifecycle",
    status: interrupted ? "cancelled" : "failed",
    sequenceId,
    title: ntfyActivityTitle(thread, records),
    body: notificationText([
      directoryName,
      [stateLabel, duration ? `用时 ${duration}` : null, reason]
        .filter((value): value is string => Boolean(value)).join(" · ")
    ].filter(Boolean).join("\n")),
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

const latestPlanProgress = (records: CodexRecord[], turnId: string): PlanProgress | undefined => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (turnIdFromRecord(record) !== turnId) continue;
    const payload = asRecord(record.payload);
    if (payload?.type !== "turn_plan_updated" || !Array.isArray(payload.plan)) continue;
    const steps = payload.plan
      .map((step) => asRecord(step))
      .filter((step): step is Record<string, unknown> => Boolean(step));
    if (!steps.length) return undefined;
    return planProgressFromPlan(steps);
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
    && payload.isBlocking !== false
    && (userInput?.status === "pending" || payload.status === "pending_user_input");
});

const notificationText = (value: string) => {
  const text = value.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
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

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
