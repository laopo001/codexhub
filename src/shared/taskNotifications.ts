import { asRecord, type CodexRecord } from "./recordTypes.js";
import { threadActivityTitleFromRecords } from "./threadActivity.js";
import type { ThreadSummary } from "./threadTypes.js";
import { type ProjectSource, isProjectSource } from "./projectTypes.js";
import { formatVscodeSurfacePrefix } from "./surfaceTypes.js";
import {
  parseProjectTarget,
  parseWorkspaceTarget,
  pathIdentityKey,
  type PetActivityOpenTarget,
  type ProjectTarget,
  type WorkspaceTarget
} from "./petActivityRouting.js";

export const workingDirectoryName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || "";

export type TaskCompleteNotification = {
  title: string;
  body: string;
  threadId: string;
  machineId?: string;
  machineHostname?: string;
  projectPath?: string;
  workingDirectory?: string;
  source?: ProjectSource;
  projectTarget?: ProjectTarget;
  workspaceTarget?: WorkspaceTarget;
  machineLabel?: string;
  duration?: string;
  durationMs?: number;
  persistent?: boolean;
};

export const isTaskCompleteNotification = (value: unknown): value is TaskCompleteNotification => {
  const record = asRecord(value);
  if (!record) return false;
  const projectTarget = record.projectTarget === undefined ? undefined : parseProjectTarget(record.projectTarget);
  const workspaceTarget = record.workspaceTarget === undefined ? undefined : parseWorkspaceTarget(record.workspaceTarget);
  return Boolean(
    nonEmptyString(record.title)
    && typeof record.body === "string"
    && nonEmptyString(record.threadId)
    && (record.machineId === undefined || nonEmptyString(record.machineId))
    && (record.machineHostname === undefined || nonEmptyString(record.machineHostname))
    && (record.projectPath === undefined || nonEmptyString(record.projectPath))
    && (record.workingDirectory === undefined || nonEmptyString(record.workingDirectory))
    && (record.source === undefined || isProjectSource(record.source))
    && (record.projectTarget === undefined || Boolean(projectTarget))
    && (record.workspaceTarget === undefined || Boolean(workspaceTarget))
    && (!workspaceTarget || workspaceTarget.machineId === record.machineId)
    && (!(projectTarget && workspaceTarget) || projectTarget.machineId === workspaceTarget.machineId)
    && (!projectTarget || projectTarget.machineId === record.machineId)
    && (!projectTarget || !workspaceTarget || workspaceTarget.workspacePaths.includes(projectTarget.path))
    && (!projectTarget || record.projectPath === undefined
      || pathIdentityKey(String(record.projectPath)) === pathIdentityKey(projectTarget.path))
    && (!workspaceTarget || !record.source || (
      record.source.kind === workspaceTarget.kind
      && record.source.groupId === workspaceTarget.groupId
      && (!record.source.vscodeChannel
        || record.source.vscodeChannel === workspaceTarget.vscodeChannel)
      && record.source.workspaceFile === workspaceTarget.workspaceFile
    ))
    && (record.machineLabel === undefined || nonEmptyString(record.machineLabel))
    && (record.duration === undefined || nonEmptyString(record.duration))
    && (record.durationMs === undefined || nonNegativeFiniteNumber(record.durationMs))
    && (record.persistent === undefined || typeof record.persistent === "boolean")
  );
};

export const taskCompleteNotificationShouldPersist = (
  notification: Pick<TaskCompleteNotification, "durationMs">,
  persistAfterMinutes: number
) => persistAfterMinutes === 0
  || (Number.isFinite(persistAfterMinutes)
    && persistAfterMinutes > 0
    && typeof notification.durationMs === "number"
    && notification.durationMs >= persistAfterMinutes * 60_000);

/**
 * 统一的通知标题：严格使用最近用户输入/Activity title，不塞入冗长机器名与目录堆叠
 */
export const taskCompleteNotificationTitle = (notification: TaskCompleteNotification) =>
  notification.title?.trim() || "Codex 任务已完成";

/**
 * 格式化通知来源标签（如 VS Code Insiders / VS Code / Electron / Local / SSH / Registered）
 */
