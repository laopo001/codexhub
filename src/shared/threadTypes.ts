import type { CodexRecord } from "../core/codexRecord.js";
import type { ProxyInput } from "../core/proxyInput.js";
import type { ThreadOptions, Usage } from "../core/threadOptions.js";
import type { ThreadRateLimits, ThreadUsage } from "../core/threadUsage.js";

export type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  model?: string;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
  session: ThreadSessionSummary;
  status: "running" | "idle";
  running: boolean;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
  threadUsage: ThreadUsage;
};

export type ThreadSessionSummary = {
  sessionId?: string;
  name?: string;
  appServerUrl?: string;
  online: boolean;
  runnable: boolean;
  lastSeenAt?: string;
};

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

export type ThreadRunOptions = {
  model?: string | null;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"] | null;
  collaborationMode?: "default" | "plan" | null;
  goalMode?: boolean | null;
  goalObjective?: string | null;
  goalTokenBudget?: number | null;
};

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export type ThreadGoalUpdate = {
  objective?: string | null;
  status?: ThreadGoalStatus | null;
  tokenBudget?: number | null;
};

export type ThreadDetail = ThreadSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

export type ThreadCandidateSummary = {
  threadId: string;
  cwd: string;
  path: string;
  updatedAt: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  artifactCount: number;
  messageCount: number;
};

export type ThreadStreamEvent = {
  seq: number;
  threadId: string;
  kind: "thread" | "record" | "done";
  historical?: boolean;
  thread: ThreadSummary;
  record?: CodexRecord;
};

export type SessionRegistration = {
  machineId?: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  pid?: number;
  hostname?: string;
};

export type SessionOfflineReason = "heartbeat_timeout" | "transport_disconnected" | "unregistered";

export type SessionStreamEvent = {
  seq: number;
  kind: "sessions";
  sessions: SessionSummary[];
};

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
    | "stop"
    | "list_threads"
    | "start_thread"
    | "resume_thread"
    | "subscribe_thread_records"
    | "unsubscribe_thread_records";
  workingDirectory: string;
  createdAt: string;
  threadId?: string;
  input?: ProxyInput;
  turnId?: string;
  numTurns?: number;
  keepTurns?: number;
  limit?: number;
  goal?: ThreadGoalUpdate;
  options?: ThreadRunOptions;
};

export type SessionThreadCandidatesResult = {
  threads: ThreadCandidateSummary[];
};

export type SessionThreadCommandResult = {
  threadId: string;
};

export type SessionCommandResult = SessionThreadCandidatesResult | SessionThreadCommandResult | ThreadDetail;

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
      heartbeat?: boolean;
    }
  | {
      type: "account_rate_limits_updated";
      rateLimits: unknown;
      heartbeat?: boolean;
    };
