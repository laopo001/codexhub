import type React from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type {
  AppServerApprovalDecision,
  AppServerUserInputAnswers,
  CommandPalette,
  TaskUpdateInput as ApiTaskUpdateInput,
  ThreadGoalUpdateInput as ApiThreadGoalUpdateInput
} from "../shared/apiContract.js";
import type { ComposerDraftStore, SidebarDraftStore, TurnActivityScope } from "./appHelpers.js";
import type {
  ActivityStatusView,
  AppSettings,
  ApprovalPolicyDraft,
  ApprovalPolicySelection,
  ApprovalsReviewerDraft,
  ApprovalsReviewerSelection,
  OpenThreadState,
  CodexThreadCandidate,
  ComposerMode,
  ConnectionMode,
  GoalDialogState,
  ImagePreviewState,
  LocalTask,
  MachineSummary,
  MessageContextMenuState,
  MessageRenderMode,
  ModelSelection,
  ParentRegistrationStatus,
  ProjectMachineGroup,
  ProjectPickerState,
  ProjectSummary,
  ReasoningSelection,
  PermissionProfileDraft,
  PermissionProfileCatalogLoadState,
  PermissionProfileSummary,
  ServiceTierSelection,
  RuntimeSummary,
  SshConnection,
  SshHost,
  SubagentThreadDialogState,
  SubagentThreadOpenOptions,
  SystemStatus,
  ThreadGoalView,
  ThreadPickerState,
  ThreadRenameDialogState,
  ThreadTabContextMenuState,
  ThreadExecutionMeta,
  WebRecordView
} from "./types.js";

export type MaybePromise<T = void> = T | Promise<T>;

export type ModelOption = {
  value: string;
  label: string;
  searchText?: string;
  description?: string;
};

export type TaskPatchInput = ApiTaskUpdateInput;

export type ThreadTabItem = {
  key: string;
  label: React.ReactNode;
};

export type ThreadGoalUpdateInput = ApiThreadGoalUpdateInput;

export type AppConnectionsViewModel = {
  addSshHost: (event: React.FormEvent<HTMLFormElement>) => MaybePromise;
  connectionMode: ConnectionMode;
  connectParentRegistration: (event: React.FormEvent<HTMLFormElement>) => MaybePromise;
  connectSshHost: (host: string, name?: string) => MaybePromise;
  copyCurrentServerShareUrl: () => MaybePromise;
  copyRegisteredCommand: () => MaybePromise;
  currentServerShareUrl: string;
  disconnectParentRegistration: () => MaybePromise;
  localMachines: MachineSummary[];
  machines: MachineSummary[];
  parentRegistration: ParentRegistrationStatus;
  parentRegistrationBusy: boolean;
  parentRegistrationError: string;
  registeredCommand: string;
  registeredCommandIncludesToken: boolean;
  registeredCommandCopied: boolean;
  registeredMachines: MachineSummary[];
  removeSshHost: (host: SshHost, activeConnection?: SshConnection) => MaybePromise;
  runtimeList: RuntimeSummary[];
  serverShareCopied: boolean;
  sidebarDraftStore: SidebarDraftStore;
  setConnectionMode: React.Dispatch<React.SetStateAction<ConnectionMode>>;
  stopSshConnection: (connectionId: string) => MaybePromise;
  sshConfigHostOptions: SshHost[];
  sshConfigHosts: SshHost[];
  sshConnectingHost: string;
  sshConnections: SshConnection[];
  sshError: string;
  sshHostBusy: string;
  sshHosts: SshHost[];
};

export type AppTaskDialogViewModel = {
  createTask: () => MaybePromise;
  deleteTask: (taskId: string) => MaybePromise;
  focusTaskDraftProject: (project: Pick<ProjectSummary, "machineId" | "path">) => void;
  machines: MachineSummary[];
  patchTask: (taskId: string, input: TaskPatchInput) => MaybePromise<boolean>;
  projectList: ProjectSummary[];
  projectScopeLocked: boolean;
  runTaskNow: (task: LocalTask) => MaybePromise;
  openTaskRunThread: (threadId: string) => MaybePromise;
  runtimeList: RuntimeSummary[];
  selectedProject?: ProjectSummary | null;
  sidebarDraftStore: SidebarDraftStore;
  setTaskFormOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTasksDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  taskBusyId: string;
  taskError: string;
  taskFormOpen: boolean;
  tasks: LocalTask[];
  tasksDialogOpen: boolean;
  updateTaskDraftMachine: (machineId: string) => void;
  updateTaskDraftProject: (projectPath: string) => void;
};

