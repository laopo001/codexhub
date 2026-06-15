/** Codex 模型 reasoning effort 枚举。 */
export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

/** thread/session 默认模型配置。 */
export type ThreadOptions = {
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
};

/** app-server 可能返回的新旧命名 token usage 字段。 */
export type Usage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

/** 某个 rate limit window 的使用情况。 */
export type ThreadRateLimitUsage = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
};

/** session 或 thread 观察到的账号 rate limit 状态。 */
export type ThreadRateLimits = {
  primaryRateLimit: ThreadRateLimitUsage | null;
  secondaryRateLimit: ThreadRateLimitUsage | null;
  observedAt: string | null;
};

/** Web 展示 thread context usage 和 rate limit 的聚合结构。 */
export type ThreadUsage = {
  context: {
    usedTokens: number;
    windowTokens: number;
  } | null;
  primaryRateLimit: ThreadRateLimitUsage | null;
  secondaryRateLimit: ThreadRateLimitUsage | null;
  observedAt: string | null;
};
