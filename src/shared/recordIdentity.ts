import type { CodexRecord } from "./recordTypes.js";

export const turnIdFromAppRecordId = (threadId: string, recordId: string) => {
  const prefix = `app:${threadId}:`;
  if (!recordId.startsWith(prefix)) return null;
  const rest = recordId.slice(prefix.length);
  const [turnId, kind] = rest.split(":");
  if (!turnId || !kind) return null;
  return turnId;
};

export const recordTimestampMs = (record: CodexRecord) => {
  const timestamp = Date.parse(record.timestamp ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
};

export const compareCodexRecords = (left: CodexRecord, right: CodexRecord) => {
  const leftTime = recordTimestampMs(left);
  const rightTime = recordTimestampMs(right);
  const leftOrder = recordOrder(left);
  const rightOrder = recordOrder(right);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) return leftOrder - rightOrder;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime === null && rightTime !== null) return 1;
  return 0;
};

export const orderCodexRecords = (records: CodexRecord[]) =>
  records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => compareCodexRecords(left.record, right.record) || left.index - right.index)
    .map((entry) => entry.record);

const recordOrder = (record: CodexRecord) =>
  typeof record.order === "number" && Number.isFinite(record.order) ? record.order : null;
