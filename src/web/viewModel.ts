import type React from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type {
  AppServerApprovalDecision,
  AppServerUserInputAnswers,
  TaskUpdateInput as ApiTaskUpdateInput,
  ThreadGoalUpdateInput as ApiThreadGoalUpdateInput
} from "../shared/apiContract.js";
import type { CodexRecord } from "../shared/recordTypes.js";
import type {
  ActivityStatusView,
  AppSettings,
  ApprovalPolicyDraft,
  ApprovalPolicySelection,
  OpenThreadState,
  CodexThreadCandidate,
  ComposerMode,
  ConnectionMode,
  GoalDialogState,
  LocalTask,
  MachineSummary,
  MessageContextMenuState,
  MessageDisplayMode,
  MessageRenderMode,
  ModelSelection,
  ParentRegistrationDraft,
  ParentRegistrationStatus,
  PluginSummary,
  ProjectMachineGroup,
  ProjectPickerState,
  ProjectSummary,
  ReasoningSelection,
  SandboxPolicyDraft,
  SandboxPolicySelection,
  ServiceTierSelection,
  SessionView,
  SshConnection,
  SshHost,
  TaskDraft,
  ThreadGoalView,
  ThreadPickerState,
  ThreadRenameDialogState,
  ThreadTabContextMenuState,
  ThreadTurnMeta,
  TurnUiState,
  WebRecordView
} from "./types.js";

export type MaybePromise<T = void> = T | Promise<T>;

export type ModelOption = {
  value: string;
  label: string;
};

export type TaskPatchInput = ApiTaskUpdateInput;

export type ThreadTabItem = {
  key: string;
  label: React.ReactNode;
};

export type TurnStatusScope = {
  key: string;
  records: CodexRecord[];
};

export type ThreadGoalUpdateInput = ApiThreadGoalUpdateInput;

export type AppSidebarViewModel = {
  activeProjectKey: string;
  appSettings: AppSettings;
  addSshHost: (event: React.FormEvent<HTMLFormElement>) => MaybePromise;
  collapsedProjectMachineKeys: string[];
  connectionMode: ConnectionMode;
  connectParentRegistration: (event: React.FormEvent<HTMLFormElement>) => MaybePromise;
  connectSshHost: (host: string, name?: string) => MaybePromise;
  copyCurrentServerShareUrl: () => MaybePromise;
  copyRegisteredCommand: () => MaybePromise;
  createTask: (event: React.FormEvent<HTMLFormElement>) => MaybePromise;
  currentServerShareUrl: string;
  deleteProject: (project: ProjectSummary) => MaybePromise;
  deleteTask: (taskId: string) => MaybePromise;
  deletingProjectId: string;
  disconnectParentRegistration: () => MaybePromise;
  focusTaskDraftProject: (project: Pick<ProjectSummary, "machineId" | "path">) => void;
  localMachines: MachineSummary[];
  machines: MachineSummary[];
  offlineProjectsCollapsed: boolean;
  onlineMachines: MachineSummary[];
  openingProjectKey: string;
  showProjectPicker: (machine: ProjectMachineGroup) => MaybePromise;
  parentRegistration: ParentRegistrationStatus;
  parentRegistrationBusy: boolean;
  parentRegistrationDraft: ParentRegistrationDraft;
  parentRegistrationError: string;
  patchTask: (taskId: string, input: TaskPatchInput) => MaybePromise;
  plugins: PluginSummary[];
  projectGroups: ProjectMachineGroup[];
  projectList: ProjectSummary[];
  projectScopeLocked: boolean;
  projectActionError: string;
  projectSearch: string;
  registeredCommand: string;
  registeredCommandIncludesToken: boolean;
  registeredCommandCopied: boolean;
  registeredMachines: MachineSummary[];
  removeSshHost: (host: SshHost, activeConnection?: SshConnection) => MaybePromise;
  runTaskNow: (task: LocalTask) => MaybePromise;
  selectedProject?: ProjectSummary | null;
  selectProject: (project: ProjectSummary) => MaybePromise;
  selectProjectSession: (session: SessionView) => MaybePromise;
  selectSessionThread: (session: SessionView, threadId: string) => MaybePromise;
  sessionList: SessionView[];
  serverShareCopied: boolean;
  settingsDialogOpen: boolean;
  setAppSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  setConnectionMode: React.Dispatch<React.SetStateAction<ConnectionMode>>;
  setOfflineProjectsCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setParentRegistrationDraft: React.Dispatch<React.SetStateAction<ParentRegistrationDraft>>;
  setProjectSearch: React.Dispatch<React.SetStateAction<string>>;
  setSshHostDraft: React.Dispatch<React.SetStateAction<string>>;
  setTaskDraft: React.Dispatch<React.SetStateAction<TaskDraft>>;
  setTaskFormOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  stopSshConnection: (connectionId: string) => MaybePromise;
  sshConfigHostOptions: SshHost[];
  sshConfigHosts: SshHost[];
  sshConnectingHost: string;
  sshConnections: SshConnection[];
  sshError: string;
  sshHostBusy: string;
  sshHostDraft: string;
  sshHosts: SshHost[];
  taskBusyId: string;
  taskDraft: TaskDraft;
  taskError: string;
  taskFormOpen: boolean;
  tasks: LocalTask[];
  toggleProjectMachineGroup: (key: string) => void;
  toggleProjectPinned: (project: ProjectSummary) => MaybePromise;
  updateTaskDraftMachine: (machineId: string) => void;
  updateTaskDraftProject: (projectPath: string) => void;
};

