import {
  listCodexSessionsForCwd,
  readCodexSessionSnapshot,
  summarizeCodexSession,
  type CodexSessionRecord,
  type CodexSessionSnapshot
} from "./codexSession.js";
import { upsertCodexpThread, writeCodexpIndex } from "./codexpCache.js";

export type CodexpChatMessage = {
  role: "user" | "assistant" | "event" | "error";
  at: string;
  text: string;
};

export const listLoadableCodexThreads = async (workingDirectory: string) => {
  const threads = await listCodexSessionsForCwd(workingDirectory);
  await writeCodexpIndex(workingDirectory, threads);
  return threads;
};

export const loadCodexThread = async (threadId: string, workingDirectory: string) => {
  const snapshot = await readCodexSessionSnapshot(threadId);
  if (!snapshot) return null;
  const summary = await summarizeCodexSession(snapshot, workingDirectory);
  if (!summary) return null;
  await upsertCodexpThread(workingDirectory, summary);
  return {
    threadId,
    source: "codex-session-jsonl" as const,
    codexSessionPath: snapshot.path,
    messages: transcriptFromSnapshot(snapshot)
  };
};

const transcriptFromSnapshot = (snapshot: CodexSessionSnapshot): CodexpChatMessage[] => {
  const messages: CodexpChatMessage[] = [];
  for (const record of snapshot.records) {
    const message = messageFromRecord(record);
    if (message) messages.push(message);
  }
  return messages;
};

const messageFromRecord = (record: CodexSessionRecord): CodexpChatMessage | null => {
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const at = record.timestamp ?? "";

  if (record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
    return { role: "user", at, text: payload.message };
  }

  if (record.type === "event_msg" && payload.type === "agent_message" && payload.phase === "final_answer" && typeof payload.message === "string") {
    return { role: "assistant", at, text: payload.message };
  }

  if (record.type === "event_msg" && payload.type === "image_generation_end") {
    const text = [
      "Generated image",
      typeof payload.saved_path === "string" ? `Saved to: ${payload.saved_path}` : null,
      typeof payload.revised_prompt === "string" ? `Prompt: ${payload.revised_prompt}` : null
    ].filter(Boolean).join("\n");
    return text ? { role: "event", at, text } : null;
  }

  return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};
