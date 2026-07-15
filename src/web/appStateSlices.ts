import type React from "react";
import { useRef, useState } from "react";
import { defaultAppSettings } from "./appConfig.js";
import { createSidebarDraftStore } from "./appHelpers.js";
import type {
  AppSettings,
  ConnectionMode,
  GoalDialogState,
  ImagePreviewState,
  LocalTask,
  MessageContextMenuState,
  MessageDisplayMode,
  MessageRenderMode,
  ParentRegistrationStatus,
  PluginSummary,
  SshConnection,
  SshHost,
  ThreadRenameDialogState,
  ThreadTabContextMenuState,
  WebRecordView
} from "./types.js";

export const useIntegrationState = () => {
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("local");
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [sshConfigHosts, setSshConfigHosts] = useState<SshHost[]>([]);
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [sshConnectingHost, setSshConnectingHost] = useState("");
  const [sshHostBusy, setSshHostBusy] = useState("");
  const [sshError, setSshError] = useState("");
  const [parentRegistration, setParentRegistration] = useState<ParentRegistrationStatus>({ status: "idle" });
  const [parentRegistrationBusy, setParentRegistrationBusy] = useState(false);
  const [parentRegistrationError, setParentRegistrationError] = useState("");
  const [registeredCommandCopied, setRegisteredCommandCopied] = useState(false);
  const [serverShareCopied, setServerShareCopied] = useState(false);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [tasks, setTasks] = useState<LocalTask[]>([]);
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [taskBusyId, setTaskBusyId] = useState("");
  const [taskError, setTaskError] = useState("");

  return {
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
  };
};

export const useUiState = () => {
  const [authRequired, setAuthRequired] = useState(false);
  const [serverAuthRequired, setServerAuthRequired] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authTokenDraft, setAuthTokenDraft] = useState("");
  const [inspectMessage, setInspectMessage] = useState<WebRecordView | null>(null);
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<MessageContextMenuState | null>(null);
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
  const [expandedStatusTurns, setExpandedStatusTurns] = useState<Record<string, string>>({});
  const [expandedStatusKeys, setExpandedStatusKeys] = useState<Record<string, string[]>>({});
  const [expandedToolBatchKeys, setExpandedToolBatchKeys] = useState<Record<string, string[]>>({});
  const [sidebarDraftStore] = useState(createSidebarDraftStore);
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
  };
};