export type AppSidebarViewModel = {
  activeProjectKey: string;
  collapsedProjectMachineKeys: string[];
  deleteProject: (project: ProjectSummary) => MaybePromise;
  deletingProjectId: string;
  machines: MachineSummary[];
  offlineProjectsCollapsed: boolean;
  openingProjectKey: string;
  showProjectPicker: (machine: ProjectMachineGroup) => MaybePromise;
  projectGroups: ProjectMachineGroup[];
  projectScopeLocked: boolean;
  projectActionError: string;
  selectProject: (project: ProjectSummary) => MaybePromise;
  sidebarDraftStore: SidebarDraftStore;
  setOfflineProjectsCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTasksDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggleProjectMachineGroup: (key: string) => void;
  toggleProjectPinned: (project: ProjectSummary) => MaybePromise;
};

export type AppViewModelSource = AppSidebarViewModel & AppTaskDialogViewModel & AppConnectionsViewModel & {
  appSettings: AppSettings;
  onlineMachines: MachineSummary[];
  systemStatus: SystemStatus;
  openPetPicker: () => void;
  petEnabled: boolean;
  petName: string;
  activeCanStop: boolean;
  activeDisplayThreadId: string;
  activeExpandedStatusKeys: Set<string>;
  activeGoal: ThreadGoalView | null;
  activeRuntime?: RuntimeSummary;
  activeThread?: OpenThreadState;
  activeThreadIsOpen: boolean;
  activeThreadExecutionMeta: ThreadExecutionMeta | null;
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
  compactThread: (threadId: string) => MaybePromise;
  commandPaletteByScope: Record<string, CommandPalette>;
  commandPaletteLoadingScopes: Record<string, boolean>;
  composerDraftStore: ComposerDraftStore;
  composerMenuOpen: boolean;
  composerMode: ComposerMode;
  composerTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  confirmProjectPicker: () => MaybePromise;
  copyContextSelection: () => MaybePromise;
  createMachineThread: () => MaybePromise;
  createWorktreeThread: () => MaybePromise;
  threadModelDialogModelSelection: ModelSelection;
  threadModelDialogReasoningSelection: ReasoningSelection;
  threadModelDialogServiceTierSelection: ServiceTierSelection;
  expandedStatusKeys: Record<string, string[]>;
  expandedStatusTurns: Record<string, string>;
  expandedToolBatchKeys: Record<string, string[]>;
  forkingMessageKey: string;
  forkMessage: (threadId: string, messageId: string) => MaybePromise;
  goalDialog: GoalDialogState | null;
  handleComposerKeyDown: (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    threadId: string,
    history: string[],
    canSend: boolean
  ) => void;
  imageFileInputRef: React.RefObject<HTMLInputElement | null>;
  imagePreview: ImagePreviewState | null;
  inspectContextMessage: () => void;
  inspectMessage: WebRecordView | null;
  latestTurnActivityScope: TurnActivityScope;
  loadCommandPalette: (machineId: string, cwd: string) => MaybePromise;
  loadOlderThread: (threadId: string) => MaybePromise<number>;
  loadProjectPickerDirectory: (machineId: string, path: string) => MaybePromise;
  messageContextMenu: MessageContextMenuState | null;
  messageRenderModes: Record<string, MessageRenderMode>;
  activeThreadApprovalPolicySelection?: ApprovalPolicySelection;
  activeThreadApprovalPolicyDraft: ApprovalPolicyDraft;
  activeThreadApprovalPolicyKind?: "auto" | "untrusted" | "on-request" | "never" | "granular";
  activeThreadApprovalsReviewerDraft: ApprovalsReviewerDraft;
  activeThreadApprovalsReviewerSelection?: ApprovalsReviewerSelection;
  activeThreadPermissionProfileDraft: PermissionProfileDraft;
  activeThreadPermissionProfileSelection?: string;
  activePermissionProfiles: PermissionProfileSummary[];
  activePermissionProfilesError: string;
  activePermissionProfilesStatus: "unavailable" | "idle" | "loading" | "ready" | "error";
  permissionProfilesByScope: Record<string, PermissionProfileCatalogLoadState>;
  activeModelCatalogCacheNotice: string;
  activeModelCatalogError: string;
  activeModelCatalogStatus: "unavailable" | "idle" | "loading" | "ready" | "error";
  messagesRef: React.RefObject<VirtuosoHandle | null>;
  messagesShouldFollowRef: React.MutableRefObject<boolean>;
  modelOptions: ModelOption[];
  reasoningOptions: ModelOption[];
  serviceTierOptions: ModelOption[];
  openMessageContextMenu: (
    event: React.MouseEvent,
    threadId: string,
    message: WebRecordView,
    canInspect: boolean,
    presentation?: MessageContextMenuState["presentation"]
  ) => void;
  insertThreadPathText: (
    threadId: string,
    paths: string[],
    textarea: HTMLTextAreaElement | null,
    caretIndex?: number | null
  ) => void;
  loadThreadPickerCandidates: (machineId: string) => MaybePromise;
  openThreadPicker: (session: RuntimeSummary, workingDirectory?: string) => MaybePromise;
  openSubagentThread: (threadId: string, options?: SubagentThreadOpenOptions) => MaybePromise;
  openThreadModelDialog: (threadId: string) => void;
  setThreadComposerMode: (threadId: string, mode: ComposerMode) => void;
  setThreadApprovalPolicyDraft: (
    threadId: string,
    value: React.SetStateAction<ApprovalPolicyDraft>
  ) => void;
  setThreadApprovalsReviewerDraft: (
    threadId: string,
    value: React.SetStateAction<ApprovalsReviewerDraft>
  ) => void;
  setThreadPermissionProfileDraft: (
    threadId: string,
    value: React.SetStateAction<PermissionProfileDraft>
  ) => void;
  openSelectedProjectThreadPicker: () => MaybePromise;
  pasteThreadImages: (threadId: string, clipboardData: DataTransfer) => boolean;
  projectPicker: ProjectPickerState | null;
  clearThreadAttachments: (threadId: string) => void;
  removeThreadImage: (threadId: string, attachmentId: string) => void;
  removeThreadTextAttachment: (threadId: string, attachmentId: string) => void;
  renderComposerThreadControls: (
    thread: OpenThreadState,
    mode: "inline" | "popover",
    onRequestClose?: () => void
  ) => React.ReactNode;
  resetComposerHistory: (threadId: string) => void;
  respondToApproval: (threadId: string, approvalId: string, decision: AppServerApprovalDecision) => MaybePromise;
  respondToUserInput: (threadId: string, userInputId: string, answers: AppServerUserInputAnswers) => MaybePromise;
  reviewThread: (threadId: string) => MaybePromise;
  retryModelCatalog: () => void;
  resizeComposerTextarea: (textarea: HTMLTextAreaElement | null) => void;
  saveGoalDialog: () => MaybePromise;
  saveThreadRenameDialog: () => MaybePromise;
  saveThreadRenameDialogInBackground: () => void;
  send: (threadId: string) => MaybePromise;
  subagentThreadDialog: SubagentThreadDialogState | null;
  threadModelDialogOpen: boolean;
  runtimeList: RuntimeSummary[];
  threadControlsMenuOpen: boolean;
  threadRenameDialog: ThreadRenameDialogState | null;
  threadTabContextMenu: ThreadTabContextMenuState | null;
  openThreads: OpenThreadState[];
  setAuthTokenDraft: React.Dispatch<React.SetStateAction<string>>;
  setAppSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  setComposerMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerMode: (mode: ComposerMode) => void;
  setExpandedStatusKeys: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setExpandedToolBatchKeys: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setGoalDialog: React.Dispatch<React.SetStateAction<GoalDialogState | null>>;
  setExpandedStatusTurns: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setImagePreview: React.Dispatch<React.SetStateAction<ImagePreviewState | null>>;
  setInspectMessage: React.Dispatch<React.SetStateAction<WebRecordView | null>>;
  setMessageContextMenu: React.Dispatch<React.SetStateAction<MessageContextMenuState | null>>;
  setProjectPicker: React.Dispatch<React.SetStateAction<ProjectPickerState | null>>;
  setActiveThreadApprovalPolicyDraft: React.Dispatch<React.SetStateAction<ApprovalPolicyDraft>>;
  setActiveThreadApprovalsReviewerDraft: React.Dispatch<React.SetStateAction<ApprovalsReviewerDraft>>;
  setThreadModelDialogModelDraft: React.Dispatch<React.SetStateAction<ModelSelection>>;
  setThreadModelDialogReasoningDraft: React.Dispatch<React.SetStateAction<ReasoningSelection>>;
  setThreadModelDialogServiceTierDraft: React.Dispatch<React.SetStateAction<ServiceTierSelection>>;
  setActiveThreadPermissionProfileDraft: React.Dispatch<React.SetStateAction<PermissionProfileDraft>>;
  setThreadModelDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadControlsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadRenameDialog: React.Dispatch<React.SetStateAction<ThreadRenameDialogState | null>>;
  setThreadTabContextMenu: React.Dispatch<React.SetStateAction<ThreadTabContextMenuState | null>>;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setSubagentThreadDialog: React.Dispatch<React.SetStateAction<SubagentThreadDialogState | null>>;
  setThreadPicker: React.Dispatch<React.SetStateAction<ThreadPickerState | null>>;
  settingsDialogOpen: boolean;
  showComposerSendButton: boolean;
  statusPanelExpanded: boolean;
  sidebarCollapsed: boolean;
  statusScopeKey: string;
  stopTurn: (threadId: string) => MaybePromise;
  terminateBackgroundTerminal: (threadId: string, processId: string) => MaybePromise;
  submitAuthToken: (event: React.FormEvent<HTMLFormElement>) => void;
  submitProjectPickerPath: (event: React.FormEvent<HTMLFormElement>) => MaybePromise;
  switchMachineThread: (threadId: string) => MaybePromise;
  threadOrderByMachine: Record<string, string[]>;
  threadPicker: ThreadPickerState | null;
  turnStatusItems: ActivityStatusView[];
  updateMessageRenderMode: (messageId: string, mode: MessageRenderMode) => void;
  updateThreadInput: (threadId: string, input: string) => void;
  updateThreadGoal: (threadId: string, goal: ThreadGoalUpdateInput) => MaybePromise<boolean>;
  openThreadEmptyMessage: string;
  openThreadTabs: ThreadTabItem[];
};

