import type React from "react";
import type {
  ConnectionsStreamEvent as ApiConnectionsStreamEvent,
  CommandPalette as ApiCommandPalette,
  CommandPaletteEntry as ApiCommandPaletteEntry,
  MachineDirectoryListing as ApiMachineDirectoryListing,
  MachineSummary as ApiMachineSummary,
  ModelCatalogItem as ApiModelCatalogItem,
  ParentRegistrationStatus as ApiParentRegistrationStatus,
  PermissionProfileSummary as ApiPermissionProfileSummary,
  PluginSummary as ApiPluginSummary,
  ProjectSummary as ApiProjectSummary,
  ProjectsPayload as ApiProjectsPayload,
  ReasoningEffort as ApiReasoningEffort,
  RealtimeMessage as ApiRealtimeMessage,
  RuntimeStreamEvent as ApiRuntimeStreamEvent,
  RuntimeSummary as ApiRuntimeSummary,
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
import type { CodexRecordView, SubagentActivityView } from "../shared/recordTypes.js";
import type { CodexHubAuthorityDescriptor } from "../shared/surfaceTypes.js";
import type { TaskCompleteNotification as ApiTaskCompleteNotification } from "../shared/taskNotifications.js";
import type { ThreadApprovalPolicy, ThreadApprovalsReviewer } from "../shared/usageTypes.js";

export type ThreadSummary = ApiThreadSummary;
export type ThreadDetail = ApiThreadDetail;
export type BackgroundTerminalView = NonNullable<ThreadDetail["backgroundTerminals"]>[number] & {
  startedAt?: string;
};

export type ThreadGoalView = {
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget?: number;
  timeUsedSeconds?: number;
  updatedAt?: string;
};

export type GoalDialogState = {
  threadId: string;
  objective: string;
  saving: boolean;
  error: string;
};

export type ThreadRenameDialogState = {
  threadId: string;
  title: string;
  generating: boolean;
  saving: boolean;
  error: string;
};

export type ThreadRenameGenerationRequest = {
  backgroundSave: boolean;
};

export type RuntimeSummary = ApiRuntimeSummary;
export type ModelCatalogItem = ApiModelCatalogItem;
type RuntimeCatalogLoadMetadata = {
  source?: "live" | "cache";
  updatedAt?: string;
  stale?: boolean;
};
export type ModelCatalogLoadState = RuntimeCatalogLoadMetadata & {
  status: "idle" | "loading" | "ready" | "error";
  models: ModelCatalogItem[];
  refresh?: boolean;
  error?: string;
};
export type PermissionProfileSummary = ApiPermissionProfileSummary;
export type PermissionProfileCatalogLoadState = {
  status: "loading" | "ready" | "error";
  profiles: PermissionProfileSummary[];
  error?: string;
};
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
  kind?: "machine" | "embeddedWorkspace";
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
  machineId: string;
  workingDirectory: string;
  preparingRuntime: boolean;
  bootstrapId?: string;
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
  approvalsReviewerDraft: ApprovalsReviewerDraft;
  permissionProfileDraft: PermissionProfileDraft;
  imageAttachments: ImageAttachment[];
  textAttachments: TextAttachment[];
  pendingUserMessages: PendingUserMessage[];
};

export type PendingUserMessage = {
  id: string;
  text: string;
  imageUrls: string[];
  createdAt: string;
};

export type SubagentThreadDialogState = {
  threadId: string;
  parentThreadId: string;
  /**
   * Retains a dialog-only parent while nested navigation is loading or failed.
   * This keeps retry routing and unsent attachments alive without opening a
   * workspace tab for either conversation.
   */
  parentDialog?: SubagentThreadDialogState;
  agentPath?: string;
  assignment?: SubagentActivityView["assignment"];
  machineId?: string;
  workingDirectory?: string;
  status: "loading" | "ready" | "error";
  thread?: OpenThreadState;
  error: string;
};

export type SubagentThreadOpenOptions = {
  parentThreadId?: string;
  agentPath?: string;
  assignment?: SubagentActivityView["assignment"];
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

export type MessageSelectionToolbarState = {
  x: number;
  y: number;
  threadId: string;
  selectedText: string;
};

export type ThreadTabContextMenuState = {
  x: number;
  y: number;
  threadId: string;
};

export type AppSettings = {
  selectedPetId: string;
  showFloatingPet: boolean;
  showDesktopPet: boolean;
  taskCompleteSystemNotifications: boolean;
  taskCompleteNotificationPersistAfterMinutes: number;
};

export type StreamEvent = ApiThreadStreamEvent;

export type TaskCompleteNotification = ApiTaskCompleteNotification;

export type RuntimeStreamEvent = ApiRuntimeStreamEvent;
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
export type ApprovalPolicyDraft = "auto" | ApprovalPolicySelection;
export type ApprovalsReviewerSelection = ThreadApprovalsReviewer;
export type ApprovalsReviewerDraft = "auto" | ApprovalsReviewerSelection;
export type PermissionProfileDraft = string | null;
export type ComposerMode = "chat" | "plan" | "goal";
export type MessageRenderMode = "markdown" | "raw";
export type ConnectionMode = "local" | "ssh" | "registered";
export type ImagePreviewState = {
  url: string;
  title?: string;
};
export type ActivityStatusView = {
  key: string;
  label: string;
  text: string;
  summaryText?: string;
  at?: string;
  status?: CodexRecordView["status"];
  files?: ActivityStatusFile[];
  steps?: ActivityStatusPlanStep[];
};
export type ActivityStatusPlanStep = {
  step: string;
  status: NonNullable<CodexRecordView["status"]>;
};
export type WebRecordView = CompactRecordView & {
  activityStatuses?: ActivityStatusView[];
};
export type ActivityStatusSnapshot = {
  targetRecordId: string;
  statuses: ActivityStatusView[];
};
export type ThreadExecutionMeta = {
  status: "waiting" | "running" | "idle";
  label: "Waiting" | "Running" | "Needs input" | "Idle";
  duration: string;
  text: string;
  startedAt?: string;
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
  version: string | null;
  authority?: CodexHubAuthorityDescriptor;
  model: string | null;
  modelReasoningEffort: string | null;
  serviceTier: string | null;
  contextWindowTokens: number | null;
};

export type RateLimitWindow = ThreadRateLimitUsage;
export type SessionRateLimits = ThreadRateLimits;
export type ThreadUsage = ApiThreadUsage;
