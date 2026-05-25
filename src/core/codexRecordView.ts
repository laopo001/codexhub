import { asRecord, type CodexRecord } from "./codexRecord.js";

export type RecordUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens?: number;
};

export type CodexRecordView = {
  id: string;
  role: "user" | "codex" | "event" | "error" | "tool" | "thinking";
  label: string;
  text: string;
  at?: string;
  attachments?: Array<{ type: "image"; path: string }>;
  usage?: RecordUsage;
  status?: "pending" | "completed" | "failed";
  canFork?: boolean;
  record: CodexRecord;
};

export const recordsToViews = (records: CodexRecord[]): CodexRecordView[] => {
  const views: CodexRecordView[] = [];
  for (const record of records) {
    const usage = tokenUsageFromRecord(record);
    if (usage) {
      attachUsageToLatestCodexView(views, usage);
      continue;
    }

    const view = recordToView(record);
    if (view) views.push(view);
  }
  return views;
};

export const recordToView = (record: CodexRecord): CodexRecordView | null => {
  const payload = asRecord(record.payload);
  if (!payload) return null;

  if (record.type === "error") {
    return {
      id: record.id,
      role: "error",
      label: typeof payload.type === "string" ? payload.type : "error",
      text: typeof payload.message === "string" ? payload.message : stringify(payload),
      at: record.timestamp,
      status: "failed",
      record
    };
  }
  if (record.type === "event_msg") return eventMessageToView(record, payload);
  if (record.type === "response_item") return responseItemToView(record, payload);
  return null;
};

const eventMessageToView = (record: CodexRecord, payload: Record<string, unknown>): CodexRecordView | null => {
  if (payload.type === "user_message") {
    const attachments = localImageAttachments(payload);
    const text = typeof payload.message === "string" ? payload.message : "";
    return {
      id: record.id,
      role: "user",
      label: "user",
      text: text || (attachments.length ? "[image]" : ""),
      at: record.timestamp,
      attachments,
      record
    };
  }

  if (payload.type === "agent_message" && typeof payload.message === "string") {
    const phase = typeof payload.phase === "string" ? payload.phase : "assistant";
    return {
      id: record.id,
      role: "codex",
      label: phase,
      text: payload.message,
      at: record.timestamp,
      canFork: phase === "final_answer",
      record
    };
  }

  if (payload.type === "image_generation_end") {
    const text = [
      "Generated image",
      typeof payload.saved_path === "string" ? `Saved to: ${payload.saved_path}` : null,
      typeof payload.revised_prompt === "string" ? `Prompt: ${payload.revised_prompt}` : null
    ].filter(Boolean).join("\n");
    return text ? {
      id: record.id,
      role: "event",
      label: "image_generation_end",
      text,
      at: record.timestamp,
      record
    } : null;
  }

  return null;
};

const responseItemToView = (record: CodexRecord, payload: Record<string, unknown>): CodexRecordView | null => {
  if (payload.type === "reasoning") {
    const text = reasoningText(payload);
    return text ? {
      id: record.id,
      role: "thinking",
      label: "thinking",
      text,
      at: record.timestamp,
      record
    } : null;
  }

  if (payload.type === "function_call") {
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const args = typeof payload.arguments === "string" ? payload.arguments : "";
    return {
      id: record.id,
      role: "tool",
      label: `tool call: ${name}`,
      text: formatFunctionCall(name, args),
      at: record.timestamp,
      status: "pending",
      record
    };
  }

  if (payload.type === "function_call_output") {
    const output = typeof payload.output === "string" ? payload.output : stringify(payload.output);
    return {
      id: record.id,
      role: "tool",
      label: "tool result",
      text: output,
      at: record.timestamp,
      status: "completed",
      record
    };
  }

  if (payload.type === "file_change") {
    return {
      id: record.id,
      role: "tool",
      label: `file change: ${typeof payload.status === "string" ? payload.status : "completed"}`,
      text: fileChangeText(payload),
      at: record.timestamp,
      status: payload.status === "failed" ? "failed" : "completed",
      record
    };
  }

  if (payload.type === "error") {
    return {
      id: record.id,
      role: "error",
      label: "error",
      text: typeof payload.message === "string" ? payload.message : stringify(payload),
      at: record.timestamp,
      status: "failed",
      record
    };
  }

  return null;
};

const attachUsageToLatestCodexView = (views: CodexRecordView[], usage: RecordUsage) => {
  for (let i = views.length - 1; i >= 0; i -= 1) {
    if (views[i].role === "codex") {
      views[i] = { ...views[i], usage };
      return;
    }
  }
};

const tokenUsageFromRecord = (record: CodexRecord): RecordUsage | null => {
  const payload = asRecord(record.payload);
  if (record.type !== "event_msg" || payload?.type !== "token_count") return null;
  const info = asRecord(payload.info);
  const usage = asRecord(info?.last_token_usage);
  if (!usage || typeof usage.total_tokens !== "number") return null;
  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    cached_input_tokens: typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : 0,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    reasoning_output_tokens: typeof usage.reasoning_output_tokens === "number" ? usage.reasoning_output_tokens : 0,
    total_tokens: usage.total_tokens
  };
};

const localImageAttachments = (payload: Record<string, unknown>): Array<{ type: "image"; path: string }> => {
  if (!Array.isArray(payload.local_images)) return [];
  return payload.local_images
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
    .map((path) => ({ type: "image", path }));
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

const fileChangeText = (payload: Record<string, unknown>) => {
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  return [
    payload.status === "failed" ? "Patch failed." : "Patch applied successfully.",
    "",
    `Status: ${typeof payload.status === "string" ? payload.status : "completed"}`,
    `Changed files: ${changes.length}`,
    "",
    ...changes.map((change) => {
      const record = asRecord(change);
      const kind = typeof record?.kind === "string" ? record.kind : "update";
      const filePath = typeof record?.path === "string" ? record.path : "";
      return `- ${kind}: ${filePath}`;
    })
  ].join("\n");
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

const stringify = (value: unknown) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
