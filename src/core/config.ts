import type {
  ApprovalMode,
  ModelReasoningEffort,
  SandboxMode,
  ThreadOptions,
  WebSearchMode
} from "@openai/codex-sdk";

const boolFromEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

export type ProxyConfig = {
  host: string;
  port: number;
  defaultThreadOptions: ThreadOptions;
};

export const loadConfig = (): ProxyConfig => {
  return {
    host: process.env.CODEX_PROXY_HOST ?? "127.0.0.1",
    port: Number(process.env.CODEX_PROXY_PORT ?? 8788),
    defaultThreadOptions: {
      model: process.env.CODEX_MODEL,
      skipGitRepoCheck: boolFromEnv(process.env.CODEX_SKIP_GIT_REPO_CHECK, true),
      sandboxMode: process.env.CODEX_SANDBOX_MODE as SandboxMode | undefined,
      approvalPolicy: process.env.CODEX_APPROVAL_POLICY as ApprovalMode | undefined,
      modelReasoningEffort: process.env.CODEX_MODEL_REASONING_EFFORT as ModelReasoningEffort | undefined,
      webSearchMode: process.env.CODEX_WEB_SEARCH_MODE as WebSearchMode | undefined,
      networkAccessEnabled: boolFromEnv(process.env.CODEX_NETWORK_ACCESS, true)
    }
  };
};
