/** Codex 模型 reasoning effort。具体值由在线 app-server model catalog 决定。 */
export type ModelReasoningEffort = string;

/** app-server schema 将 reasoning effort 定义为非空开放字符串。 */
export const isModelReasoningEffort = (value: unknown): value is ModelReasoningEffort =>
  typeof value === "string" && value.length > 0;

/** Codex app-server service tier。当前 Fast tier 常见值是 priority，但 catalog 可扩展。 */
export type ThreadServiceTier = string;

/** Codex app-server granular approval policy 的稳定分类。 */
export const threadGranularApprovalKeys = [
  "sandbox_approval",
  "rules",
  "skill_approval",
  "request_permissions",
  "mcp_elicitations"
] as const;

export type ThreadGranularApprovalKey = (typeof threadGranularApprovalKeys)[number];

export type ThreadGranularApprovalPolicy = {
  granular: Record<ThreadGranularApprovalKey, boolean>;
};

/** Codex app-server AskForApproval。 */
export type ThreadApprovalPolicy = "untrusted" | "on-request" | ThreadGranularApprovalPolicy | "never";

/** Codex app-server approval request reviewer。 */
export type ThreadApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

/** app-server 当前 thread 的命名 permission profile 来源。 */
export type ActivePermissionProfile = {
  id: string;
  extends: string | null;
};

/** Codex app-server turn/start 使用的结构化 sandbox policy。 */
export type ThreadSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    }
  | { type: "externalSandbox"; networkAccess: "restricted" | "enabled" };

/** thread/session 默认模型配置。 */
export type ThreadOptions = {
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  serviceTier?: ThreadServiceTier;
  approvalPolicy?: ThreadApprovalPolicy;
  approvalsReviewer?: ThreadApprovalsReviewer;
  permissions?: string;
  activePermissionProfile?: ActivePermissionProfile;
  sandboxPolicy?: ThreadSandboxPolicy;
};

export const isThreadApprovalPolicy = (value: unknown): value is ThreadApprovalPolicy => {
  if (value === "untrusted" || value === "on-request" || value === "never") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const granular = (value as { granular?: unknown }).granular;
  if (!granular || typeof granular !== "object" || Array.isArray(granular)) return false;
  const keys = Object.keys(granular);
  return keys.length === threadGranularApprovalKeys.length
    && threadGranularApprovalKeys.every((key) => typeof (granular as Record<string, unknown>)[key] === "boolean");
};

export const isThreadApprovalsReviewer = (value: unknown): value is ThreadApprovalsReviewer =>
  value === "user" || value === "auto_review" || value === "guardian_subagent";

export const asActivePermissionProfile = (value: unknown): ActivePermissionProfile | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const profile = value as Record<string, unknown>;
  if (typeof profile.id !== "string" || !profile.id) return undefined;
  if (profile.extends !== undefined && profile.extends !== null && typeof profile.extends !== "string") return undefined;
  return { id: profile.id, extends: profile.extends ?? null };
};

/** CodexHub 对外稳定的 snake_case token usage 投影。 */
export type Usage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

/** 某个 rate limit window 的使用情况。 */
export type ThreadRateLimitUsage = {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
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