export type AppWorkspaceViewModel = Pick<AppViewModelSource,
  | "activeCanStop"
  | "activeExpandedStatusKeys"
  | "activeGoal"
  | "activeRuntime"
  | "activeThread"
  | "activeThreadIsOpen"
  | "activeThreadExecutionMeta"
  | "activeThreadApprovalPolicyDraft"
  | "activeThreadApprovalPolicyKind"
  | "activeThreadApprovalPolicySelection"
  | "activeThreadApprovalsReviewerDraft"
  | "activeThreadApprovalsReviewerSelection"
  | "activeThreadPermissionProfileDraft"
  | "activeThreadPermissionProfileSelection"
  | "activePermissionProfiles"
  | "activePermissionProfilesError"
  | "activePermissionProfilesStatus"
  | "permissionProfilesByScope"
  | "activeUserMessageHistory"
  | "activeViews"
  | "authError"
  | "authRequired"
  | "authTokenDraft"
  | "addThreadFiles"
  | "clearThreadAttachments"
  | "clearThreadGoal"
  | "closeThread"
  | "compactThread"
  | "commandPaletteByScope"
  | "commandPaletteLoadingScopes"
  | "composerDraftStore"
  | "composerMenuOpen"
  | "composerMode"
  | "composerTextareaRef"
  | "expandedStatusKeys"
  | "expandedStatusTurns"
  | "expandedToolBatchKeys"
  | "forkingMessageKey"
  | "forkMessage"
  | "handleComposerKeyDown"
  | "imageFileInputRef"
  | "insertThreadPathText"
  | "latestTurnActivityScope"
  | "loadCommandPalette"
  | "loadOlderThread"
  | "messageRenderModes"
  | "messagesRef"
  | "messagesShouldFollowRef"
  | "openMessageContextMenu"
  | "openSubagentThread"
  | "openThreadModelDialog"
  | "openSelectedProjectThreadPicker"
  | "openThreads"
  | "pasteThreadImages"
  | "removeThreadImage"
  | "removeThreadTextAttachment"
  | "renderComposerThreadControls"
  | "resetComposerHistory"
  | "respondToApproval"
  | "respondToUserInput"
  | "reviewThread"
  | "resizeComposerTextarea"
  | "runtimeList"
  | "selectedProject"
  | "send"
  | "threadControlsMenuOpen"
  | "setComposerMenuOpen"
  | "setComposerMode"
  | "setThreadComposerMode"
  | "setThreadApprovalPolicyDraft"
  | "setThreadApprovalsReviewerDraft"
  | "setThreadPermissionProfileDraft"
  | "setExpandedStatusKeys"
  | "setExpandedToolBatchKeys"
  | "setGoalDialog"
  | "setExpandedStatusTurns"
  | "setImagePreview"
  | "setInspectMessage"
  | "setActiveThreadApprovalPolicyDraft"
  | "setActiveThreadApprovalsReviewerDraft"
  | "setActiveThreadPermissionProfileDraft"
  | "setAuthTokenDraft"
  | "setThreadControlsMenuOpen"
  | "setThreadModelDialogOpen"
  | "setSidebarCollapsed"
  | "setSubagentThreadDialog"
  | "showComposerSendButton"
  | "statusPanelExpanded"
  | "sidebarCollapsed"
  | "statusScopeKey"
  | "turnStatusItems"
  | "stopTurn"
  | "terminateBackgroundTerminal"
  | "subagentThreadDialog"
  | "submitAuthToken"
  | "switchMachineThread"
  | "updateMessageRenderMode"
  | "updateThreadInput"
  | "updateThreadGoal"
  | "openThreadEmptyMessage"
  | "openThreadTabs"
