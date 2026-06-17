import { spawn } from "node:child_process";
import path from "node:path";
import {
  isTaskCompleteRecord,
  taskCompleteNotification,
  taskCompletionNotificationKey,
  turnIdFromRecord,
  type TaskCompleteNotification
} from "../shared/taskNotifications.js";
import type { CodexRecord } from "../shared/recordTypes.js";
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
  sessionId?: string;
  workingDirectory: string;
  turnId?: string;
  recordId: string;
  timestamp?: string;
  duration?: string;
  notification: TaskCompleteNotification;
  thread: ThreadSummary;
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

export const notificationHookConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): NotificationHookConfig | null => {
  const command = env.CODEX_HUB_NOTIFICATION_COMMAND?.trim() || undefined;
  if (!command) return null;
  const timeoutMs = envPositiveInt(env.CODEX_HUB_NOTIFICATION_TIMEOUT_MS, 5000);
  return { command, timeoutMs };
};

export const notificationHookRunnerFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  logger?: NotificationHookLogger
) => {
  const config = notificationHookConfigFromEnv(env);
  return config ? new NotificationHookRunner(config, logger) : null;
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
  ...(thread.session.sessionId ? { sessionId: thread.session.sessionId } : {}),
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

const isWindowsCommandScript = (command: string) => {
  const extension = path.extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
};

const envPositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