export type AppViewModel = AppSidebarViewModel & {
  activeCanSend: boolean;
  activeCanStop: boolean;
  activeCanSubmit: boolean;
  activeDisplayThreadId: string;
  activeExpandedStatusKeys: Set<string>;
  activeGoal: ThreadGoalView | null;
  activeRuntimeSession?: SessionView;
  activeRunningTurnDuration: string;
  activeThread?: OpenThreadState;
  activeThreadIsOpen: boolean;
  activeThreadTurnMeta: ThreadTurnMeta | null;
  activeUserMessageHistory: string[];
  activeViews: WebRecordView[];
  activeWorkspacePath: string;
  addContextSelectionToConversation: () => void;
  addThreadFiles: (threadId: string, files: FileList | null) => MaybePromise;
  addThreadImages: (threadId: string, files: FileList | null) => MaybePromise;
  authError: string;
  authRequired: boolean;
  authTokenDraft: string;
  changeProjectPickerMachine: (machineId: string) => MaybePromise;
  chooseThreadCandidate: (candidate: CodexThreadCandidate) => MaybePromise;
  clearThreadGoal: (threadId: string) => MaybePromise;
  closeThread: (threadId: string) => MaybePromise;
  composerMenuOpen: boolean;
  composerMode: ComposerMode;
  composerTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  confirmProjectPicker: () => MaybePromise;
  copyContextSelection: () => MaybePromise;
  createSessionThread: () => MaybePromise;
  createWorktreeThread: () => MaybePromise;
  effectiveModelSelection: ModelSelection;
  effectiveReasoningSelection: ReasoningSelection;
  effectiveServiceTierSelection: ServiceTierSelection;
  forkMessage: (threadId: string, messageId: string) => MaybePromise;
  goalDialog: GoalDialogState | null;
  handleComposerKeyDown: (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    threadId: string,
    history: string[]
  ) => void;
  imageFileInputRef: React.RefObject<HTMLInputElement | null>;
  inspectContextMessage: () => void;
  inspectMessage: WebRecordView | null;
  latestTurnStatusScope: TurnStatusScope;
  loadProjectPickerDirectory: (machineId: string, path: string) => MaybePromise;
  messageContextMenu: MessageContextMenuState | null;
  messageDisplayMode: MessageDisplayMode;
  messageRenderModes: Record<string, MessageRenderMode>;
  activeThreadApprovalPolicySelection?: ApprovalPolicySelection;
  activeThreadModelDraft: ModelSelection;
  activeThreadReasoningDraft: ReasoningSelection;
  activeThreadServiceTierDraft: ServiceTierSelection;
  activeThreadSandboxPolicySelection?: SandboxPolicySelection;
  messagesRef: React.RefObject<VirtuosoHandle | null>;
  messagesShouldFollowRef: React.MutableRefObject<boolean>;
  modelOptions: ModelOption[];
  reasoningOptions: ModelOption[];
  serviceTierOptions: ModelOption[];
  openMessageContextMenu: (
    event: React.MouseEvent,
    threadId: string,
    message: WebRecordView,
    canInspect: boolean
  ) => void;
  openThreadPicker: (session: SessionView, workingDirectory?: string) => MaybePromise;
  openSelectedProjectThreadPicker: () => MaybePromise;
  pasteThreadImages: (threadId: string, clipboardData: DataTransfer) => boolean;
  projectPicker: ProjectPickerState | null;
  clearThreadAttachments: (threadId: string) => void;
  removeThreadImage: (threadId: string, attachmentId: string) => void;
  removeThreadTextAttachment: (threadId: string, attachmentId: string) => void;
  renderComposerThreadControls: (mode: "inline" | "popover") => React.ReactNode;
  resetComposerHistory: (threadId: string) => void;
  respondToApproval: (threadId: string, approvalId: string, decision: AppServerApprovalDecision) => MaybePromise;
  respondToUserInput: (threadId: string, userInputId: string, answers: AppServerUserInputAnswers) => MaybePromise;
  reviewThread: (threadId: string) => MaybePromise;
  resizeComposerTextarea: (textarea: HTMLTextAreaElement | null) => void;
  rollbackMessage: (threadId: string, messageId: string) => MaybePromise;
  saveGoalDialog: () => MaybePromise;
  saveThreadRenameDialog: () => MaybePromise;
  send: (threadId: string) => MaybePromise;
  threadModelDialogOpen: boolean;
  sessionList: SessionView[];
  threadControlsMenuOpen: boolean;
  threadRenameDialog: ThreadRenameDialogState | null;
  threadTabContextMenu: ThreadTabContextMenuState | null;
  openThreads: OpenThreadState[];
  setAuthTokenDraft: React.Dispatch<React.SetStateAction<string>>;
  setComposerMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerMode: (mode: ComposerMode) => void;
  setExpandedStatusKeys: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setExpandedToolBatchKeys: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setGoalDialog: React.Dispatch<React.SetStateAction<GoalDialogState | null>>;
  setHiddenStatusTurns: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setInspectMessage: React.Dispatch<React.SetStateAction<WebRecordView | null>>;
  setMessageContextMenu: React.Dispatch<React.SetStateAction<MessageContextMenuState | null>>;
  setMessageDisplayMode: React.Dispatch<React.SetStateAction<MessageDisplayMode>>;
  setProjectPicker: React.Dispatch<React.SetStateAction<ProjectPickerState | null>>;
  setActiveThreadApprovalPolicyDraft: React.Dispatch<React.SetStateAction<ApprovalPolicyDraft>>;
  setActiveThreadModelDraft: React.Dispatch<React.SetStateAction<ModelSelection>>;
  setActiveThreadReasoningDraft: React.Dispatch<React.SetStateAction<ReasoningSelection>>;
  setActiveThreadServiceTierDraft: React.Dispatch<React.SetStateAction<string>>;
  setActiveThreadSandboxPolicyDraft: React.Dispatch<React.SetStateAction<SandboxPolicyDraft>>;
  setThreadModelDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadControlsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadRenameDialog: React.Dispatch<React.SetStateAction<ThreadRenameDialogState | null>>;
  setThreadTabContextMenu: React.Dispatch<React.SetStateAction<ThreadTabContextMenuState | null>>;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadPicker: React.Dispatch<React.SetStateAction<ThreadPickerState | null>>;
  showComposerSendButton: boolean;
  showInlineStatusPanel: boolean;
  sidebarCollapsed: boolean;
  statusPanelAvailable: boolean;
  statusScopeKey: string;
  stopTurn: (threadId: string) => MaybePromise;
  submitAuthToken: (event: React.FormEvent<HTMLFormElement>) => void;
  submitProjectPickerPath: (event: React.FormEvent<HTMLFormElement>) => MaybePromise;
  switchSessionThread: (threadId: string) => MaybePromise;
  threadOrderBySession: Record<string, string[]>;
  threadPicker: ThreadPickerState | null;
  turnStatusItems: ActivityStatusView[];
  turnUiState: TurnUiState;
  updateMessageRenderMode: (messageId: string, mode: MessageRenderMode) => void;
  updateThreadInput: (threadId: string, input: string) => void;
  updateThreadGoal: (threadId: string, goal: ThreadGoalUpdateInput) => MaybePromise<boolean>;
  openThreadEmptyMessage: string;
  openThreadTabs: ThreadTabItem[];
};