export const formatTaskNotificationSourceLabel = (
  source?: ProjectSource,
  machine?: { type?: string; name?: string; hostname?: string }
): string => {
  if (source?.kind === "vscode") {
    return formatVscodeSurfacePrefix(source.vscodeChannel);
  }
  if (source?.kind === "electron") {
    return "Electron";
  }
  if (machine?.type === "ssh") return "SSH";
  if (machine?.type === "registered") return "Registered";
  if (machine?.type === "local") return "Local";
  return "";
};

/**
 * 格式化紧凑、高可读性的通知正文：[来源 · 项目目录 · 状态耗时 · 最终回答/摘要]
 */
export const formatTaskNotificationBody = (options: {
  source?: ProjectSource;
  machine?: { type?: string; name?: string; hostname?: string };
  workingDirectory?: string;
  duration?: string;
  message?: string | null;
}) => {
  const sourceLabel = formatTaskNotificationSourceLabel(options.source, options.machine);
  const directoryName = options.workingDirectory ? workingDirectoryName(options.workingDirectory) : "";
  const statusWithDuration = options.duration ? `已完成 · 用时 ${options.duration}` : "已完成";
  const contextLine = [sourceLabel, directoryName].filter(Boolean).join(" · ");
  const cleanMessage = options.message?.trim();
  const resultLine = [
    statusWithDuration,
    cleanMessage && cleanMessage !== "任务已完成" && cleanMessage !== "已完成" ? cleanMessage : null
  ].filter((value): value is string => Boolean(value)).join(" · ");
  return notificationMultilineText([contextLine, resultLine]);
};

export type TaskCompleteNotificationOptions = {
  source?: ProjectSource;
  machine?: { type?: string; name?: string; hostname?: string };
  machineId?: string;
  machineHostname?: string;
  projectPath?: string;
  machineLabel?: string;
  projectTarget?: ProjectTarget;
  workspaceTarget?: WorkspaceTarget;
};

/**
 * The notification title shared by Pet Activity and every host notification.
 * Goal/user-input activity is more useful than the generic "task complete"
 * label, and the helper already compacts it for cross-surface display.
 */
export const taskActivityTitle = (thread: ThreadSummary, records: CodexRecord[]) =>
  thread.activityTitle?.trim()
  || threadActivityTitleFromRecords(records, thread.threadId)
  || thread.title.trim()
  || thread.workingDirectory.split(/[\\/]/).filter(Boolean).pop()
  || "Codex 任务";

export const isTaskCompleteRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return record.type === "event_msg" && payload?.type === "task_complete";
};

/**
 * A completion record may arrive after a newer user turn has already started.
 * Keep that historical record in the transcript, but only notify for the
 * latest user input's turn.
 */
export const taskCompleteRecordIsForLatestUserInput = (
  record: CodexRecord,
  records: CodexRecord[],
  thread?: Pick<ThreadSummary, "activeTurnId">
) => {
  const completedTurnId = turnIdFromRecord(record);
  if (!completedTurnId) return true;
  if (thread?.activeTurnId && thread.activeTurnId !== completedTurnId) return false;

  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!isUserMessageRecord(records[index])) continue;
    const latestUserTurnId = turnIdFromRecord(records[index]);
    if (latestUserTurnId) return latestUserTurnId === completedTurnId;
    break;
  }

  return true;
};

export const taskCompletionNotificationKey = (threadId: string, record: CodexRecord) => {
  const payload = asRecord(record.payload);
  const turnId = stringField(payload, "turn_id") ?? stringField(payload, "turnId");
  return turnId ? `${threadId}:${turnId}` : `${threadId}:${record.id}`;
};

