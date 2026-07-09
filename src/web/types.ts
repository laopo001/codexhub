import type React from "react";
import type {
  ConnectionsStreamEvent as ApiConnectionsStreamEvent,
  CommandPalette as ApiCommandPalette,
  CommandPaletteEntry as ApiCommandPaletteEntry,
  MachineDirectoryListing as ApiMachineDirectoryListing,
  MachineSummary as ApiMachineSummary,
  ModelCatalogItem as ApiModelCatalogItem,
  ParentRegistrationStatus as ApiParentRegistrationStatus,
  PluginSummary as ApiPluginSummary,
  ProjectSummary as ApiProjectSummary,
  ProjectsPayload as ApiProjectsPayload,
  ReasoningEffort as ApiReasoningEffort,
  RealtimeMessage as ApiRealtimeMessage,
  SessionStreamEvent as ApiSessionStreamEvent,
  SessionSummary as ApiSessionSummary,
  SessionView as ApiSessionView,
  SshConnectionSummary,
  SshHostSummary,
  StoredTaskRun,
  TaskRunStatus,
  TasksStreamEvent as ApiTasksStreamEvent,
  TaskView as ApiTaskView,
  ThreadCandidateSummary,
  ThreadDetail as ApiThreadDetail,
  ThreadGoalStatus,
  ThreadRateLimits,
  ThreadRateLimitUsage,
  ThreadStreamEvent as ApiThreadStreamEvent,
  ThreadSummary as ApiThreadSummary,
  ThreadUsage as ApiThreadUsage,
  Usage as ApiUsage
} from "../shared/apiContract.js";
import type { CompactRecordView } from "../shared/compactRecordViews.js";
import type { CodexRecordView } from "../shared/recordTypes.js";
import type { TaskCompleteNotification as ApiTaskCompleteNotification } from "../shared/taskNotifications.js";
import type { ThreadApprovalPolicy } from "../shared/usageTypes.js";

export type ThreadSummary = ApiThreadSummary;
export type ThreadDetail = ApiThreadDetail;

export type ThreadGoalView = {
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget?: number;
  updatedAt?: string;
};

export type GoalDialogState = {
  threadId: string;
  objective: string;
  targetRemainingPercent: string;
  saving: boolean;
  error: string;
};

export type ThreadRenameDialogState = {
  threadId: string;
  title: string;
  saving: boolean;
  error: string;
};

export type SessionSummary = ApiSessionSummary;
export type SessionView = ApiSessionView;
export type ModelCatalogItem = ApiModelCatalogItem;
export type CommandPalette = ApiCommandPalette;
export type CommandPaletteEntry = ApiCommandPaletteEntry;
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
export type LocalTask = ApiTaskView;

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
  searchQuery: string;
  acting: "new" | "worktree" | string | null;
  worktreeBranch: string;
  worktreeBaseRef: string;
  worktreePath: string;
};

export type ProjectsPayload = ApiProjectsPayload;

export type OpenThreadState = ThreadDetail & {
  composerMode: ComposerMode;
  modelDraft: ModelSelection;
  reasoningDraft: ReasoningSelection;
  serviceTierDraft: ServiceTierSelection;
  approvalPolicyDraft: ApprovalPolicyDraft;
  sandboxPolicyDraft: SandboxPolicyDraft;
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

export type ThreadTabContextMenuState = {
  x: number;
  y: number;
  threadId: string;
};

export type AppSettings = {
  taskCompleteSystemNotifications: boolean;
};

export type StreamEvent = ApiThreadStreamEvent;

export type TaskCompleteNotification = ApiTaskCompleteNotification;

export type SessionStreamEvent = ApiSessionStreamEvent;
export type TasksStreamEvent = ApiTasksStreamEvent;
export type ConnectionsStreamEvent = ApiConnectionsStreamEvent;
export type RealtimeMessage = ApiRealtimeMessage;

export type Usage = ApiUsage;

export type ReasoningEffort = ApiReasoningEffort;
export type ThreadStatus = "running" | "idle";
export type ModelSelection = string;
export type ReasoningSelection = "auto" | ReasoningEffort;
export type ServiceTierSelection = string;
export type ApprovalPolicySelection = ThreadApprovalPolicy;
export type SandboxPolicySelection = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicyDraft = "auto" | ApprovalPolicySelection;
export type SandboxPolicyDraft = "auto" | SandboxPolicySelection;
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
export type ThreadTurnMeta = {
  status: "running" | "idle";
  duration: string;
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
  render?: (
    args: Record<string, unknown>,
    status?: CodexRecordView["status"],
    statusText?: string,
    statusDurationMs?: number
  ) => React.ReactNode | null;
  inspect?: (args: Record<string, unknown>, output: string) => InspectDetail | null;
};
export type ParsedToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type SystemStatus = {
  model: string | null;
  modelReasoningEffort: string | null;
  serviceTier: string | null;
  contextWindowTokens: number | null;
};

export type RateLimitWindow = ThreadRateLimitUsage;
export type SessionRateLimits = ThreadRateLimits;
export type ThreadUsage = ApiThreadUsage;
