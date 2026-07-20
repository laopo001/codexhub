import { useReducer, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { CodexRecord } from "../shared/recordTypes.js";
import type { CodexHubRealtimeClient } from "../shared/realtimeClient.js";
import { createComposerDraftStore, initAuthTokenFromUrl } from "./appHelpers.js";
import { useIntegrationState, useUiState } from "./appStateSlices.js";
import { openThreadReducer } from "./openThreadReducer.js";
import type {
  CommandPalette,
  ComposerHistoryState,
  MachineSummary,
  ModelCatalogLoadState,
  PermissionProfileCatalogLoadState,
  ProjectPickerState,
  ProjectSummary,
  SessionSummary,
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
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    offlineProjectsCollapsed,
    serverAuthRequired,
    settingsDialogOpen,
    sidebarCollapsed,
    sidebarDraftStore,
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
    setMessageContextMenu,
    setMessageDisplayMode,
    setMessageRenderModes,
    setOfflineProjectsCollapsed,
    setServerAuthRequired,
    setSettingsDialogOpen,
    setSidebarCollapsed,
    setThreadControlsMenuOpen,
    setThreadModelDialogOpen,
    setThreadRenameDialog,
    setThreadTabContextMenu,
    threadControlsMenuOpen,
    threadModelDialogOpen,
    threadRenameDialog,
    threadTabContextMenu
  } = uiState;
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [openThreads, dispatchOpenThreads] = useReducer(openThreadReducer, []);
  const [activeTabThreadId, setActiveTabThreadId] = useState("");
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [machines, setMachines] = useState<MachineSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [openingProjectKey, setOpeningProjectKey] = useState("");
  const [projectActionError, setProjectActionError] = useState("");
  const [deletingProjectId, setDeletingProjectId] = useState("");
  const [projectPicker, setProjectPicker] = useState<ProjectPickerState | null>(null);
  const [threadPicker, setThreadPicker] = useState<ThreadPickerState | null>(null);
  const [activeTabThreadBySession, setActiveTabThreadBySession] = useState<Record<string, string>>({});
  const [threadOrderBySession, setThreadOrderBySession] = useState<Record<string, string[]>>({});
  const [initialized, setInitialized] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({
    model: null,
    modelReasoningEffort: null,
    serviceTier: null,
    contextWindowTokens: null
  });
  const [modelCatalogBySession, setModelCatalogBySession] = useState<Record<string, ModelCatalogLoadState>>({});
  const [permissionProfilesByScope, setPermissionProfilesByScope] = useState<Record<string, PermissionProfileCatalogLoadState>>({});
  const [commandPaletteByScope, setCommandPaletteByScope] = useState<Record<string, CommandPalette>>({});
  const [commandPaletteLoadingScopes, setCommandPaletteLoadingScopes] = useState<Record<string, boolean>>({});
  const realtimeClient = useRef<CodexHubRealtimeClient | null>(null);
  const sessionsLastSeq = useRef(0);
  const projectsLastSeq = useRef(0);
  const tasksLastSeq = useRef(0);
  const connectionsLastSeq = useRef(0);
  const realtimeThreadSubscriptions = useRef(new Set<string>());
  const threadLastSeqs = useRef(new Map<string, number>());
  const openingThreads = useRef(new Map<string, Promise<void>>());
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
    activeSessionId,
    activeTabThreadBySession,
    activeTabThreadId,
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
    composerMenuOpen,
    composerTextareaRef,
    commandPaletteByScope,
    commandPaletteLoadingScopes,
    connectionMode,
    connectionsLastSeq,
    deletingProjectId,
    expandedStatusKeys,
    expandedToolBatchKeys,
    goalDialog,
    expandedStatusTurns,
    imageFileInputRef,
    imagePreview,
    initialized,
    inspectMessage,
    latestRequestedThreadId,
    machines,
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    modelCatalogBySession,
    permissionProfilesByScope,
    messagesRef,
    messagesShouldFollowRef,
    notificationAudioContext,
    notificationRecordsByThread,
    notifiedTaskCompletions,
    offlineProjectsCollapsed,
    openingProjectKey,
    openingThreads,
    openThreads,
    parentRegistration,
    parentRegistrationBusy,
    parentRegistrationError,
    plugins,
    projectActionError,
    projectPicker,
    projects,
    projectsLastSeq,
    realtimeClient,
    realtimeThreadSubscriptions,
    registeredCommandCopied,
    selectedProjectKey,
    serverAuthRequired,
    serverShareCopied,
    sessionList,
    sessionsLastSeq,
    setActiveSessionId,
    setActiveTabThreadBySession,
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
    setGoalDialog,
    setExpandedStatusTurns,
    setImagePreview,
    setInitialized,
    setInspectMessage,
    setMachines,
    setMessageContextMenu,
    setMessageDisplayMode,
    setMessageRenderModes,
    setModelCatalogBySession,
    setPermissionProfilesByScope,
    setOfflineProjectsCollapsed,
    setOpeningProjectKey,
    dispatchOpenThreads,
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
    setSessionList,
    setSettingsDialogOpen,
    setSidebarCollapsed,
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
    setTasks,
    setThreadControlsMenuOpen,
    setThreadModelDialogOpen,
    setThreadOrderBySession,
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
    tasks,
    tasksLastSeq,
    threadControlsMenuOpen,
    threadLastSeqs,
    threadModelDialogOpen,
    threadOrderBySession,
    threadRenameDialog,
    threadTabContextMenu,
    threadPicker
  };
};

export type AppState = ReturnType<typeof useAppState>;
