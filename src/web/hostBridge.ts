import type { TaskCompleteNotification } from "../shared/taskNotifications.js";

export type CodexHubHostIncomingMessage =
  | { type: "codexhub.addTextAttachment"; text: string }
  | { type: "codexhub.openThread"; threadId: string };

export type CodexHubHostOutgoingMessage =
  | { type: "codexhub.openFile"; path: string; line?: number; column?: number }
  | { type: "codexhub.requestNotificationPermission" }
  | { type: "codexhub.taskCompleteNotification"; notification: TaskCompleteNotification };

export const parseCodexHubHostIncomingMessage = (value: unknown): CodexHubHostIncomingMessage | null => {
  const record = asRecord(value);
  if (record?.type === "codexhub.addTextAttachment") {
    const text = stringValue(record.text);
    return text ? { type: record.type, text } : null;
  }
  if (record?.type === "codexhub.openThread") {
    const threadId = stringValue(record.threadId);
    return threadId ? { type: record.type, threadId } : null;
  }
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const stringValue = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
