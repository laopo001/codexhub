import type { ProxyInput } from "../shared/inputTypes.js";
import type { CodexRecord } from "../shared/recordTypes.js";
import type { ThreadOptions, ThreadUsage, Usage } from "../shared/usageTypes.js";
import type {
  SessionCommand,
  SessionRegistration,
  SessionSummary,
  ThreadGoalRunPolicy,
  ThreadRunOptions,
  ThreadStreamEvent
} from "../shared/threadTypes.js";

export type InternalSessionRegistration = SessionRegistration & {
  sessionId?: string;
  transportId?: string;
};

export type SessionCommandWaiter = () => void;

export type SessionState = SessionSummary & {
  transportId?: string;
  commands: SessionCommand[];
  waiters: Set<SessionCommandWaiter>;
};

export type ThreadState = {
  threadId: string;
  workingDirectory: string;
  sessionId?: string;
  appServerTurnId?: string;
  threadOptions: ThreadOptions;
  goalRunPolicy?: ThreadGoalRunPolicy | null;
  goalRunPolicyObjective?: string;
  goalRunPolicyStatus?: string;
  goalRunPolicyTurnActive?: boolean;
  skipNextGoalRunPolicyRun?: boolean;
  running: boolean;
  title: string;
  updatedAt: string;
  records: CodexRecord[];
  recordSeq: number;
  threadUsage: ThreadUsage;
  events: ThreadStreamEvent[];
  subscribers: Set<(event: ThreadStreamEvent) => void>;
  lastUsage?: Usage;
  seq: number;
};

export type PendingCommand = {
  type: SessionCommand["type"];
  threadId?: string;
  workingDirectory?: string;
  keepTurns?: number;
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

export type QueuedTurn = {
  input: ProxyInput;
  source: "web" | "telegram" | "task";
  options?: ThreadRunOptions;
  resolve: () => void;
  reject: (error: Error) => void;
};
