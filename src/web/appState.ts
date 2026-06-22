import type React from "react";
import { useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { CodexRecord } from "../shared/recordTypes.js";
import { defaultAppSettings } from "./appConfig.js";
import { defaultTaskDraft, initAuthTokenFromUrl } from "./appHelpers.js";
import type {
  AppSettings,
  ComposerHistoryState,
  ConnectionMode,
  GoalDialogState,
  LocalTask,
  MachineSummary,
  MessageContextMenuState,
  MessageDisplayMode,
  MessageRenderMode,
  ModelCatalogItem,
  OpenThreadState,
  ParentRegistrationDraft,
  ParentRegistrationStatus,
  PluginSummary,
  ProjectPickerState,
  ProjectSummary,
  SessionView,
  SshConnection,
  SshHost,
  SystemStatus,
  TaskDraft,
  ThreadRenameDialogState,
  ThreadTabContextMenuState,
  ThreadPickerState,
  WebRecordView
} from "./types.js";

const defaultParentRegistrationDraft = (): ParentRegistrationDraft => ({
  url: "",
  machineId: "",
  name: ""
});

export const useAppState = () => {
  useState(() => initAuthTokenFromUrl());
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [openThreads, setOpenThreads] = useState<OpenThreadState[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activeTabThreadId, setActiveTabThreadId] = useState("");
  const [sessionList, setSessionList] = useState<SessionView[]>([]);
  const [machines, setMachines] = useState<MachineSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("local");
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [sshConfigHosts, setSshConfigHosts] = useState<SshHost[]>([]);
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [sshHostDraft, setSshHostDraft] = useState("");
  const [sshConnectingHost, setSshConnectingHost] = useState("");
  const [sshHostBusy, setSshHostBusy] = useState("");
  const [sshError, setSshError] = useState("");
  const [parentRegistration, setParentRegistration] = useState<ParentRegistrationStatus>({ status: "idle" });
  const [parentRegistrationDraft, setParentRegistrationDraft] = useState<ParentRegistrationDraft>(() => defaultParentRegistrationDraft());
  const [parentRegistrationBusy, setParentRegistrationBusy] = useState(false);
  const [parentRegistrationError, setParentRegistrationError] = useState("");
  const [registeredCommandCopied, setRegisteredCommandCopied] = useState(false);
  const [serverShareCopied, setServerShareCopied] = useState(false);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [tasks, setTasks] = useState<LocalTask[]>([]);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(() => defaultTaskDraft());
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [taskBusyId, setTaskBusyId] = useState("");
  const [taskError, setTaskError] = useState("");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [openingProjectKey, setOpeningProjectKey] = useState("");
  const [projectActionError, setProjectActionError] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [serverAuthRequired, setServerAuthRequired] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authTokenDraft, setAuthTokenDraft] = useState("");
  const [deletingProjectId, setDeletingProjectId] = useState("");
  const [projectPicker, setProjectPicker] = useState<ProjectPickerState | null>(null);
  const [threadPicker, setThreadPicker] = useState<ThreadPickerState | null>(null);
  const [activeTabThreadBySession, setActiveTabThreadBySession] = useState<Record<string, string>>({});
  const [threadOrderBySession, setThreadOrderBySession] = useState<Record<string, string[]>>({});
  const [initialized, setInitialized] = useState(false);
  const [inspectMessage, setInspectMessage] = useState<WebRecordView | null>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<MessageContextMenuState | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({
    model: null,
    modelReasoningEffort: null,
    serviceTier: null,
    contextWindowTokens: null
  });
  const [modelCatalogBySession, setModelCatalogBySession] = useState<Record<string, ModelCatalogItem[]>>({});
  const [messageDisplayMode, setMessageDisplayMode] = useState<MessageDisplayMode>("compact");
  const [messageRenderModes, setMessageRenderModes] = useState<Record<string, MessageRenderMode>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [collapsedProjectMachineKeys, setCollapsedProjectMachineKeys] = useState<string[]>([]);
  const [offlineProjectsCollapsed, setOfflineProjectsCollapsed] = useState(true);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [threadControlsMenuOpen, setThreadControlsMenuOpen] = useState(false);
  const [threadModelDialogOpen, setThreadModelDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [appSettings, setAppSettingsState] = useState<AppSettings>(() => defaultAppSettings());
  const [goalDialog, setGoalDialog] = useState<GoalDialogState | null>(null);
  const [threadRenameDialog, setThreadRenameDialog] = useState<ThreadRenameDialogState | null>(null);
  const [threadTabContextMenu, setThreadTabContextMenu] = useState<ThreadTabContextMenuState | null>(null);
  const [hiddenStatusTurns, setHiddenStatusTurns] = useState<Record<string, string>>({});
  const [expandedStatusKeys, setExpandedStatusKeys] = useState<Record<string, string[]>>({});
  const [expandedToolBatchKeys, setExpandedToolBatchKeys] = useState<Record<string, string[]>>({});
  const realtimeSocket = useRef<WebSocket | null>(null);
  const sessionsLastSeq = useRef(0);
  const projectsLastSeq = useRef(0);
  const tasksLastSeq = useRef(0);
  const connectionsLastSeq = useRef(0);
  const controlReconnectTimer = useRef<number | null>(null);
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
  const notificationRecordsByThread = useRef(new Map<string, CodexRecord[]>());
  const notifiedTaskCompletions = useRef(new Set<string>());
  const notificationAudioContext = useRef<AudioContext | null>(null);
  const appSettingsRef = useRef<AppSettings>(appSettings);
  appSettingsRef.current = appSettings;

  const setAppSettings: React.Dispatch<React.SetStateAction<AppSettings>> = (value) => {
    setAppSettingsState((current) => {
      const next = typeof value === "function"
        ? (value as (current: AppSettings) => AppSettings)(current)
        : value;
      appSettingsRef.current = next;
      return next;
    });
  };

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
    composerMenuOpen,
    composerTextareaRef,
    connectionMode,
    connectionsLastSeq,
    controlReconnectTimer,
    deletingProjectId,
    expandedStatusKeys,
    expandedToolBatchKeys,
    goalDialog,
    hiddenStatusTurns,
    imageFileInputRef,
    initialized,
    inspectMessage,
    latestRequestedThreadId,
    machines,
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    modelCatalogBySession,
    messagesRef,
    messagesShouldFollowRef,
    notificationAudioContext,
    notificationRecordsByThread,
    notifiedTaskCompletions,
    nowMs,
    offlineProjectsCollapsed,
    openingProjectKey,
    openingThreads,
    openThreads,
    parentRegistration,
    parentRegistrationBusy,
    parentRegistrationDraft,
    parentRegistrationError,
    plugins,
    projectActionError,
    projectPicker,
    projects,
    projectSearch,
    projectsLastSeq,
    realtimeSocket,
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
    setConnectionMode,
    setDeletingProjectId,
    setExpandedStatusKeys,
    setExpandedToolBatchKeys,
    setGoalDialog,
    setHiddenStatusTurns,
    setInitialized,
    setInspectMessage,
    setMachines,
    setMessageContextMenu,
    setMessageDisplayMode,
    setMessageRenderModes,
    setModelCatalogBySession,
    setNowMs,
    setOfflineProjectsCollapsed,
    setOpeningProjectKey,
    setOpenThreads,
    setParentRegistration,
    setParentRegistrationBusy,
    setParentRegistrationDraft,
    setParentRegistrationError,
    setPlugins,
    setProjectActionError,
    setProjectPicker,
    setProjects,
    setProjectSearch,
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
    setSshHostDraft,
    setSshHosts,
    setSystemStatus,
    setTaskBusyId,
    setTaskDraft,
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
    sidebarCollapsed,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHostDraft,
    sshHosts,
    systemStatus,
    taskBusyId,
    taskDraft,
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
