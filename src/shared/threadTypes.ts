import type { ProxyInput } from "./inputTypes.js";
import type { CodexRecord } from "./recordTypes.js";
import type { ThreadOptions, ThreadRateLimits, ThreadUsage, Usage } from "./usageTypes.js";

/** Web/API 可见的 thread 摘要，records 之外的轻量投影。 */
export type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  model?: string;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
  serviceTier?: ThreadOptions["serviceTier"];
  session: ThreadSessionSummary;
  status: "running" | "idle";
  running: boolean;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
  threadUsage: ThreadUsage;
};

/** thread 所属 runtime session 的轻量信息。 */
export type ThreadSessionSummary = {
  sessionId?: string;
  name?: string;
  appServerUrl?: string;
  online: boolean;
  runnable: boolean;
  lastSeenAt?: string;
};

/** Web/API 可见的 runtime session 摘要；session 是机器级 Codex runtime。 */
export type SessionSummary = {
  sessionId: string;
  machineId?: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  online: boolean;
  status: "online" | "offline";
  createdAt?: string;
  lastSeenAt: string;
  offlineSinceAt?: string;
  offlineReason?: SessionOfflineReason;
  pid?: number;
  hostname?: string;
  accountRateLimits?: ThreadRateLimits | null;
  threads: ThreadSummary[];
};

/** 单轮 turn 的可选运行参数，只作用于本次请求。 */
export type ThreadRunOptions = {
  model?: string | null;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"] | null;
  serviceTier?: ThreadOptions["serviceTier"] | null;
  collaborationMode?: "default" | "plan" | null;
  goalMode?: boolean | null;
  goalObjective?: string | null;
  goalTokenBudget?: number | null;
};

/** app-server goal 的共享状态枚举。 */
export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

/** 更新 thread goal 时使用的 patch payload。 */
export type ThreadGoalUpdate = {
  objective?: string | null;
  status?: ThreadGoalStatus | null;
  tokenBudget?: number | null;
};

/** app-server 发起的交互式审批类型。 */
export type AppServerApprovalKind =
  | "command_execution"
  | "file_change"
  | "legacy_exec_command"
  | "legacy_apply_patch";

/** CodexHub Web 对 app-server 审批请求的稳定决策。 */
export type AppServerApprovalDecision = "approve" | "deny";

/** server/Web 可见的 app-server 审批请求。 */
export type AppServerApprovalRequest = {
  approvalId: string;
  method: string;
  requestId: string | number;
  kind: AppServerApprovalKind;
  threadId: string;
  turnId?: string;
  itemId?: string;
  createdAt: string;
  params: unknown;
};

/** thread 详情接口返回值，包含当前 records 快照和最后事件序号。 */
export type ThreadDetail = ThreadSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

/** app-server thread picker 中展示的可恢复 thread 候选。 */
export type ThreadCandidateSummary = {
  threadId: string;
  cwd: string;
  path: string;
  title: string;
  updatedAt: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  artifactCount: number;
  messageCount: number;
};

/** app-server model/list 返回的 reasoning effort 选项，已归一化为 Web/API 稳定字段。 */
export type ModelCatalogReasoningOption = {
  value: string;
  label?: string;
  description?: string;
};

/** app-server model/list 返回的 service tier 选项，已归一化为 Web/API 稳定字段。 */
export type ModelCatalogServiceTier = {
  value: string;
  label?: string;
  description?: string;
};

/** app-server model/list 返回的单个模型目录项。 */
export type ModelCatalogItem = {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts: ModelCatalogReasoningOption[];
  defaultServiceTier?: string | null;
  serviceTiers: ModelCatalogServiceTier[];
};

/** `/api/events/ws` 下发的 thread 增量事件。 */
export type ThreadStreamEvent = {
  seq: number;
  threadId: string;
  kind: "thread" | "record" | "done";
  historical?: boolean;
  thread: ThreadSummary;
  record?: CodexRecord;
};

/** machine/session bridge 注册官方 Codex runtime 时提交的 session 信息。 */
export type SessionRegistration = {
  machineId?: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  pid?: number;
  hostname?: string;
};

/** session 离线原因；用于 Web 区分心跳超时、transport 断开和主动注销。 */
export type SessionOfflineReason = "heartbeat_timeout" | "transport_disconnected" | "unregistered";

/** `/api/events/ws` 下发的 sessions 控制面快照事件。 */
export type SessionStreamEvent = {
  seq: number;
  kind: "sessions";
  sessions: SessionSummary[];
};

/** server 下发给 session bridge 的命令，最终由 machine/app-server 执行。 */
export type SessionCommand = {
  seq: number;
  commandId: string;
  type:
    | "fork_thread"
    | "rollback_thread"
    | "turn"
    | "steer"
    | "set_goal"
    | "clear_goal"
    | "compact_thread"
    | "review_thread"
    | "rename_thread"
    | "stop"
    | "list_threads"
    | "list_models"
    | "start_thread"
    | "resume_thread"
    | "subscribe_thread_records"
    | "unsubscribe_thread_records"
    | "approval_decision";
  workingDirectory: string;
  createdAt: string;
  threadId?: string;
  input?: ProxyInput;
  turnId?: string;
  approvalId?: string;
  approvalDecision?: AppServerApprovalDecision;
  numTurns?: number;
  keepTurns?: number;
  limit?: number;
  includeHidden?: boolean;
  title?: string;
  goal?: ThreadGoalUpdate;
  reviewTarget?: { type: "uncommittedChanges" };
  options?: ThreadRunOptions;
};

/** list_threads 命令返回的 thread 候选集合。 */
export type SessionThreadCandidatesResult = {
  threads: ThreadCandidateSummary[];
};

/** list_models 命令返回的 app-server 模型目录。 */
export type SessionModelCatalogResult = {
  models: ModelCatalogItem[];
};

/** start_thread/resume_thread 命令返回的 thread 标识和可选 app-server metadata。 */
export type SessionThreadCommandResult = {
  threadId: string;
  thread?: unknown;
};

/** session command 的所有成功返回形状。 */
export type SessionCommandResult =
  | SessionThreadCandidatesResult
  | SessionModelCatalogResult
  | SessionThreadCommandResult
  | { ok?: boolean }
  | ThreadDetail;

/** session bridge 推给 ThreadHub 的事件输入，来源于 app-server snapshot/live event。 */
export type SessionEventInput =
  | {
      type: "thread_event";
      threadId: string;
      commandId?: string;
      heartbeat?: boolean;
      message: unknown;
    }
  | {
      type: "thread_turns_snapshot";
      threadId: string;
      heartbeat?: boolean;
      turns: unknown[];
    }
  | {
      type: "approval_request";
      threadId: string;
      approval: AppServerApprovalRequest;
      heartbeat?: boolean;
    }
  | {
      type: "thread_execution_changed";
      threadId: string;
      running: boolean;
      turnId?: string;
      heartbeat?: boolean;
    }
  | {
      type: "thread_settings_changed";
      threadId: string;
      model?: string | null;
      modelReasoningEffort?: ThreadOptions["modelReasoningEffort"] | null;
      serviceTier?: ThreadOptions["serviceTier"] | null;
      heartbeat?: boolean;
    }
  | {
      type: "account_rate_limits_updated";
      rateLimits: unknown;
      heartbeat?: boolean;
    };
