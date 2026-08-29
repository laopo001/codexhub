import { useReducer, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { CodexRecord } from "../shared/recordTypes.js";
import type { CodexHubRealtimeClient } from "../shared/realtimeClient.js";
import { createComposerDraftStore, initAuthTokenFromUrl } from "./appHelpers.js";
import { useIntegrationState, useUiState } from "./appStateSlices.js";
import { subagentDialogConversationThreads } from "./helpers/subagentThreadDialog.js";
import {
  openThreadReducer,
  reduceConversationThreadState,
  type ConversationThreadAction
} from "./openThreadReducer.js";
import type {
  CommandPalette,
  ComposerHistoryState,
  MachineSummary,
  ModelCatalogLoadState,
  PermissionProfileCatalogLoadState,
  ProjectPickerState,
  ProjectSummary,
  RuntimeSummary,
  SystemStatus,
  ThreadPickerState
} from "./types.js";

export const useAppState = () => {
  useState(() => initAuthTokenFromUrl());
  const integrationState = useIntegrationState();
  const uiState = useUiState();
  const {
    connectionMode,
    parentRegistration,
    parentRegistrationBusy,
    parentRegistrationError,
    plugins,
    registeredCommandCopied,
    serverShareCopied,
    setConnectionMode,
    setParentRegistration,
    setParentRegistrationBusy,
    setParentRegistrationError,
    setPlugins,
    setRegisteredCommandCopied,
    setServerShareCopied,
    setSshConfigHosts,
    setSshConnectingHost,
    setSshConnections,
    setSshError,
    setSshHostBusy,
    setSshHosts,
    setTaskBusyId,
    setTaskError,
    setTaskFormOpen,
    setTasksDialogOpen,
    setTasks,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHosts,
    taskBusyId,
    taskError,
    taskFormOpen,
    tasksDialogOpen,
    tasks
  } = integrationState;
  const {
    appSettings,
    appSettingsRef,
    authError,
    authRequired,
    authTokenDraft,
    collapsedProjectMachineKeys,
    composerMenuOpen,
    expandedStatusKeys,
    expandedStatusTurns,
    expandedToolBatchKeys,
    goalDialog,
    imagePreview,
    inspectMessage,
    messageSelectionToolbar,
    messageRenderModes,
    offlineProjectsCollapsed,
    openThreadModelDialog,
    serverAuthRequired,
    settingsDialogOpen,
    sidebarCollapsed,
    sidebarDraftStore,
    subagentThreadDialog,
    setAppSettings,
    setAuthError,
    setAuthRequired,
    setAuthTokenDraft,
    setCollapsedProjectMachineKeys,
    setComposerMenuOpen,
    setExpandedStatusKeys,
    setExpandedStatusTurns,
    setExpandedToolBatchKeys,
    setGoalDialog,
    setImagePreview,
    setInspectMessage,
    setMessageSelectionToolbar,
    setMessageRenderModes,
    setOfflineProjectsCollapsed,
    setServerAuthRequired,
    setSettingsDialogOpen,
    setSidebarCollapsed,
    setSubagentThreadDialog,
    setThreadControlsMenuOpen,
    setThreadModelDialogOpen,
    setThreadModelDialogThreadId,
    setThreadRenameDialog,
    setThreadTabContextMenu,
    threadControlsMenuOpen,
    threadModelDialogOpen,
    threadModelDialogThreadId,
    threadRenameGenerationRequests,
    threadRenameDialog,
    threadTabContextMenu
  } = uiState;
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [openThreads, dispatchOpenThreads] = useReducer(openThreadReducer, []);
  const openThreadIdsRef = useRef(new Set<string>());
  openThreadIdsRef.current = new Set(openThreads.map((thread) => thread.threadId));
  const conversationThreadsRef = useRef(new Map(openThreads.map((thread) => [thread.threadId, thread])));
  conversationThreadsRef.current = new Map(openThreads.map((thread) => [thread.threadId, thread]));
  for (const thread of subagentDialogConversationThreads(subagentThreadDialog)) {
    conversationThreadsRef.current.set(thread.threadId, thread);
  }
  const dispatchConversationThread = (action: ConversationThreadAction) => {
    dispatchOpenThreads(action);
    setSubagentThreadDialog((current) => {
      if (current?.status !== "ready" || !current.thread || current.threadId !== action.threadId) {
        return current;
      }
      return {
        ...current,
        thread: reduceConversationThreadState(current.thread, action)
      };
    });
  };
  const [activeTabThreadId, setActiveTabThreadId] = useState("");
  const activeTabThreadIdRef = useRef(activeTabThreadId);
  activeTabThreadIdRef.current = activeTabThreadId;
  const [runtimeList, setRuntimeList] = useState<RuntimeSummary[]>([]);
  const [machines, setMachines] = useState<MachineSummary[]>([]);
  const machinesRef = useRef<MachineSummary[]>(machines);
  machinesRef.current = machines;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const projectsRef = useRef<ProjectSummary[]>(projects);
  projectsRef.current = projects;
  const [activeMachineId, setActiveMachineId] = useState("");
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [openingProjectKey, setOpeningProjectKey] = useState("");
  const [projectActionError, setProjectActionError] = useState("");
  const [forkingMessageKey, setForkingMessageKey] = useState("");
  const [deletingProjectId, setDeletingProjectId] = useState("");
  const [projectPicker, setProjectPicker] = useState<ProjectPickerState | null>(null);
  const [threadPicker, setThreadPicker] = useState<ThreadPickerState | null>(null);
  const [activeTabThreadByMachine, setActiveTabThreadByMachine] = useState<Record<string, string>>({});
  const [threadOrderByMachine, setThreadOrderByMachine] = useState<Record<string, string[]>>({});
  const [pendingRestoreThreadIds, setPendingRestoreThreadIds] = useState<string[]>([]);
  const [pendingRestoreActiveThreadId, setPendingRestoreActiveThreadId] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({
    version: null,
    model: null,
    modelReasoningEffort: null,
    serviceTier: null,
    contextWindowTokens: null
  });
  const [modelCatalogByMachine, setModelCatalogByMachine] = useState<Record<string, ModelCatalogLoadState>>({});
  const [permissionProfilesByScope, setPermissionProfilesByScope] = useState<Record<string, PermissionProfileCatalogLoadState>>({});
  const [commandPaletteByScope, setCommandPaletteByScope] = useState<Record<string, CommandPalette>>({});
  const [commandPaletteLoadingScopes, setCommandPaletteLoadingScopes] = useState<Record<string, boolean>>({});
  const realtimeClient = useRef<CodexHubRealtimeClient | null>(null);
  const runtimesLastSeq = useRef(0);
  const projectsLastSeq = useRef(0);
  const tasksLastSeq = useRef(0);
  const connectionsLastSeq = useRef(0);
  const realtimeThreadSubscriptions = useRef(new Set<string>());
  const threadLastSeqs = useRef(new Map<string, number>());
  const openingThreads = useRef(new Map<string, Promise<void>>());
  const openingSubagentThreads = useRef(new Set<string>());
  const latestRequestedThreadId = useRef("");
  const closedThreadIds = useRef(new Set<string>());
  const messagesRef = useRef<VirtuosoHandle>(null);
  const messagesShouldFollowRef = useRef(true);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerHistoryRef = useRef<ComposerHistoryState | null>(null);
  const composerDraftStore = useRef(createComposerDraftStore()).current;
  const notificationRecordsByThread = useRef(new Map<string, CodexRecord[]>());
  const notifiedTaskCompletions = useRef(new Set<string>());
  const notificationAudioContext = useRef<AudioContext | null>(null);
  return {
    activeMachineId,
    activeTabThreadByMachine,
    activeTabThreadId,
    activeTabThreadIdRef,
    activeWorkspacePath,
    appSettings,
    appSettingsRef,
    authError,
    authRequired,
    authTokenDraft,
    closedThreadIds,
    collapsedProjectMachineKeys,
    composerHistoryRef,
    composerDraftStore,
    conversationThreadsRef,
    composerMenuOpen,
    composerTextareaRef,
    commandPaletteByScope,
    commandPaletteLoadingScopes,
    connectionMode,
    connectionsLastSeq,
    deletingProjectId,
    expandedStatusKeys,
    expandedToolBatchKeys,
    forkingMessageKey,
    goalDialog,
    expandedStatusTurns,
    imageFileInputRef,
    imagePreview,
    initialized,
    inspectMessage,
    latestRequestedThreadId,
    machines,
    machinesRef,
    messageSelectionToolbar,
    messageRenderModes,
    modelCatalogByMachine,
    permissionProfilesByScope,
    messagesRef,
    messagesShouldFollowRef,
    notificationAudioContext,
    notificationRecordsByThread,
    notifiedTaskCompletions,
    offlineProjectsCollapsed,
    openingProjectKey,
    openingSubagentThreads,
    openingThreads,
    openThreads,
    openThreadIdsRef,
    pendingRestoreActiveThreadId,
    pendingRestoreThreadIds,
    parentRegistration,
    parentRegistrationBusy,
    parentRegistrationError,
    plugins,
    projectActionError,
    projectPicker,
    projects,
    projectsRef,
    projectsLastSeq,
    realtimeClient,
    realtimeThreadSubscriptions,
    registeredCommandCopied,
    selectedProjectKey,
    serverAuthRequired,
    serverShareCopied,
    subagentThreadDialog,
    runtimeList,
    runtimesLastSeq,
    setActiveMachineId,
    setActiveTabThreadByMachine,
    setActiveTabThreadId,
    setActiveWorkspacePath,
    setAppSettings,
    setAuthError,
    setAuthRequired,
    setAuthTokenDraft,
    setCollapsedProjectMachineKeys,
    setComposerMenuOpen,
    setCommandPaletteByScope,
    setCommandPaletteLoadingScopes,
    setConnectionMode,
    setDeletingProjectId,
    setExpandedStatusKeys,
    setExpandedToolBatchKeys,
    setForkingMessageKey,
    setGoalDialog,
    setExpandedStatusTurns,
    setImagePreview,
    setInitialized,
    setInspectMessage,
    setMachines,
    setMessageSelectionToolbar,
    setMessageRenderModes,
    setModelCatalogByMachine,
    setPermissionProfilesByScope,
    setOfflineProjectsCollapsed,
    setOpeningProjectKey,
    setPendingRestoreActiveThreadId,
    setPendingRestoreThreadIds,
    dispatchOpenThreads,
    dispatchConversationThread,
    setParentRegistration,
    setParentRegistrationBusy,
    setParentRegistrationError,
    setPlugins,
    setProjectActionError,
    setProjectPicker,
    setProjects,
    setRegisteredCommandCopied,
    setSelectedProjectKey,
    setServerAuthRequired,
    setServerShareCopied,
    setRuntimeList,
    setSettingsDialogOpen,
    setSidebarCollapsed,
    setSubagentThreadDialog,
    setSshConfigHosts,
    setSshConnectingHost,
    setSshConnections,
    setSshError,
    setSshHostBusy,
    setSshHosts,
    setSystemStatus,
    setTaskBusyId,
    setTaskError,
    setTaskFormOpen,
    setTasksDialogOpen,
    setTasks,
    setThreadControlsMenuOpen,
    setThreadModelDialogOpen,
    setThreadModelDialogThreadId,
    setThreadOrderByMachine,
    setThreadRenameDialog,
    setThreadTabContextMenu,
    setThreadPicker,
    settingsDialogOpen,
    sidebarDraftStore,
    sidebarCollapsed,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHosts,
    systemStatus,
    taskBusyId,
    taskError,
    taskFormOpen,
    tasksDialogOpen,
    tasks,
    tasksLastSeq,
    threadControlsMenuOpen,
    threadLastSeqs,
    threadModelDialogOpen,
    threadModelDialogThreadId,
    openThreadModelDialog,
    threadOrderByMachine,
    threadRenameGenerationRequests,
    threadRenameDialog,
    threadTabContextMenu,
    threadPicker
  };
};

export type AppState = ReturnType<typeof useAppState>;
