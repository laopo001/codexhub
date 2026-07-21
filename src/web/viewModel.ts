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
  MessageDisplayMode,
  MessageRenderMode,
  ModelSelection,
  ParentRegistrationStatus,
  ProjectMachineGroup,
  ProjectPickerState,
  ProjectSummary,
  ReasoningSelection,
  PermissionProfileDraft,
  PermissionProfileSummary,
  ServiceTierSelection,
  SessionSummary,
  SshConnection,
  SshHost,
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
  showProjectPicker: (machine: ProjectMachineGroup) => MaybePromise;
  parentRegistration: ParentRegistrationStatus;
  parentRegistrationBusy: boolean;
  parentRegistrationError: string;
  patchTask: (taskId: string, input: TaskPatchInput) => MaybePromise<boolean>;
  projectGroups: ProjectMachineGroup[];
  projectList: ProjectSummary[];
  projectScopeLocked: boolean;
  projectActionError: string;
  registeredCommand: string;
  registeredCommandIncludesToken: boolean;
  registeredCommandCopied: boolean;
  registeredMachines: MachineSummary[];
  removeSshHost: (host: SshHost, activeConnection?: SshConnection) => MaybePromise;
  runTaskNow: (task: LocalTask) => MaybePromise;
  openTaskRunThread: (threadId: string) => MaybePromise;
  selectedProject?: ProjectSummary | null;
  selectProject: (project: ProjectSummary) => MaybePromise;
  sessionList: SessionSummary[];
  serverShareCopied: boolean;
  sidebarDraftStore: SidebarDraftStore;
  setConnectionMode: React.Dispatch<React.SetStateAction<ConnectionMode>>;
  setOfflineProjectsCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setTaskFormOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  stopSshConnection: (connectionId: string) => MaybePromise;
  sshConfigHostOptions: SshHost[];
  sshConfigHosts: SshHost[];
  sshConnectingHost: string;
  sshConnections: SshConnection[];
  sshError: string;
  sshHostBusy: string;
  sshHosts: SshHost[];
  taskBusyId: string;
  taskError: string;
  taskFormOpen: boolean;
  tasks: LocalTask[];
  toggleProjectMachineGroup: (key: string) => void;
  toggleProjectPinned: (project: ProjectSummary) => MaybePromise;
  updateTaskDraftMachine: (machineId: string) => void;
  updateTaskDraftProject: (projectPath: string) => void;
};

export type AppViewModelSource = AppSidebarViewModel & {
  appSettings: AppSettings;
  openPetPicker: () => void;
  petEnabled: boolean;
  petName: string;
  activeCanStop: boolean;
  activeDisplayThreadId: string;
  activeExpandedStatusKeys: Set<string>;
  activeGoal: ThreadGoalView | null;
  activeRuntimeSession?: SessionSummary;
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
    history: string[],
    canSend: boolean
  ) => void;
  imageFileInputRef: React.RefObject<HTMLInputElement | null>;
  imagePreview: ImagePreviewState | null;
  inspectContextMessage: () => void;
  inspectMessage: WebRecordView | null;
  latestTurnActivityScope: TurnActivityScope;
  loadCommandPalette: (sessionId: string, cwd: string) => MaybePromise;
  loadProjectPickerDirectory: (machineId: string, path: string) => MaybePromise;
  messageContextMenu: MessageContextMenuState | null;
  messageDisplayMode: MessageDisplayMode;
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
  activeModelCatalogError: string;
  activeModelCatalogStatus: "unavailable" | "idle" | "loading" | "ready" | "error";
  activeThreadModelDraft: ModelSelection;
  activeThreadReasoningDraft: ReasoningSelection;
  activeThreadServiceTierDraft: ServiceTierSelection;
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
  insertThreadPathText: (
    threadId: string,
    paths: string[],
    textarea: HTMLTextAreaElement | null,
    caretIndex?: number | null
  ) => void;
  loadThreadPickerCandidates: (sessionId: string) => MaybePromise;
  openThreadPicker: (session: SessionSummary, workingDirectory?: string) => MaybePromise;
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
  retryModelCatalog: () => void;
  resizeComposerTextarea: (textarea: HTMLTextAreaElement | null) => void;
  saveGoalDialog: () => MaybePromise;
  saveThreadRenameDialog: () => MaybePromise;
  send: (threadId: string) => MaybePromise;
  threadModelDialogOpen: boolean;
  sessionList: SessionSummary[];
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
  setMessageDisplayMode: React.Dispatch<React.SetStateAction<MessageDisplayMode>>;
  setProjectPicker: React.Dispatch<React.SetStateAction<ProjectPickerState | null>>;
  setActiveThreadApprovalPolicyDraft: React.Dispatch<React.SetStateAction<ApprovalPolicyDraft>>;
  setActiveThreadApprovalsReviewerDraft: React.Dispatch<React.SetStateAction<ApprovalsReviewerDraft>>;
  setActiveThreadModelDraft: React.Dispatch<React.SetStateAction<ModelSelection>>;
  setActiveThreadReasoningDraft: React.Dispatch<React.SetStateAction<ReasoningSelection>>;
  setActiveThreadServiceTierDraft: React.Dispatch<React.SetStateAction<string>>;
  setActiveThreadPermissionProfileDraft: React.Dispatch<React.SetStateAction<PermissionProfileDraft>>;
  setThreadModelDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadControlsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadRenameDialog: React.Dispatch<React.SetStateAction<ThreadRenameDialogState | null>>;
  setThreadTabContextMenu: React.Dispatch<React.SetStateAction<ThreadTabContextMenuState | null>>;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadPicker: React.Dispatch<React.SetStateAction<ThreadPickerState | null>>;
  settingsDialogOpen: boolean;
  showComposerSendButton: boolean;
  statusPanelExpanded: boolean;
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
  | "activeRuntimeSession"
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
  | "forkMessage"
  | "handleComposerKeyDown"
  | "imageFileInputRef"
  | "insertThreadPathText"
  | "latestTurnActivityScope"
  | "loadCommandPalette"
  | "messageDisplayMode"
  | "messageRenderModes"
  | "messagesRef"
  | "messagesShouldFollowRef"
  | "openMessageContextMenu"
  | "openSelectedProjectThreadPicker"
  | "pasteThreadImages"
  | "removeThreadImage"
  | "removeThreadTextAttachment"
  | "renderComposerThreadControls"
  | "resetComposerHistory"
  | "respondToApproval"
  | "respondToUserInput"
  | "reviewThread"
  | "resizeComposerTextarea"
  | "selectedProject"
  | "send"
  | "threadControlsMenuOpen"
  | "setComposerMenuOpen"
  | "setComposerMode"
  | "setExpandedStatusKeys"
  | "setExpandedToolBatchKeys"
  | "setGoalDialog"
  | "setExpandedStatusTurns"
  | "setImagePreview"
  | "setInspectMessage"
  | "setMessageDisplayMode"
  | "setActiveThreadApprovalPolicyDraft"
  | "setActiveThreadApprovalsReviewerDraft"
  | "setActiveThreadPermissionProfileDraft"
  | "setAuthTokenDraft"
  | "setThreadControlsMenuOpen"
  | "setThreadModelDialogOpen"
  | "setSidebarCollapsed"
  | "showComposerSendButton"
  | "statusPanelAvailable"
  | "statusPanelExpanded"
  | "sidebarCollapsed"
  | "statusScopeKey"
  | "turnStatusItems"
  | "stopTurn"
  | "submitAuthToken"
  | "switchSessionThread"
  | "updateMessageRenderMode"
  | "updateThreadInput"
  | "updateThreadGoal"
  | "openThreadEmptyMessage"
  | "openThreadTabs"
