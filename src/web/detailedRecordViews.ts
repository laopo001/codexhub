import { imageGenerationAttachments, imageGenerationStatus, isActiveRecordStatus, recordViewStatusFromAppStatus, recordViewStatusText, withRecordViewStatusDuration } from "../core/codexRecordView.js";
import { asRecord, type CodexRecord, type CodexRecordView, type RecordUsage } from "../shared/recordTypes.js";

export const recordsToDetailedViews = (records: CodexRecord[]): CodexRecordView[] => {
  const views: CodexRecordView[] = [];
  for (const record of records) {
    const usage = tokenUsageFromRecord(record);
    if (usage) attachUsageToLatestCodexView(views, usage);

    const view = detailedRecordToView(record);
    const payload = asRecord(record.payload);
    if (view) views.push(payload ? withRecordViewStatusDuration(view, payload) : view);
  }
  return views;
};

const detailedRecordToView = (record: CodexRecord): CodexRecordView | null => {
  const payload = asRecord(record.payload);
  if (!payload) return null;

  if (record.type === "error") {
    return {
      id: record.id,
      role: "error",
      label: typeof payload.type === "string" ? payload.type : "error",
      text: stringify(payload),
      at: record.timestamp,
      status: "failed",
      statusText: recordViewStatusText(payload.status),
      record
    };
  }

  if (record.type === "event_msg") {
    if (payload.type === "user_message") return userMessageToView(record, payload);
    if (payload.type === "agent_message") return agentMessageToView(record, payload);
    if (isContextCompactionType(payload.type)) return contextCompactionToView(record, payload);
    return {
      id: record.id,
      role: "event",
      label: typeof payload.type === "string" ? payload.type : "event_msg",
      text: stringify(payload),
      at: record.timestamp,
      record
    };
  }

  if (record.type === "response_item") return responseItemToView(record, payload);

  return {
    id: record.id,
    role: "event",
    label: record.type,
    text: stringify(payload),
    at: record.timestamp,
    record
  };
};

const contextCompactionToView = (record: CodexRecord, payload: Record<string, unknown>): CodexRecordView => {
  const status = recordViewStatusFromAppStatus(payload.status) ?? "pending";
  return {
    id: record.id,
    role: "event",
    label: "context_compaction",
    text: typeof payload.message === "string" ? payload.message : status === "completed" ? "Compaction complete" : "Compacting",
    at: record.timestamp,
    status,
    statusText: recordViewStatusText(payload.status),
    record
  };
};

const isContextCompactionType = (type: unknown) =>
  type === "context_compaction" || type === "context_compacted" || type === "compacted";

const userMessageToView = (record: CodexRecord, payload: Record<string, unknown>): CodexRecordView | null => {
  const attachments = imageAttachments(payload);
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
};

const agentMessageToView = (record: CodexRecord, payload: Record<string, unknown>): CodexRecordView | null => {
  if (typeof payload.message !== "string") return null;
  const phase = typeof payload.phase === "string" ? payload.phase : "assistant";
  const status = recordViewStatusFromAppStatus(payload.status);
  const statusText = recordViewStatusText(payload.status);
  return {
    id: record.id,
    role: "codex",
    label: phase,
    text: payload.message,
    at: record.timestamp,
    status,
    statusText,
    canFork: phase === "final_answer" && !isActiveRecordStatus(status),
    record
  };
};

const responseItemToView = (record: CodexRecord, payload: Record<string, unknown>): CodexRecordView | null => {
  const status = responseStatus(payload);
  const attachments = payload.type === "image_generation_call" ? imageGenerationAttachments(payload) : undefined;
  return {
    id: record.id,
    role: payload.type === "error" ? "error" : payload.type === "reasoning" ? "thinking" : "tool",
    label: typeof payload.type === "string" ? payload.type : "response_item",
    text: stringify(payload),
    at: record.timestamp,
    status,
    statusText: recordViewStatusText(payload.status),
    attachments,
    record
  };
};

const responseStatus = (payload: Record<string, unknown>): CodexRecordView["status"] | undefined => {
  if (payload.type === "error") return "failed";
  const appStatus = recordViewStatusFromAppStatus(payload.status);
  if (appStatus) return appStatus;
  if (
    payload.type === "function_call_output"
    || payload.type === "web_search_call"
    || payload.type === "file_change"
    || (payload.type === "image_generation_call" && imageGenerationStatus(payload) === "completed")
  ) return "completed";
  if (payload.type === "function_call" || payload.type === "image_generation_call") {
    return payload.type === "image_generation_call" ? imageGenerationStatus(payload) : "pending";
  }
  return undefined;
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

const imageAttachments = (payload: Record<string, unknown>): Array<{ type: "image"; url: string }> => {
  if (!Array.isArray(payload.images)) return [];
  return payload.images
    .filter((url): url is string => typeof url === "string" && url.trim().length > 0)
    .map((url) => ({ type: "image", url }));
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
