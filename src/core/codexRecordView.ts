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
  attachments?: Array<{ type: "image"; url: string }>;
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
      if (attachUsageToLatestCodexView(views, usage)) continue;
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

  if (payload.type === "context_compaction" || payload.type === "context_compacted" || payload.type === "compacted") {
    const status = contextCompactionStatus(payload);
    return {
      id: record.id,
      role: "event",
      label: "context_compaction",
      text: typeof payload.message === "string" ? payload.message : status === "completed" ? "压缩完成" : "压缩中",
      at: record.timestamp,
      status,
      record
    };
  }

  if (typeof payload.message === "string") {
    return {
      id: record.id,
      role: "event",
      label: typeof payload.type === "string" ? payload.type : "event",
      text: payload.message,
      at: record.timestamp,
      record
    };
  }

  return {
    id: record.id,
    role: "event",
    label: typeof payload.type === "string" ? payload.type : "event",
    text: stringify(payload),
    at: record.timestamp,
    record
  };
};

const responseItemToView = (record: CodexRecord, payload: Record<string, unknown>): CodexRecordView | null => {
  if (payload.type === "message") {
    const role = typeof payload.role === "string" ? payload.role : "unknown";
    const text = responseMessageText(payload);
    const attachments = imageAttachments(payload);
    if (role === "user") {
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
    if (role === "assistant") {
      const phase = typeof payload.phase === "string" ? payload.phase : "assistant";
      return {
        id: record.id,
        role: "codex",
        label: phase,
        text: text || (attachments.length ? "[image]" : ""),
        at: record.timestamp,
        attachments,
        canFork: phase === "final_answer",
        record
      };
    }
    return {
      id: record.id,
      role: "event",
      label: `message: ${role}`,
      text: responseMessageSummary(payload) || (attachments.length ? "[image]" : ""),
      at: record.timestamp,
      attachments,
      record
    };
  }

  if (payload.type === "reasoning") {
    const text = reasoningText(payload);
    return {
      id: record.id,
      role: "thinking",
      label: "thinking",
      text: text ?? "Reasoning",
      at: record.timestamp,
      record
    };
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
      status: payload.status === "failed"
        ? "failed"
        : payload.status === "completed"
          ? "completed"
          : "pending",
      record
    };
  }

  if (payload.type === "local_shell_call") {
    return {
      id: record.id,
      role: "tool",
      label: "shell",
      text: localShellText(payload),
      at: record.timestamp,
      status: payload.status === "completed" ? "completed" : "pending",
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

  if (payload.type === "mcp_tool_call") {
    return {
      id: record.id,
      role: "tool",
      label: "mcp tool",
      text: mcpToolText(payload),
      at: record.timestamp,
      status: payload.status === "failed" ? "failed" : payload.status === "completed" ? "completed" : "pending",
      record
    };
  }

  if (payload.type === "web_search_call") {
    return {
      id: record.id,
      role: "tool",
      label: "web search",
      text: typeof payload.query === "string" ? payload.query : stringify(payload),
      at: record.timestamp,
      status: "completed",
      record
    };
  }

  if (payload.type === "collab_agent_tool_call") {
    return {
      id: record.id,
      role: "tool",
      label: "collab agent",
      text: collabAgentToolText(payload),
      at: record.timestamp,
      status: payload.status === "failed" ? "failed" : payload.status === "completed" ? "completed" : "pending",
      record
    };
  }

  if (payload.type === "image_view") {
    return {
      id: record.id,
      role: "tool",
      label: "image view",
      text: typeof payload.path === "string" ? payload.path : stringify(payload),
      at: record.timestamp,
      status: "completed",
      record
    };
  }

  if (payload.type === "image_generation_call") {
    const prompt = typeof payload.prompt === "string"
      ? payload.prompt
      : typeof payload.revised_prompt === "string"
        ? payload.revised_prompt
        : stringify(payload);
    const attachments = imageGenerationAttachments(payload);
    return {
      id: record.id,
      role: "tool",
      label: "image generation",
      text: prompt || (attachments.length ? "[image]" : ""),
      at: record.timestamp,
      status: imageGenerationStatus(payload),
      attachments,
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

  return {
    id: record.id,
    role: responseItemRole(payload),
    label: typeof payload.type === "string" ? payload.type : "response_item",
    text: responseItemSummary(payload),
    at: record.timestamp,
    status: responseItemStatus(payload),
    record
  };
};

const responseItemRole = (payload: Record<string, unknown>): CodexRecordView["role"] => {
  if (payload.type === "error" || payload.status === "failed") return "error";
  if (payload.type === "reasoning") return "thinking";
  const type = typeof payload.type === "string" ? payload.type : "";
  return type.includes("call") || type.includes("tool") || type.includes("output") ? "tool" : "event";
};

const responseItemStatus = (payload: Record<string, unknown>): CodexRecordView["status"] | undefined => {
  if (payload.type === "error" || payload.status === "failed") return "failed";
  if (payload.status === "completed" || payload.type === "function_call_output" || payload.type === "custom_tool_call_output") return "completed";
  if (payload.status === "pending" || payload.status === "in_progress" || String(payload.type ?? "").endsWith("_call")) return "pending";
  return undefined;
};

const contextCompactionStatus = (payload: Record<string, unknown>): NonNullable<CodexRecordView["status"]> => {
  if (payload.status === "failed") return "failed";
  if (payload.status === "completed") return "completed";
  return "pending";
};

export const imageGenerationStatus = (payload: Record<string, unknown>): NonNullable<CodexRecordView["status"]> => {
  if (payload.status === "failed") return "failed";
  if (payload.status === "completed" || imageGenerationResultUrl(payload)) return "completed";
  return "pending";
};

export const imageGenerationAttachments = (payload: Record<string, unknown>): Array<{ type: "image"; url: string }> => {
  const url = imageGenerationResultUrl(payload);
  return url ? [{ type: "image", url }] : [];
};

export const imageGenerationResultUrl = (payload: Record<string, unknown>): string | null => {
  if (payload.type !== "image_generation_call" || typeof payload.result !== "string") return null;
  const result = payload.result.trim();
  if (!result) return null;
  if (/^(?:https?:|blob:)/i.test(result) || /^data:image\//i.test(result)) return result;
  return `data:${imageMimeTypeFromBase64(result)};base64,${result}`;
};

const imageMimeTypeFromBase64 = (value: string) => {
  if (value.startsWith("iVBOR")) return "image/png";
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("UklGR")) return "image/webp";
  if (value.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
};

const localShellText = (payload: Record<string, unknown>) => {
  const action = asRecord(payload.action);
  const commandValue = action?.command ?? payload.command ?? payload.cmd;
  const command = Array.isArray(commandValue)
    ? commandValue.filter((part): part is string => typeof part === "string").join(" ")
    : typeof commandValue === "string" ? commandValue : "";
  const output = typeof payload.aggregated_output === "string" ? payload.aggregated_output.trimEnd() : "";
  return [`$ ${command}`.trim(), output].filter(Boolean).join("\n");
};

const mcpToolText = (payload: Record<string, unknown>) => {
  const label = [
    typeof payload.server === "string" ? payload.server : "",
    typeof payload.tool === "string" ? payload.tool : ""
  ].filter(Boolean).join(".");
  const status = typeof payload.status === "string" ? payload.status : "";
  const error = asRecord(payload.error);
  if (typeof error?.message === "string") return `${label}: ${status}\n${error.message}`;
  if (payload.result != null) return `${label}: ${status}\n${stringify(payload.result)}`;
  if (payload.arguments != null) return `${label}: ${status}\n${stringify(payload.arguments)}`;
  return `${label}: ${status}`.trim();
};

const responseMessageSummary = (payload: Record<string, unknown>) => {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = responseMessageText(payload);
  const blocks = content.length ? `${content.length} block${content.length === 1 ? "" : "s"}` : "no content blocks";
  const phase = typeof payload.phase === "string" ? ` · ${payload.phase}` : "";
  return text
    ? `${blocks}${phase}\n${textPreview(text)}`
    : `${blocks}${phase}`;
};

const responseMessageText = (payload: Record<string, unknown>) => {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return contentText(content) || responseItemSummary(payload);
};

const responseItemSummary = (payload: Record<string, unknown>) => {
  const type = typeof payload.type === "string" ? payload.type : "response_item";
  if (typeof payload.name === "string") return `${type}: ${payload.name}`;
  if (typeof payload.call_id === "string") return `${type}: ${payload.call_id}`;
  return stringify(payload);
};

const contentText = (content: unknown[]) => content
  .map((item) => {
    const record = asRecord(item);
    if (!record) return null;
    if (typeof record.text === "string") return record.text;
    if (typeof record.input_text === "string") return record.input_text;
    if (typeof record.output_text === "string") return record.output_text;
    return null;
  })
  .filter((text): text is string => Boolean(text?.trim()))
  .join("\n\n");

const textPreview = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 280)}...` : normalized;
};

const attachUsageToLatestCodexView = (views: CodexRecordView[], usage: RecordUsage) => {
  for (let i = views.length - 1; i >= 0; i -= 1) {
    if (views[i].role === "codex") {
      views[i] = { ...views[i], usage };
      return true;
    }
  }
  return false;
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
  const urls = new Set<string>();
  if (Array.isArray(payload.images)) {
    for (const url of payload.images) {
      if (typeof url === "string" && url.trim()) urls.add(url);
    }
  }
  if (Array.isArray(payload.content)) {
    for (const item of payload.content) {
      const record = asRecord(item);
      if (!record || !isImageContentType(record.type)) continue;
      const imageUrl = imageUrlFromContent(record);
      if (imageUrl) urls.add(imageUrl);
    }
  }
  return [...urls].map((url) => ({ type: "image", url }));
};

const isImageContentType = (value: unknown) =>
  value === "input_image" || value === "output_image" || value === "image";

const imageUrlFromContent = (content: Record<string, unknown>) => {
  if (typeof content.image_url === "string" && content.image_url.trim()) return content.image_url;
  const imageUrl = asRecord(content.image_url);
  if (typeof imageUrl?.url === "string" && imageUrl.url.trim()) return imageUrl.url;
  if (typeof content.url === "string" && content.url.trim()) return content.url;
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

const collabAgentToolText = (payload: Record<string, unknown>) => [
  typeof payload.tool === "string" ? payload.tool : "agent",
  typeof payload.prompt === "string" && payload.prompt.trim() ? payload.prompt : null,
  Array.isArray(payload.receiver_thread_ids) && payload.receiver_thread_ids.length
    ? `receivers: ${payload.receiver_thread_ids.join(", ")}`
    : null
].filter(Boolean).join("\n");

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
