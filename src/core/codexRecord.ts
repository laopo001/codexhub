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
  `${sourceThreadId ?? "codex"}:${record.line}:${record.type}`;

export const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};