>;

export type AppDialogsViewModel = Pick<AppViewModelSource,
  | "addContextSelectionToConversation"
  | "appSettings"
  | "changeProjectPickerMachine"
  | "chooseThreadCandidate"
  | "confirmProjectPicker"
  | "copyContextSelection"
  | "createSessionThread"
  | "createWorktreeThread"
  | "goalDialog"
  | "imagePreview"
  | "inspectContextMessage"
  | "inspectMessage"
  | "loadProjectPickerDirectory"
  | "loadThreadPickerCandidates"
  | "machines"
  | "messageContextMenu"
  | "activeModelCatalogError"
  | "activeModelCatalogStatus"
  | "effectiveModelSelection"
  | "effectiveReasoningSelection"
  | "effectiveServiceTierSelection"
  | "modelOptions"
  | "reasoningOptions"
  | "serviceTierOptions"
  | "onlineMachines"
  | "openingProjectKey"
  | "projectPicker"
  | "retryModelCatalog"
  | "saveGoalDialog"
  | "saveThreadRenameDialog"
  | "threadModelDialogOpen"
  | "threadRenameDialog"
  | "threadTabContextMenu"
  | "settingsDialogOpen"
  | "sessionList"
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
  | "setActiveThreadModelDraft"
  | "setActiveThreadReasoningDraft"
  | "setActiveThreadServiceTierDraft"
  | "setThreadModelDialogOpen"
  | "setThreadRenameDialog"
  | "setThreadTabContextMenu"
  | "setSettingsDialogOpen"
  | "setThreadPicker"
  | "submitProjectPickerPath"
  | "threadOrderBySession"
  | "threadPicker"
>;

export type AppViewModel = {
  sidebar: AppSidebarViewModel;
  workspace: AppWorkspaceViewModel;
  dialogs: AppDialogsViewModel;
};

