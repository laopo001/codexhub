import type { ProxyInput } from "../shared/inputTypes.js";
import type { CodexRecord } from "../shared/recordTypes.js";
import type { ThreadOptions, ThreadUsage, Usage } from "../shared/usageTypes.js";
import type {
  SessionCommand,
  SessionRegistration,
  SessionSummary,
  ThreadBackgroundTerminals,
  ThreadQueueItem,
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
  machineId: string;
  sessionId?: string;
  appServerTurnId?: string;
  threadOptions: ThreadOptions;
  running: boolean;
  executionStatus: "waiting" | "running" | "idle";
  title: string;
  updatedAt: string;
  records: CodexRecord[];
  backgroundTerminals: ThreadBackgroundTerminals;
  recordSeq: number;
  threadUsage: ThreadUsage;
  subscribers: Set<(event: ThreadStreamEvent) => void>;
  lastUsage?: Usage;
  seq: number;
};

export type PendingCommand = {
  type: SessionCommand["type"];
  threadId?: string;
  workingDirectory?: string;
  keepTurns?: number;
  input?: ProxyInput;
  turnOptions?: ThreadRunOptions;
  submissionId?: string;
  submissionCreatedAt?: string;
  knownAppServerTurnIds?: Set<string>;
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

export type QueuedTurn = Omit<ThreadQueueItem, "text" | "imageCount" | "position"> & {
  input: ProxyInput;
  options?: ThreadRunOptions;
  resolve: () => void;
  reject: (error: Error) => void;
};
