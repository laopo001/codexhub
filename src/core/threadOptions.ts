export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type ThreadOptions = {
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
};

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
