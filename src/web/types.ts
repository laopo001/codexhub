import type React from "react";
import type { CodexRecord } from "../core/codexRecord.js";
import type { CodexRecordView } from "../core/codexRecordView.js";
import type { CompactRecordView } from "../shared/compactRecordViews.js";

export type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  session: ThreadSessionSummary;
  model?: string;
  modelReasoningEffort?: ReasoningEffort;
  status: ThreadStatus;
  running: boolean;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
  threadUsage: ThreadUsage;
};

export type ThreadSessionSummary =
  {
    sessionId?: string;
    name?: string;
    online: boolean;
    runnable: boolean;
    lastSeenAt?: string;
  };

export type ThreadDetail = ThreadSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

export type ThreadGoalView = {
  objective: string;
  status: string;
  tokenBudget?: number;
  updatedAt?: string;
};

export type GoalDialogState = {
  threadId: string;
  objective: string;
  saving: boolean;
  error: string;
};

export type SessionSummary = {
  sessionId: string;
  machineId?: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  online: boolean;
  status?: "online" | "offline";
  createdAt?: string;
  lastSeenAt: string;
  offlineSinceAt?: string;
  offlineReason?: "heartbeat_timeout" | "transport_disconnected" | "unregistered";
  pid?: number;
  hostname?: string;
  threads?: ThreadSummary[];
};

export type SessionView = SessionSummary & {
  sessionId: string;
};

export type MachineSummary = {
  machineId: string;
  type?: "local" | "ssh" | "registered";
  name?: string;
  hostname: string;
  online: boolean;
  status: "online" | "offline";
  lastSeenAt: string;
  offlineSinceAt?: string;
  offlineReason?: "transport_disconnected" | "unregistered";
  cwd?: string;
  capabilities?: {
    projectLauncher?: boolean;
  };
};

export type MachineDirectoryEntry = {
  name: string;
  path: string;
};

export type MachineDirectoryListing = {
  cwd: string;
  parent?: string;
  home: string;
  entries: MachineDirectoryEntry[];
};

export type SshHost = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFiles?: string[];
  proxyJump?: string;
  configured?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type SshConnection = {
  connectionId: string;
  host: string;
  name?: string;
  status: "starting" | "running" | "exited";
  remotePort: number;
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: string | null;
  lastOutput?: string;
};

export type PluginSummary = {
  pluginId: string;
  name: string;
  version?: string;
  enabled: boolean;
  origin?: "builtin" | "local";
  root?: string;
  contributions?: {
    web?: {
      styles?: Array<{
        path: string;
        url: string;
      }>;
    };
    integrations?: Array<{
      type: string;
      runner: "builtin" | "external";
      enabled: boolean;
      label?: string;
      requiredEnv?: string[];
      configured?: boolean;
      started?: boolean;
    }>;
  };
};

export type CodexThreadCandidate = {
  threadId: string;
  cwd: string;
  path: string;
  updatedAt: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  artifactCount: number;
  messageCount: number;
};

export type ProjectSummary = {
  projectId: string;
  machineId: string;
  path: string;
  name: string;
  transient?: boolean;
  source?: {
    kind: "vscode";
    groupId: string;
    label?: string;
  };
  pinned?: boolean;
  createdAt: string;
  lastOpenedAt: string;
  lastSessionId?: string;
  lastThreadId?: string;
  machine?: MachineSummary;
  machineOnline: boolean;
  session: SessionView | null;
  online: boolean;
  running: boolean;
  sessions: SessionView[];
  threads: ThreadSummary[];
};

export type LocalTaskStatus = "queued" | "completed" | "failed" | "skipped";

export type LocalTaskRun = {
  runId: string;
  status: LocalTaskStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  sessionId?: string;
  threadId?: string;
  error?: string;
};

export type LocalTask = {
  taskId: string;
  name: string;
  enabled: boolean;
  schedule: string;
  machineId: string;
  projectPath: string;
  projectId?: string;
  threadId?: string;
  input: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: LocalTaskStatus;
  lastError?: string;
  lastDurationMs?: number;
  nextRunAt?: string | null;
  runs?: LocalTaskRun[];
};

export type TaskDraft = {
  name: string;
  enabled: boolean;
  schedule: string;
  machineId: string;
  projectPath: string;
  threadId: string;
  input: string;
};

export type ProjectMachineGroup = {
  key: string;
  kind?: "machine" | "vscodeWorkspace";
  machineId?: string;
  label: string;
  online: boolean;
  projectLauncher: boolean;
  statusLabel: string;
  projects: ProjectSummary[];
};