>;

export type AppDialogsViewModel = Pick<AppViewModelSource,
  | "addContextSelectionToConversation"
  | "appSettings"
  | "systemStatus"
  | "changeProjectPickerMachine"
  | "chooseThreadCandidate"
  | "confirmProjectPicker"
  | "copyContextSelection"
  | "createMachineThread"
  | "createWorktreeThread"
  | "goalDialog"
  | "imagePreview"
  | "inspectContextMessage"
  | "inspectMessage"
  | "loadProjectPickerDirectory"
  | "loadThreadPickerCandidates"
  | "machines"
  | "addSshHost"
  | "connectionMode"
  | "connectParentRegistration"
  | "connectSshHost"
  | "copyCurrentServerShareUrl"
  | "copyRegisteredCommand"
  | "currentServerShareUrl"
  | "disconnectParentRegistration"
  | "localMachines"
  | "messageContextMenu"
  | "activeModelCatalogCacheNotice"
  | "activeModelCatalogError"
  | "activeModelCatalogStatus"
  | "threadModelDialogModelSelection"
  | "threadModelDialogReasoningSelection"
  | "threadModelDialogServiceTierSelection"
  | "modelOptions"
  | "reasoningOptions"
  | "serviceTierOptions"
  | "onlineMachines"
  | "openingProjectKey"
  | "projectPicker"
  | "retryModelCatalog"
  | "saveGoalDialog"
  | "saveThreadRenameDialog"
  | "saveThreadRenameDialogInBackground"
  | "threadModelDialogOpen"
  | "threadRenameDialog"
  | "threadTabContextMenu"
  | "settingsDialogOpen"
  | "tasksDialogOpen"
  | "runtimeList"
  | "openThreads"
  | "openPetPicker"
  | "petEnabled"
  | "petName"
  | "setGoalDialog"
  | "setImagePreview"
  | "setInspectMessage"
  | "setAppSettings"
  | "setMessageContextMenu"
  | "setProjectPicker"
  | "setThreadModelDialogModelDraft"
  | "setThreadModelDialogReasoningDraft"
  | "setThreadModelDialogServiceTierDraft"
  | "setThreadModelDialogOpen"
  | "setThreadRenameDialog"
  | "setThreadTabContextMenu"
  | "setSettingsDialogOpen"
  | "setTaskFormOpen"
  | "setTasksDialogOpen"
  | "setThreadPicker"
  | "submitProjectPickerPath"
  | "threadOrderByMachine"
  | "threadPicker"
  | "parentRegistration"
  | "parentRegistrationBusy"
  | "parentRegistrationError"
  | "registeredCommand"
  | "registeredCommandIncludesToken"
  | "registeredCommandCopied"
  | "registeredMachines"
  | "removeSshHost"
  | "serverShareCopied"
  | "setConnectionMode"
  | "stopSshConnection"
  | "sshConfigHostOptions"
  | "sshConfigHosts"
  | "sshConnectingHost"
  | "sshConnections"
  | "sshError"
  | "sshHostBusy"
  | "sshHosts"
  | "sidebarDraftStore"
  | "createTask"
  | "deleteTask"
  | "focusTaskDraftProject"
  | "patchTask"
  | "projectList"
  | "projectScopeLocked"
  | "selectedProject"
  | "runTaskNow"
  | "openTaskRunThread"
  | "taskBusyId"
  | "taskError"
  | "taskFormOpen"
  | "tasks"
  | "updateTaskDraftMachine"
  | "updateTaskDraftProject"
