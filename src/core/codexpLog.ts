import {
  listCodexSessionsForCwd,
  readCodexSessionSnapshot,
  summarizeCodexSession,
  type CodexSessionRecord,
  type CodexSessionSnapshot
} from "./codexSession.js";
import { upsertCodexpThread, writeCodexpIndex } from "./codexpCache.js";

export type CodexpChatMessage = {
  role: "user" | "assistant" | "event" | "error" | "tool" | "thinking";
  at: string;
  id?: string;
  label?: string;
  text: string;
  attachments?: Array<{ type: "image"; path: string }>;
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
  const functionCalls = new Map<string, { name: string; arguments: string }>();

  for (const record of snapshot.records) {
    const message = messageFromRecord(record, functionCalls);
    if (message) messages.push(message);
  }
  return messages;
};

const messageFromRecord = (
  record: CodexSessionRecord,
  functionCalls: Map<string, { name: string; arguments: string }>
): CodexpChatMessage | null => {
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const at = record.timestamp ?? "";

  if (record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
    const attachments = localImageAttachments(payload);
    return {
      role: "user",
      at,
      text: payload.message || (attachments.length ? "[image]" : ""),
      ...(attachments.length ? { attachments } : {})
    };
  }

  if (record.type === "event_msg" && payload.type === "agent_message" && typeof payload.message === "string") {
    return {
      role: "assistant",
      at,
      label: typeof payload.phase === "string" ? payload.phase : "assistant",
      text: payload.message
    };
  }

  if (record.type === "event_msg" && payload.type === "image_generation_end") {
    const text = [
      "Generated image",
      typeof payload.saved_path === "string" ? `Saved to: ${payload.saved_path}` : null,
      typeof payload.revised_prompt === "string" ? `Prompt: ${payload.revised_prompt}` : null
    ].filter(Boolean).join("\n");
    return text ? { role: "event", at, text } : null;
  }

  if (record.type === "response_item" && payload.type === "reasoning") {
    const text = reasoningText(payload);
    return {
      role: "thinking",
      at,
      label: "thinking",
      text: text ?? "Reasoning produced; raw content is not available in the session log."
    };
  }

  if (record.type === "response_item" && payload.type === "function_call") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const args = typeof payload.arguments === "string" ? payload.arguments : "";
    if (callId) functionCalls.set(callId, { name, arguments: args });
    return {
      role: "tool",
      at,
      id: callId,
      label: `tool call: ${name}`,
      text: formatFunctionCall(name, args)
    };
  }

  if (record.type === "response_item" && payload.type === "function_call_output") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
    const call = callId ? functionCalls.get(callId) : undefined;
    const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output, null, 2);
    return {
      role: "tool",
      at,
      id: callId ? `${callId}:output` : undefined,
      label: call ? `tool result: ${call.name}` : "tool result",
      text: call ? formatFunctionResult(call.name, call.arguments, output) : output
    };
  }

  return null;
};

const reasoningText = (payload: Record<string, unknown>): string | null => {
  if (typeof payload.content === "string" && payload.content.trim()) return payload.content;
  if (!Array.isArray(payload.summary)) return null;

  const parts = payload.summary
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      if (!record) return null;
      if (typeof record.text === "string") return record.text;
      if (typeof record.summary === "string") return record.summary;
      return null;
    })
    .filter((text): text is string => Boolean(text?.trim()));

  return parts.length ? parts.join("\n") : null;
};

const formatFunctionCall = (name: string, args: string) => {
  const parsed = parseJsonObject(args);
  if (name === "exec_command" && typeof parsed?.cmd === "string") return `$ ${parsed.cmd}`;
  return args ? `${name}\n${formatJsonLike(args)}` : name;
};

const formatFunctionResult = (name: string, args: string, output: string) => {
  const parsed = parseJsonObject(args);
  if (name === "exec_command" && typeof parsed?.cmd === "string") return `$ ${parsed.cmd}\n${output}`.trim();
  return output;
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

const formatJsonLike = (value: string) => {
  const parsed = parseJsonObject(value);
  return parsed ? JSON.stringify(parsed, null, 2) : value;
};

const localImageAttachments = (payload: Record<string, unknown>): Array<{ type: "image"; path: string }> => {
  if (!Array.isArray(payload.local_images)) return [];
  return payload.local_images
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
    .map((path) => ({ type: "image", path }));
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};