export type ProjectPickerState = {
  machineId: string;
  path: string;
  parent?: string;
  home?: string;
  entries: MachineDirectoryEntry[];
  loading: boolean;
  error: string;
};

export type ThreadPickerState = {
  sessionId: string;
  workingDirectory: string;
  loading: boolean;
  error: string;
  candidates: CodexThreadCandidate[];
  acting: "new" | string | null;
};

export type ProjectsPayload = {
  seq?: number;
  kind?: "projects";
  statePath?: string;
  machines?: MachineSummary[];
  projects?: ProjectSummary[];
};

export type OpenThreadState = ThreadDetail & {
  input: string;
  imageAttachments: ImageAttachment[];
  textAttachments: TextAttachment[];
};

export type ComposerHistoryState = {
  threadId: string;
  draft: string;
  offsetFromEnd: number;
};

export type ImageAttachment = {
  id: string;
  file: File;
  name: string;
  previewUrl: string;
};

export type TextAttachment = {
  id: string;
  text: string;
};

export type MessageContextMenuState = {
  x: number;
  y: number;
  threadId: string;
  message: WebRecordView;
  selectedText: string;
  canInspect: boolean;
};

export type StreamEvent = {
  seq: number;
  kind: "thread" | "record" | "done";
  thread: ThreadSummary;
  record?: CodexRecord;
};

export type TaskCompleteNotification = {
  title: string;
  body: string;
  threadId: string;
  duration?: string;
};

export type SessionStreamEvent = {
  seq: number;
  kind: "sessions";
  sessions: SessionView[];
};

export type TasksStreamEvent = {
  seq: number;
  kind: "tasks";
  tasks: LocalTask[];
};

export type ConnectionsStreamEvent = {
  seq: number;
  kind: "connections";
  connections: SshConnection[];
};

export type RealtimeMessage =
  | ({ type: "sessions" } & SessionStreamEvent)
  | ({ type: "projects" } & ProjectsPayload)
  | ({ type: "tasks" } & TasksStreamEvent)
  | ({ type: "connections" } & ConnectionsStreamEvent)
  | ({ type: "thread" | "record" | "done" } & StreamEvent)
  | { type: "ready" }
  | { type: "thread_subscribed" | "thread_unsubscribed"; threadId: string }
  | { type: "error"; message: string; scope?: string; threadId?: string };

export type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens?: number;
};

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThreadStatus = "running" | "idle";
export type ModelSelection = string;
export type ReasoningSelection = "auto" | ReasoningEffort;
export type ComposerMode = "chat" | "plan" | "goal";
export type MessageDisplayMode = "compact" | "detailed";
export type MessageRenderMode = "markdown" | "raw";
export type ConnectionMode = "local" | "ssh" | "registered";
export type WebRecordView = CompactRecordView;
export type ActivityStatusView = {
  key: string;
  label: string;
  text: string;
  at?: string;
  status?: CodexRecordView["status"];
  files?: ActivityStatusFile[];
};
export type TurnUiStateKind = "idle" | "running" | "completed" | "aborted" | "failed";
export type TurnUiState = {
  kind: TurnUiStateKind;
  label: string;
  title: string;
};
export type ActivityStatusFile = {
  path: string;
  added?: number;
  removed?: number;
};
export type MemoryCitationEntry = {
  source: string;
  lineStart?: number;
  lineEnd?: number;
  note?: string;
  raw: string;
};
export type MemoryCitationView = {
  text: string;
  entries: MemoryCitationEntry[];
  rolloutIds: string[];
};
export type InspectDetail = {
  inputMeta: string;
  inputBlockLabel?: string;
  inputBlock?: string;
  imageUrls?: string[];
  memoryCitation?: MemoryCitationView;
  outputMeta?: string;
  outputBlockLabel?: string;
  outputBlock?: string;
  rawBlockLabel?: string;
  rawBlock?: string;
};
export type WebToolPresenter = {
  render?: (args: Record<string, unknown>, status?: CodexRecordView["status"]) => React.ReactNode | null;
  inspect?: (args: Record<string, unknown>, output: string) => InspectDetail | null;
};
export type ParsedToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type SystemStatus = {
  model: string | null;
  modelReasoningEffort: string | null;
  contextWindowTokens: number | null;
};

export type RateLimitWindow = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
};

export type ThreadUsage = {
  context: {
    usedTokens: number;
    windowTokens: number;
  } | null;
  primaryRateLimit: RateLimitWindow | null;
  secondaryRateLimit: RateLimitWindow | null;
  observedAt: string | null;
};
