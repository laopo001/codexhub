import type { CodexSessionRecord } from "./codexSession.js";

export type CodexRecord = {
  id: string;
  timestamp?: string;
  type: string;
  payload: unknown;
  line?: number;
  sourceThreadId?: string;
};

export const codexRecordFromSession = (
  record: CodexSessionRecord,
  sourceThreadId?: string
): CodexRecord => ({
  id: codexRecordId(record, sourceThreadId),
  timestamp: record.timestamp,
  type: record.type,
  payload: record.payload,
  line: record.line,
  sourceThreadId
});

const codexRecordId = (record: CodexSessionRecord, sourceThreadId?: string) =>
  codexAppRecordId(record, sourceThreadId) ?? `${sourceThreadId ?? "codex"}:${record.line}:${record.type}`;

const codexAppRecordId = (record: CodexSessionRecord, sourceThreadId?: string) => {
  if (!sourceThreadId || !record.turnId || record.type !== "event_msg") return null;
  const payload = asRecord(record.payload);
  switch (payload?.type) {
    case "user_message":
      return `app:${sourceThreadId}:${record.turnId}:user:jsonl:${record.line}`;
    case "agent_message":
      return `app:${sourceThreadId}:${record.turnId}:agent:jsonl:${record.line}`;
    case "token_count":
      return `app:${sourceThreadId}:${record.turnId}:usage:jsonl:${record.line}`;
    default:
      return null;
  }
};

export const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};