const sidebarKeys = [
  "activeProjectKey", "addSshHost", "collapsedProjectMachineKeys", "connectionMode",
  "connectParentRegistration", "connectSshHost", "copyCurrentServerShareUrl", "copyRegisteredCommand",
  "createTask", "currentServerShareUrl", "deleteProject", "deleteTask", "deletingProjectId",
  "disconnectParentRegistration", "focusTaskDraftProject", "localMachines", "machines",
  "offlineProjectsCollapsed", "onlineMachines", "openingProjectKey", "showProjectPicker",
  "parentRegistration", "parentRegistrationBusy", "parentRegistrationError", "patchTask",
  "projectGroups", "projectList", "projectScopeLocked", "projectActionError", "registeredCommand",
  "registeredCommandIncludesToken", "registeredCommandCopied", "registeredMachines", "removeSshHost",
  "runTaskNow", "openTaskRunThread", "selectedProject", "selectProject", "sessionList",
  "serverShareCopied", "sidebarDraftStore", "setConnectionMode", "setOfflineProjectsCollapsed",
  "setTaskFormOpen", "setSettingsDialogOpen", "stopSshConnection", "sshConfigHostOptions",
  "sshConfigHosts", "sshConnectingHost", "sshConnections", "sshError", "sshHostBusy", "sshHosts",
  "taskBusyId", "taskError", "taskFormOpen", "tasks", "toggleProjectMachineGroup",
  "toggleProjectPinned", "updateTaskDraftMachine", "updateTaskDraftProject"
] as const satisfies readonly (keyof AppSidebarViewModel)[];

const workspaceKeys = [
  "activeCanStop", "activeExpandedStatusKeys", "activeGoal", "activeRuntimeSession", "activeThread",
  "activeThreadIsOpen", "activeThreadExecutionMeta", "activeThreadApprovalPolicyDraft",
  "activeThreadApprovalPolicyKind", "activeThreadApprovalPolicySelection",
  "activeThreadApprovalsReviewerDraft", "activeThreadApprovalsReviewerSelection",
  "activeThreadPermissionProfileDraft", "activeThreadPermissionProfileSelection",
  "activePermissionProfiles", "activePermissionProfilesError", "activePermissionProfilesStatus",
  "activeUserMessageHistory", "activeViews", "authError",
  "authRequired", "authTokenDraft", "addThreadFiles", "clearThreadAttachments", "clearThreadGoal",
  "closeThread", "compactThread", "commandPaletteByScope", "commandPaletteLoadingScopes",
  "composerDraftStore", "composerMenuOpen", "composerMode", "composerTextareaRef", "forkMessage",
  "handleComposerKeyDown", "imageFileInputRef", "insertThreadPathText", "latestTurnActivityScope",
  "loadCommandPalette", "messageDisplayMode", "messageRenderModes", "messagesRef",
  "messagesShouldFollowRef", "openMessageContextMenu", "openSelectedProjectThreadPicker",
  "pasteThreadImages", "removeThreadImage", "removeThreadTextAttachment", "renderComposerThreadControls",
  "resetComposerHistory", "respondToApproval", "respondToUserInput", "reviewThread",
  "resizeComposerTextarea", "selectedProject", "send", "threadControlsMenuOpen",
  "setComposerMenuOpen", "setComposerMode", "setExpandedStatusKeys", "setExpandedToolBatchKeys",
  "setGoalDialog", "setExpandedStatusTurns", "setImagePreview", "setInspectMessage",
  "setMessageDisplayMode", "setActiveThreadApprovalPolicyDraft", "setActiveThreadApprovalsReviewerDraft",
  "setActiveThreadPermissionProfileDraft",
  "setAuthTokenDraft", "setThreadControlsMenuOpen", "setThreadModelDialogOpen", "setSidebarCollapsed",
  "showComposerSendButton", "statusPanelAvailable", "statusPanelExpanded", "sidebarCollapsed",
  "statusScopeKey", "turnStatusItems", "stopTurn", "submitAuthToken", "switchSessionThread",
  "updateMessageRenderMode", "updateThreadInput", "updateThreadGoal", "openThreadEmptyMessage",
  "openThreadTabs"
] as const satisfies readonly (keyof AppWorkspaceViewModel)[];

const dialogKeys = [
  "addContextSelectionToConversation", "appSettings", "changeProjectPickerMachine",
  "chooseThreadCandidate", "confirmProjectPicker", "copyContextSelection", "createSessionThread",
  "createWorktreeThread", "goalDialog", "imagePreview", "inspectContextMessage", "inspectMessage",
  "loadProjectPickerDirectory", "loadThreadPickerCandidates", "machines", "messageContextMenu",
  "activeModelCatalogError", "activeModelCatalogStatus", "effectiveModelSelection",
  "effectiveReasoningSelection", "effectiveServiceTierSelection", "modelOptions", "reasoningOptions",
  "serviceTierOptions", "onlineMachines", "openingProjectKey", "projectPicker", "retryModelCatalog",
  "saveGoalDialog", "saveThreadRenameDialog", "threadModelDialogOpen", "threadRenameDialog",
  "threadTabContextMenu", "settingsDialogOpen", "sessionList", "openThreads", "setGoalDialog",
  "setImagePreview", "setInspectMessage", "setAppSettings", "setMessageContextMenu",
  "setProjectPicker", "setActiveThreadModelDraft", "setActiveThreadReasoningDraft",
  "setActiveThreadServiceTierDraft", "setThreadModelDialogOpen", "setThreadRenameDialog",
  "setThreadTabContextMenu", "setSettingsDialogOpen", "setThreadPicker", "submitProjectPickerPath",
  "threadOrderBySession", "threadPicker", "openPetPicker", "petEnabled", "petName"
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
