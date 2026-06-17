import { asRecord, type CodexRecord } from "./recordTypes.js";
import type { ThreadSummary } from "./threadTypes.js";

export type TaskCompleteNotification = {
  title: string;
  body: string;
  threadId: string;
  duration?: string;
};

export const isTaskCompleteRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return record.type === "event_msg" && payload?.type === "task_complete";
};

export const taskCompletionNotificationKey = (threadId: string, record: CodexRecord) => {
  const payload = asRecord(record.payload);
  const turnId = stringField(payload, "turn_id") ?? stringField(payload, "turnId");
  return turnId ? `${threadId}:${turnId}` : `${threadId}:${record.id}`;
};

export const taskCompleteNotification = (
  thread: ThreadSummary,
  record: CodexRecord,
  records: CodexRecord[]
): TaskCompleteNotification => {
  const payload = asRecord(record.payload);
  const durationMs = typeof payload?.duration_ms === "number" ? payload.duration_ms : undefined;
  const duration = typeof durationMs === "number" ? formatStatusDuration(durationMs) : undefined;
  const message = usefulTaskCompleteMessage(payload)
    ?? latestFinalAnswerText(records, record)
    ?? "Task completed.";
  return {
    title: duration ? `Codex task complete · 运行时间 ${duration}` : "Codex task complete",
    body: notificationText(message),
    threadId: thread.threadId,
    duration
  };
};

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

const stringField = (record: Record<string, unknown> | null | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
