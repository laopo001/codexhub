import type { CodexRecord } from "./codexRecord.js";
import type { ProxyInput } from "./proxyInput.js";
import type { ThreadOptions, Usage } from "./threadOptions.js";
import type { ThreadUsage } from "./threadUsage.js";
import type {
  SessionCommand,
  SessionRegistration,
  SessionSummary,
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
