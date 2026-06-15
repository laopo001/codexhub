/** Codex app-server transcript 中归一化后的单条记录。 */
export type CodexRecord = {
  id: string;
  timestamp?: string;
  type: string;
  payload: unknown;
  order?: number;
  sourceThreadId?: string;
};

/** 安全地把 unknown 收窄为普通对象记录。 */
export const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

/** 单条消息或工具调用关联的 token usage。 */
export type RecordUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens?: number;
};

/** Web 渲染层使用的 record view 结构，由 CodexRecord 转换得到。 */
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