>;

export type AppViewModel = {
  sidebar: AppSidebarViewModel;
  workspace: AppWorkspaceViewModel;
  dialogs: AppDialogsViewModel;
};

const sidebarKeys = [
  "activeProjectKey", "collapsedProjectMachineKeys", "deleteProject", "deletingProjectId", "machines",
  "offlineProjectsCollapsed", "openingProjectKey", "showProjectPicker", "projectGroups", "projectScopeLocked",
  "projectActionError", "selectProject", "sidebarDraftStore", "setOfflineProjectsCollapsed", "setSettingsDialogOpen",
  "setTasksDialogOpen", "toggleProjectMachineGroup", "toggleProjectPinned"
] as const satisfies readonly (keyof AppSidebarViewModel)[];

const workspaceKeys = [
  "activeCanStop", "activeExpandedStatusKeys", "activeGoal", "activeRuntime", "activeThread",
  "activeThreadIsOpen", "activeThreadExecutionMeta", "activeThreadApprovalPolicyDraft",
  "activeThreadApprovalPolicyKind", "activeThreadApprovalPolicySelection",
  "activeThreadApprovalsReviewerDraft", "activeThreadApprovalsReviewerSelection",
  "activeThreadPermissionProfileDraft", "activeThreadPermissionProfileSelection",
  "activePermissionProfiles", "activePermissionProfilesError", "activePermissionProfilesStatus", "permissionProfilesByScope",
  "activeUserMessageHistory", "activeViews", "authError",
  "authRequired", "authTokenDraft", "addThreadFiles", "clearThreadAttachments", "clearThreadGoal",
  "closeThread", "compactThread", "commandPaletteByScope", "commandPaletteLoadingScopes",
  "composerDraftStore", "composerMenuOpen", "composerMode", "composerTextareaRef", "expandedStatusKeys", "expandedStatusTurns", "expandedToolBatchKeys", "forkingMessageKey", "forkMessage",
  "handleComposerKeyDown", "imageFileInputRef", "insertThreadPathText", "latestTurnActivityScope",
  "loadCommandPalette", "loadOlderThread", "messageRenderModes", "messagesRef",
  "messagesShouldFollowRef", "openMessageContextMenu", "openSubagentThread", "openThreadModelDialog", "openSelectedProjectThreadPicker",
  "openThreads",
  "pasteThreadImages", "removeThreadImage", "removeThreadTextAttachment", "renderComposerThreadControls",
  "resetComposerHistory", "respondToApproval", "respondToUserInput", "reviewThread",
  "resizeComposerTextarea", "runtimeList", "selectedProject", "send", "threadControlsMenuOpen",
  "setComposerMenuOpen", "setComposerMode", "setThreadComposerMode", "setThreadApprovalPolicyDraft",
  "setThreadApprovalsReviewerDraft", "setThreadPermissionProfileDraft", "setExpandedStatusKeys", "setExpandedToolBatchKeys",
  "setGoalDialog", "setExpandedStatusTurns", "setImagePreview", "setInspectMessage",
  "setActiveThreadApprovalPolicyDraft", "setActiveThreadApprovalsReviewerDraft",
  "setActiveThreadPermissionProfileDraft",
  "setAuthTokenDraft", "setThreadControlsMenuOpen", "setThreadModelDialogOpen", "setSidebarCollapsed", "setSubagentThreadDialog",
  "showComposerSendButton", "statusPanelExpanded", "sidebarCollapsed",
  "statusScopeKey", "turnStatusItems", "stopTurn", "terminateBackgroundTerminal", "subagentThreadDialog", "submitAuthToken", "switchMachineThread",
  "updateMessageRenderMode", "updateThreadInput", "updateThreadGoal", "openThreadEmptyMessage",
  "openThreadTabs"
] as const satisfies readonly (keyof AppWorkspaceViewModel)[];

