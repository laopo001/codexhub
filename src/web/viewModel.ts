import type React from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { CodexRecord } from "../core/codexRecord.js";
import type {
  ActivityStatusView,
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
  SessionView,
  SshConnection,
  SshHost,
  TaskDraft,
  ThreadGoalView,
  ThreadPickerState,
  TurnUiState,
  WebRecordView
} from "./types.js";

export type MaybePromise<T = void> = T | Promise<T>;

export type ModelOption = {
  value: string;
  label: string;
};

export type TaskPatchInput = Partial<Pick<LocalTask, "enabled" | "input" | "name" | "schedule" | "threadId">>;

export type ThreadTabItem = {
  key: string;
  label: React.ReactNode;
};

export type TurnStatusScope = {
  key: string;
  records: CodexRecord[];
};

export type ThreadGoalUpdateInput = Partial<Pick<ThreadGoalView, "objective" | "status" | "tokenBudget">>;

export type AppSidebarViewModel = {
  activeProjectKey: string;
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
  openProjectPicker: (machine: ProjectMachineGroup) => MaybePromise;
  parentRegistration: ParentRegistrationStatus;
  parentRegistrationBusy: boolean;
  parentRegistrationDraft: ParentRegistrationDraft;
  parentRegistrationError: string;
  patchTask: (taskId: string, input: TaskPatchInput) => MaybePromise;
  plugins: PluginSummary[];
  projectGroups: ProjectMachineGroup[];
  projectList: ProjectSummary[];
  projectOpenError: string;
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
  serverShareCopied: boolean;
  setConnectionMode: React.Dispatch<React.SetStateAction<ConnectionMode>>;
  setOfflineProjectsCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setParentRegistrationDraft: React.Dispatch<React.SetStateAction<ParentRegistrationDraft>>;
  setProjectSearch: React.Dispatch<React.SetStateAction<string>>;
  setSshHostDraft: React.Dispatch<React.SetStateAction<string>>;
  setTaskDraft: React.Dispatch<React.SetStateAction<TaskDraft>>;
  setTaskFormOpen: React.Dispatch<React.SetStateAction<boolean>>;
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
  activeProjectSession?: SessionView;
  activeThread?: OpenThreadState;
  activeThreadIsOpen: boolean;
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
  effectiveModelSelection: ModelSelection;
  effectiveReasoningSelection: ReasoningSelection;
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
  messagesRef: React.RefObject<VirtuosoHandle | null>;
  messagesScrollerRef: React.RefObject<HTMLElement | null>;
  modelOptions: ModelOption[];
  openMessageContextMenu: (
    event: React.MouseEvent,
    threadId: string,
    message: WebRecordView,
    canInspect: boolean
  ) => void;
  openThreadPicker: (session: SessionView) => MaybePromise;
  pasteThreadImages: (threadId: string, clipboardData: DataTransfer) => boolean;
  projectPicker: ProjectPickerState | null;
  removeThreadImage: (threadId: string, attachmentId: string) => void;
  removeThreadTextAttachment: (threadId: string, attachmentId: string) => void;
  renderComposerSessionControls: (mode: "inline" | "popover") => React.ReactNode;
  resetComposerHistory: (threadId: string) => void;
  resizeComposerTextarea: (textarea: HTMLTextAreaElement | null) => void;
  rollbackMessage: (threadId: string, messageId: string) => MaybePromise;
  saveGoalDialog: () => MaybePromise;
  send: (threadId: string) => MaybePromise;
  sessionDialogOpen: boolean;
  sessionList: SessionView[];
  sessionMenuOpen: boolean;
  openThreads: OpenThreadState[];
  setAuthTokenDraft: React.Dispatch<React.SetStateAction<string>>;
  setComposerMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerMode: React.Dispatch<React.SetStateAction<ComposerMode>>;
  setExpandedStatusKeys: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setGoalDialog: React.Dispatch<React.SetStateAction<GoalDialogState | null>>;
  setHiddenStatusTurns: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setInspectMessage: React.Dispatch<React.SetStateAction<WebRecordView | null>>;
  setMessageContextMenu: React.Dispatch<React.SetStateAction<MessageContextMenuState | null>>;
  setMessageDisplayMode: React.Dispatch<React.SetStateAction<MessageDisplayMode>>;
  setProjectPicker: React.Dispatch<React.SetStateAction<ProjectPickerState | null>>;
  setSelectedModel: React.Dispatch<React.SetStateAction<ModelSelection>>;
  setSelectedReasoning: React.Dispatch<React.SetStateAction<ReasoningSelection>>;
  setSessionDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadPicker: React.Dispatch<React.SetStateAction<ThreadPickerState | null>>;
  showComposerSendButton: boolean;
  showInlineStatusPanel: boolean;
  sidebarCollapsed: boolean;
  simpleStatuses: ActivityStatusView[];
  statusScopeKey: string;
  stopTurn: (threadId: string) => MaybePromise;
  submitAuthToken: (event: React.FormEvent<HTMLFormElement>) => void;
  submitProjectPickerPath: (event: React.FormEvent<HTMLFormElement>) => MaybePromise;
  switchSessionThread: (threadId: string) => MaybePromise;
  threadOrderBySession: Record<string, string[]>;
  threadPicker: ThreadPickerState | null;
  turnUiState: TurnUiState;
  updateMessageRenderMode: (messageId: string, mode: MessageRenderMode) => void;
  updateThreadInput: (threadId: string, input: string) => void;
  updateThreadGoal: (threadId: string, goal: ThreadGoalUpdateInput) => MaybePromise<boolean>;
  openThreadEmptyMessage: string;
  openThreadTabs: ThreadTabItem[];
};
