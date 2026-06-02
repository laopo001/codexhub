import {
  listCodexSessionsForCwd,
  readCodexSessionSnapshot,
  summarizeCodexSession,
  type CodexSessionSnapshot
} from "./codexSession.js";
import { codexRecordFromSession } from "./codexRecord.js";
import { upsertCodexhubThread, writeCodexhubThreadIndex } from "./codexhubCache.js";

export const listLoadableCodexThreads = async (workingDirectory: string, options: { limit?: number } = {}) => {
  const threads = await listCodexSessionsForCwd(workingDirectory, options);
  await writeCodexhubThreadIndex(workingDirectory, threads);
  return threads;
};

export const loadCodexThread = async (threadId: string, workingDirectory: string) => {
  const snapshot = await readCodexSessionSnapshot(threadId);
  if (!snapshot) return null;
  const summary = await summarizeCodexSession(snapshot, workingDirectory);
  if (!summary) return null;
  await upsertCodexhubThread(workingDirectory, summary);
  return {
    threadId,
    source: "codex-session-jsonl" as const,
    codexSessionPath: snapshot.path,
    records: recordsFromSnapshot(snapshot, threadId)
  };
};

const recordsFromSnapshot = (snapshot: CodexSessionSnapshot, threadId: string) =>
  snapshot.records.map((record) => codexRecordFromSession(record, threadId));
