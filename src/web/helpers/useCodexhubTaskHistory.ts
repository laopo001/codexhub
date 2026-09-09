import { useEffect, useRef } from "react";
import { asRecord } from "../../shared/recordTypes.js";
import type { ThreadDetail } from "../types.js";
import { parseCodexhubInvocation } from "./codexhubInvocation.js";

type TaskHistoryThread = Pick<ThreadDetail, "threadId" | "records" | "history" | "backgroundTerminals">;

// A live CLI listener can be older than the initial transcript page. Load only
// until its actual tool record is available; terminal presence is not an end signal.
export const codexhubTaskHistoryCursor = (thread: TaskHistoryThread | undefined) => {
  if (!thread?.history?.hasOlder || !thread.history.oldestRecordId) return undefined;
  const recordIds = new Set(thread.records.flatMap(record => {
    const payload = asRecord(record.payload);
    return [record.id, payload?.call_id, payload?.id].filter((value): value is string => typeof value === "string");
  }));
  const missing = thread.backgroundTerminals?.some(terminal =>
    !recordIds.has(terminal.itemId) && parseCodexhubInvocation(terminal.command)?.operation === "start"
  );
  return missing ? thread.history.oldestRecordId : undefined;
};

export const useCodexhubTaskHistory = (
  thread: TaskHistoryThread | undefined,
  loadOlder: (threadId: string) => number | Promise<number>
) => {
  const attempted = useRef(new Map<string, string>());
  const threadId = thread?.threadId;
  const cursor = codexhubTaskHistoryCursor(thread);
  useEffect(() => {
    if (!threadId || !cursor || attempted.current.get(threadId) === cursor) return;
    attempted.current.set(threadId, cursor);
    // The shared history action owns deduplication, merging, and visible errors.
    void Promise.resolve().then(() => loadOlder(threadId)).catch(() => undefined);
  }, [threadId, cursor, loadOlder]);
};
