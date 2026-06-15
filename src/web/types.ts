import type React from "react";
import type { CodexRecord } from "../core/codexRecord.js";
import type { CodexRecordView } from "../core/codexRecordView.js";
import type {
  MachineDirectoryListing as ApiMachineDirectoryListing,
  MachineSummary as ApiMachineSummary,
  ParentRegistrationStatus as ApiParentRegistrationStatus,
  PluginSummary as ApiPluginSummary,
  ProjectSummary as ApiProjectSummary,
  ProjectsPayload as ApiProjectsPayload,
  ReasoningEffort as ApiReasoningEffort,
  SessionSummary as ApiSessionSummary,
  SessionView as ApiSessionView,
  SshConnectionSummary,
  SshHostSummary,
  StoredTask,
  StoredTaskRun,
  TaskRunStatus,
  ThreadCandidateSummary,
  ThreadDetail as ApiThreadDetail,
  ThreadRateLimits,
  ThreadRateLimitUsage,
  ThreadSummary as ApiThreadSummary,
  ThreadUsage as ApiThreadUsage,
  Usage as ApiUsage
} from "../shared/apiContract.js";
import type { CompactRecordView } from "../shared/compactRecordViews.js";

export type ThreadSummary = ApiThreadSummary;
export type ThreadDetail = ApiThreadDetail;

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

export type SessionSummary = ApiSessionSummary;
export type SessionView = ApiSessionView;
export type MachineSummary = ApiMachineSummary;
export type MachineDirectoryListing = ApiMachineDirectoryListing;
export type MachineDirectoryEntry = MachineDirectoryListing["entries"][number];
export type SshHost = SshHostSummary;
export type SshConnection = SshConnectionSummary;
export type ParentRegistrationStatus = ApiParentRegistrationStatus;

export type ParentRegistrationDraft = {
  url: string;
  machineId: string;
  name: string;
};

export type PluginSummary = ApiPluginSummary;

export type CodexThreadCandidate = ThreadCandidateSummary;
export type ProjectSummary = ApiProjectSummary;
export type LocalTaskStatus = TaskRunStatus;
export type LocalTaskRun = StoredTaskRun;
export type LocalTask = StoredTask & {
  nextRunAt?: string | null;
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
  machineId: string;
  machineType: NonNullable<MachineSummary["type"]>;
  label: string;
  online: boolean;
  projectLauncher: boolean;
  badgeLabel: string;
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

export type ProjectsPayload = ApiProjectsPayload;

export type OpenThreadState = ThreadDetail & {
  composerMode: ComposerMode;
  modelDraft: ModelSelection;
  reasoningDraft: ReasoningSelection;
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

export type AppSettings = {
  taskCompleteSystemNotifications: boolean;
};

export type StreamEvent = {
  seq: number;
  kind: "thread" | "record" | "done";
  historical?: boolean;
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
  registration?: ParentRegistrationStatus;
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

export type Usage = ApiUsage;

export type ReasoningEffort = ApiReasoningEffort;
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

export type RateLimitWindow = ThreadRateLimitUsage;
export type SessionRateLimits = ThreadRateLimits;
export type ThreadUsage = ApiThreadUsage;