const dialogKeys = [
  "addContextSelectionToConversation", "appSettings", "systemStatus", "changeProjectPickerMachine",
  "chooseThreadCandidate", "confirmProjectPicker", "copyContextSelection", "createMachineThread",
  "createWorktreeThread", "goalDialog", "imagePreview", "inspectContextMessage", "inspectMessage",
  "loadProjectPickerDirectory", "loadThreadPickerCandidates", "machines", "messageContextMenu",
  "addSshHost", "connectionMode", "connectParentRegistration", "connectSshHost", "copyCurrentServerShareUrl",
  "copyRegisteredCommand", "currentServerShareUrl", "disconnectParentRegistration", "localMachines",
  "activeModelCatalogCacheNotice", "activeModelCatalogError", "activeModelCatalogStatus", "threadModelDialogModelSelection",
  "threadModelDialogReasoningSelection", "threadModelDialogServiceTierSelection", "modelOptions", "reasoningOptions",
  "serviceTierOptions", "onlineMachines", "openingProjectKey", "projectPicker", "retryModelCatalog",
  "saveGoalDialog", "saveThreadRenameDialog", "saveThreadRenameDialogInBackground", "threadModelDialogOpen", "threadRenameDialog",
  "threadTabContextMenu", "settingsDialogOpen", "runtimeList", "openThreads", "setGoalDialog",
  "setImagePreview", "setInspectMessage", "setAppSettings", "setMessageContextMenu",
  "setProjectPicker", "setThreadModelDialogModelDraft", "setThreadModelDialogReasoningDraft",
  "setThreadModelDialogServiceTierDraft", "setThreadModelDialogOpen", "setThreadRenameDialog",
  "setThreadTabContextMenu", "setSettingsDialogOpen", "setThreadPicker", "submitProjectPickerPath",
  "threadOrderByMachine", "threadPicker", "openPetPicker", "petEnabled", "petName",
  "parentRegistration", "parentRegistrationBusy", "parentRegistrationError", "registeredCommand",
  "registeredCommandIncludesToken", "registeredCommandCopied", "registeredMachines", "removeSshHost",
  "serverShareCopied", "setConnectionMode", "stopSshConnection", "sshConfigHostOptions", "sshConfigHosts",
  "sshConnectingHost", "sshConnections", "sshError", "sshHostBusy", "sshHosts", "sidebarDraftStore",
  "tasksDialogOpen", "setTaskFormOpen", "setTasksDialogOpen", "createTask", "deleteTask", "focusTaskDraftProject", "patchTask",
  "projectList", "projectScopeLocked", "selectedProject", "runTaskNow", "openTaskRunThread", "taskBusyId", "taskError",
  "taskFormOpen", "tasks", "updateTaskDraftMachine", "updateTaskDraftProject"
] as const satisfies readonly (keyof AppDialogsViewModel)[];

const pickViewModel = <Source extends object, const Keys extends readonly (keyof Source)[]>(
  source: Source,
  keys: Keys
): Pick<Source, Keys[number]> => Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<Source, Keys[number]>;

export const partitionAppViewModel = (source: AppViewModelSource): AppViewModel => {
  const sidebar: AppSidebarViewModel = pickViewModel(source, sidebarKeys);
  const workspace: AppWorkspaceViewModel = pickViewModel(source, workspaceKeys);
  const dialogs: AppDialogsViewModel = pickViewModel(source, dialogKeys);
  return { sidebar, workspace, dialogs };
};
