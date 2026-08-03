/** Codex app-server transcript 中归一化后的单条记录。 */
export type CodexRecord = {
  id: string;
  timestamp?: string;
  type: string;
  payload: unknown;
  order?: number;
  /** app-server 历史分页中的稳定逻辑顺序；Turn 时间戳为空时仍能跨页保序。 */
  historyOrder?: number;
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

/** 子代理活动记录的结构化展示数据；原始协议字段仍完整保留在 record.payload。 */
export type SubagentActivityView = {
  kind: string;
  agentPath?: string;
  agentThreadId?: string;
  /** 创建子代理时由父线程请求的初始任务和配置，不代表子线程后续动态设置。 */
  assignment?: {
    initialMessage?: string;
    model?: string;
    reasoningEffort?: string;
  };
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
  status?: "pending" | "in_progress" | "completed" | "failed";
  statusText?: string;
  statusDurationMs?: number;
  canFork?: boolean;
  subagentActivity?: SubagentActivityView;
  record: CodexRecord;
};