export const taskCompleteNotification = (
  thread: ThreadSummary,
  record: CodexRecord,
  records: CodexRecord[],
  options?: TaskCompleteNotificationOptions | string
): TaskCompleteNotification => {
  const opts: TaskCompleteNotificationOptions = typeof options === "string"
    ? { machineLabel: options }
    : options || {};
  const payload = asRecord(record.payload);
  const durationMs = typeof payload?.duration_ms === "number" ? payload.duration_ms : undefined;
  const duration = typeof durationMs === "number" ? formatStatusDuration(durationMs) : undefined;
  const message = usefulTaskCompleteMessage(payload)
    ?? latestFinalAnswerText(records, record)
    ?? "任务已完成";
  const activityTitle = taskActivityTitle(thread, records);
  const workingDirectory = thread.workingDirectory;
  const machineId = thread.runtime.machineId || opts.machineId;
  const machineHostname = opts.machineHostname || opts.machine?.hostname;
  const body = formatTaskNotificationBody({
    source: opts.source,
    machine: opts.machine,
    workingDirectory,
    duration,
    message
  });

  return {
    title: activityTitle,
    body,
    threadId: thread.threadId,
    ...(machineId ? { machineId } : {}),
    ...(machineHostname ? { machineHostname } : {}),
    ...(opts.projectPath ? { projectPath: opts.projectPath } : {}),
    ...(opts.projectTarget ? { projectTarget: opts.projectTarget } : {}),
    ...(opts.workspaceTarget ? { workspaceTarget: opts.workspaceTarget } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.machineLabel?.trim() ? { machineLabel: opts.machineLabel.trim() } : {}),
    ...(duration ? { duration } : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  };
};

export const taskCompleteNotificationOpenTarget = (
  notification: TaskCompleteNotification
): PetActivityOpenTarget => ({
  threadId: notification.threadId,
  ...(notification.workingDirectory ? { workingDirectory: notification.workingDirectory } : {}),
  ...(notification.machineId ? { machineId: notification.machineId } : {}),
  ...(notification.machineHostname ? { machineHostname: notification.machineHostname } : {}),
  ...(notification.projectPath ? { projectPath: notification.projectPath } : {}),
  ...(notification.projectTarget ? { projectTarget: notification.projectTarget } : {}),
  ...(notification.workspaceTarget ? { workspaceTarget: notification.workspaceTarget } : {}),
  ...(notification.source ? { source: notification.source } : {})
});

export const usefulTaskCompleteMessage = (payload: Record<string, unknown> | null | undefined) => {
  const lastAgentMessage = stringField(payload, "last_agent_message") ?? stringField(payload, "lastAgentMessage");
  if (lastAgentMessage) return lastAgentMessage;
  const message = stringField(payload, "message");
  if (!message || /^(task|turn)?\s*completed\.?$/i.test(message.trim())) return null;
  return message;
};

export const latestFinalAnswerText = (records: CodexRecord[], taskRecord: CodexRecord) => {
  const taskPayload = asRecord(taskRecord.payload);
  const taskTurnId = stringField(taskPayload, "turn_id") ?? stringField(taskPayload, "turnId");
  const taskIndex = records.findIndex((record) => record.id === taskRecord.id);
  for (let index = taskIndex === -1 ? records.length - 1 : taskIndex; index >= 0; index -= 1) {
    const record = records[index];
    const recordTurnId = turnIdFromRecord(record);
    if (taskTurnId && recordTurnId && recordTurnId !== taskTurnId) continue;
    const text = finalAnswerTextFromRecord(record);
    if (text) return text;
  }
  return null;
};

export const finalAnswerTextFromRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return null;
  if (
    record.type === "event_msg"
    && payload.type === "agent_message"
    && payload.phase === "final_answer"
  ) {
    return stringField(payload, "message") ?? null;
  }
  if (
    record.type === "response_item"
    && payload.type === "message"
    && payload.role === "assistant"
    && payload.phase === "final_answer"
  ) {
    return messageTextFromPayload(payload);
  }
  return null;
};

export const messageTextFromPayload = (payload: Record<string, unknown>) => {
  const direct = stringField(payload, "message") ?? stringField(payload, "text");
  if (direct) return direct;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts = content.flatMap((item) => {
    const record = asRecord(item);
    return stringField(record, "text")
      ?? stringField(record, "input_text")
      ?? stringField(record, "output_text")
      ?? [];
  });
  return parts.length ? parts.join("\n") : null;
};

export const turnIdFromRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return stringField(payload, "turn_id")
    ?? stringField(payload, "turnId")
    ?? (typeof record.id === "string" ? record.id.match(/^app:[^:]+:([^:]+):/)?.[1] : undefined);
};

export const notificationText = (value: string) => {
  const text = compactLine(value);
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
};

const notificationMultilineText = (lines: string[]) => {
  const text = lines.map(compactLine).filter(Boolean).join("\n");
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
};

export const formatStatusDuration = (value: number) => {
  if (value >= 60_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
};

const compactLine = (value: string) => value.replace(/\s+/g, " ").trim();

export const isUserMessageRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return Boolean(
    payload
    && (
      (record.type === "event_msg" && payload.type === "user_message")
      || (record.type === "response_item" && payload.type === "message" && payload.role === "user")
    )
  );
};

const stringField = (record: Record<string, unknown> | null | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());

const nonNegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
