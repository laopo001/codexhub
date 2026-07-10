import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import { AppView } from "./AppView.js";
import { useAppEffects } from "./appEffects.js";
import { useAppSelectors } from "./appSelectors.js";
import { useAppState } from "./appState.js";
import { useAppViewSelectors } from "./appViewSelectors.js";
import { createComposerActions } from "./appActions/composerActions.js";
import { createProjectActions } from "./appActions/projectActions.js";
import { createRealtimeActions } from "./appActions/realtimeActions.js";
import { createSshActions } from "./appActions/sshActions.js";
import { createTaskActions } from "./appActions/taskActions.js";
import { createThreadActions, type ThreadActions } from "./appActions/threadActions.js";
import "antd/dist/antd.css";
import "./style.css";

import { isVscodeSurface } from "./appConfig.js";
import { setAuthToken } from "./appHelpers.js";
const resizeComposerTextarea = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) return;
  textarea.style.height = "auto";
  const maxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
  const shouldScroll = Number.isFinite(maxHeight) && textarea.scrollHeight > maxHeight;
  textarea.style.height = `${shouldScroll ? maxHeight : textarea.scrollHeight}px`;
  textarea.style.overflowY = shouldScroll ? "auto" : "hidden";
};

const App = () => {
  const appState = useAppState();
  const {
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
    composerDraftStore,
    composerHistoryRef,
    composerMenuOpen,
    composerTextareaRef,
    commandPaletteByScope,
    commandPaletteLoadingScopes,
    connectionMode,
    connectionsLastSeq,
    controlReconnectTimer,
    deletingProjectId,
    expandedStatusKeys,
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
    setExpandedStatusTurns,
    setImagePreview,
    setInitialized,
    setInspectMessage,
    setMachines,
    setMessageContextMenu,
    setMessageDisplayMode,
    setMessageRenderModes,
    setModelCatalogBySession,
    setOfflineProjectsCollapsed,
    setOpeningProjectKey,
    setOpenThreads,
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
  } = appState;

  const selectors = useAppSelectors(appState);
  const {
    activeCanStop,
    activeDisplayThreadId,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeRuntimeSession,
    activeThread,
    activeThreadIsOpen,
    activeThreadApprovalPolicySelection,
    activeModelCatalogError,
    activeModelCatalogStatus,
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadServiceTierDraft,
    activeThreadSandboxPolicySelection,
    activeUserMessageHistory,
    activeViews,
    composerMode,
    currentServerShareUrl,
    effectiveModelSelection,
    effectiveReasoningSelection,
    effectiveServiceTierSelection,
    latestTurnActivityScope,
    localMachines,
    modelOptions,
    serviceTierOptions,
    onlineMachines,
    openThreadEmptyMessage,
    openThreadIds,
    openThreadIdsKey,
    projectGroups,
    projectList,
    registeredCommand,
    registeredCommandIncludesToken,
    registeredMachines,
    reasoningOptions,
    selectedProject,
    setActiveThreadApprovalPolicyDraft,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setActiveThreadServiceTierDraft,
    setActiveThreadSandboxPolicyDraft,
    setComposerMode,
    showComposerSendButton,
    statusPanelExpanded,
    statusPanelAvailable,
    sshConfigHostOptions,
    statusScopeKey,
    turnStatusItems
  } = selectors;
  const actionContext = { ...appState, ...selectors, resizeComposerTextarea };
  let threadActions: ThreadActions | null = null;
  const requireThreadActions = () => {
    if (!threadActions) throw new Error("Thread actions used before initialization.");
    return threadActions;
  };
  const realtimeActions = createRealtimeActions(actionContext, {
    clearActiveThreadIfLatest: (threadId) => requireThreadActions().clearActiveThreadIfLatest(threadId),
    openThread: (threadId) => requireThreadActions().openThread(threadId)
  });
  const sshActions = createSshActions(actionContext);
  const taskActions = createTaskActions(actionContext, {
    clearActiveThreadIfLatest: (threadId) => requireThreadActions().clearActiveThreadIfLatest(threadId),
    openThread: (threadId) => requireThreadActions().openThread(threadId)
  });
  const composerActions = createComposerActions(actionContext, {
    send: (threadId) => requireThreadActions().send(threadId)
  });
  threadActions = createThreadActions(actionContext, {
    primeTaskCompletionFeedback: taskActions.primeTaskCompletionFeedback,
    refreshProjects: taskActions.refreshProjects,
    refreshSessions: taskActions.refreshSessions,
    resetComposerHistory: composerActions.resetComposerHistory,
    sendRealtime: realtimeActions.sendRealtime
  });
  const projectActions = createProjectActions(actionContext, {
    clearActiveThreadIfLatest: threadActions.clearActiveThreadIfLatest,
    focusTaskDraftProject: taskActions.focusTaskDraftProject,
    openThread: threadActions.openThread,
    subscribeThread: threadActions.subscribeThread
  });
  const actions = {
    ...realtimeActions,
    ...sshActions,
    ...taskActions,
    ...threadActions,
    ...composerActions,
    ...projectActions
  };
  React.useEffect(() => {
    if (!isVscodeSurface) return undefined;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const record = event.data && typeof event.data === "object" && !Array.isArray(event.data)
        ? event.data as Record<string, unknown>
        : null;
      if (record?.type !== "codexhub.addTextAttachment") return;
      const text = typeof record.text === "string" ? record.text : "";
      if (!text.trim()) return;
      if (!activeThread?.threadId) {
        window.alert("Open a Codex Hub thread before sending selected code from VS Code.");
        return;
      }
      composerActions.addThreadTextAttachment(activeThread.threadId, text);
      window.requestAnimationFrame(() => {
        composerTextareaRef.current?.focus();
        resizeComposerTextarea(composerTextareaRef.current);
      });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [activeThread?.threadId, composerActions, composerTextareaRef]);
  const {
    addContextSelectionToConversation,
    addThreadFiles,
    addThreadImages,
    addSshHost,
    changeProjectPickerMachine,
    chooseThreadCandidate,
    clearActiveThreadIfLatest,
    clearThreadAttachments,
    clearThreadGoal,
    closeThread,
    confirmProjectPicker,
    connectParentRegistration,
    connectSshHost,
    copyContextSelection,
    copyRegisteredCommand,
    createSessionThread,
    createWorktreeThread,
    createTask,
    deleteProject,
    deleteTask,
    disconnectParentRegistration,
    focusTaskDraftProject,
    forkMessage,
    handleComposerKeyDown,
    initialize,
    insertThreadPathText,
    inspectContextMessage,
    loadCommandPalette,
    loadProjectPickerDirectory,
    loadThreadPickerCandidates,
    openMessageContextMenu,
    showProjectPicker,
    openTaskRunThread,
    openThread,
    openThreadPicker,
    openSelectedProjectThreadPicker,
    pasteThreadImages,
    patchTask,
    compactThread,
    removeThreadImage,
    removeThreadTextAttachment,
    removeSshHost,
    resetComposerHistory,
    respondToApproval,
    respondToUserInput,
    reviewThread,
    rollbackMessage,
    runTaskNow,
    saveGoalDialog,
    saveThreadRenameDialog,
    selectProject,
    selectProjectSession,
    selectSessionThread,
    send,
    stopSshConnection,
    stopTurn,
    submitProjectPickerPath,
    switchSessionThread,
    syncThreadSubscriptions,
    toggleProjectMachineGroup,
    toggleProjectPinned,
    updateMessageRenderMode,
    updateThreadInput,
    updateTaskDraftMachine,
    updateTaskDraftProject,
    updateThreadGoal
  } = actions;

  const viewSelectors = useAppViewSelectors(appState, selectors, { compactThread });
  const {
    activeThreadExecutionMeta,
    openThreadTabs,
    renderComposerThreadControls
  } = viewSelectors;

  useAppEffects({
    actions: {
      clearActiveThreadIfLatest,
      initialize,
      openThread,
      stopTurn,
      syncThreadSubscriptions
    },
    resizeComposerTextarea,
    selectors,
    state: appState
  });

  const submitAuthToken = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = authTokenDraft.trim();
    if (!token) {
      setAuthError("Access token is required.");
      return;
    }
    setAuthToken(token);
    setAuthError("");
    setAuthRequired(false);
    setInitialized(false);
    void initialize();
  };

  const copyCurrentServerShareUrl = async () => {
    if (!currentServerShareUrl) return;
    await navigator.clipboard?.writeText(currentServerShareUrl).catch(() => undefined);
    setServerShareCopied(true);
    window.setTimeout(() => setServerShareCopied(false), 1200);
  };

  const retryModelCatalog = () => {
    const sessionId = activeRuntimeSession?.sessionId;
    if (!sessionId) return;
    setModelCatalogBySession((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, sessionId)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  };

  const viewModel = {
    activeCanStop,
    activeDisplayThreadId,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeRuntimeSession,
    activeThread,
    activeThreadIsOpen,
    activeThreadExecutionMeta,
    activeUserMessageHistory,
    activeViews,
    activeWorkspacePath,
    appSettings,
    authError,
    authRequired,
    authTokenDraft,
    addContextSelectionToConversation,
    addThreadFiles,
    addThreadImages,
    addSshHost,
    changeProjectPickerMachine,
    chooseThreadCandidate,
    clearThreadGoal,
    closeThread,
    collapsedProjectMachineKeys,
    compactThread,
    composerDraftStore,
    composerMenuOpen,
    composerMode,
    composerTextareaRef,
    commandPaletteByScope,
    commandPaletteLoadingScopes,
    confirmProjectPicker,
    connectionMode,
    connectParentRegistration,
    connectSshHost,
    copyCurrentServerShareUrl,
    copyContextSelection,
    copyRegisteredCommand,
    createSessionThread,
    createWorktreeThread,
    createTask,
    currentServerShareUrl,
    deleteProject,
    deleteTask,
    deletingProjectId,
    disconnectParentRegistration,
    effectiveModelSelection,
    effectiveReasoningSelection,
    effectiveServiceTierSelection,
    focusTaskDraftProject,
    forkMessage,
    goalDialog,
    handleComposerKeyDown,
    imageFileInputRef,
    imagePreview,
    inspectContextMessage,
    inspectMessage,
    latestTurnActivityScope,
    loadCommandPalette,
    loadProjectPickerDirectory,
    loadThreadPickerCandidates,
    localMachines,
    machines,
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    activeThreadApprovalPolicySelection,
    activeModelCatalogError,
    activeModelCatalogStatus,
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadServiceTierDraft,
    activeThreadSandboxPolicySelection,
    messagesRef,
    messagesShouldFollowRef,
    modelOptions,
    reasoningOptions,
    serviceTierOptions,
    offlineProjectsCollapsed,
    onlineMachines,
    openingProjectKey,
    openMessageContextMenu,
    showProjectPicker,
    openTaskRunThread,
    openThreadPicker,
    openSelectedProjectThreadPicker,
    insertThreadPathText,
    parentRegistration,
    parentRegistrationBusy,
    parentRegistrationError,
    pasteThreadImages,
    patchTask,
    plugins,
    projectGroups,
    projectList,
    projectScopeLocked: isVscodeSurface,
    projectActionError,
    projectPicker,
    registeredCommand,
    registeredCommandIncludesToken,
    registeredCommandCopied,
    registeredMachines,
    clearThreadAttachments,
    removeThreadImage,
    removeThreadTextAttachment,
    removeSshHost,
    renderComposerThreadControls,
    resetComposerHistory,
    respondToApproval,
    respondToUserInput,
    reviewThread,
    retryModelCatalog,
    resizeComposerTextarea,
    rollbackMessage,
    runTaskNow,
    saveGoalDialog,
    saveThreadRenameDialog,
    selectedProject,
    selectProject,
    selectProjectSession,
    selectSessionThread,
    send,
    serverShareCopied,
    threadModelDialogOpen,
    sessionList,
    threadControlsMenuOpen,
    settingsDialogOpen,
    threadRenameDialog,
    threadTabContextMenu,
    openThreads,
    sidebarDraftStore,
    setAppSettings,
    setComposerMenuOpen,
    setComposerMode,
    setConnectionMode,
    setExpandedStatusKeys,
    setExpandedToolBatchKeys,
    setGoalDialog,
    setExpandedStatusTurns,
    setImagePreview,
    setInspectMessage,
    setMessageContextMenu,
    setMessageDisplayMode,
    setOfflineProjectsCollapsed,
    setProjectPicker,
    setAuthTokenDraft,
    setActiveThreadApprovalPolicyDraft,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setActiveThreadServiceTierDraft,
    setActiveThreadSandboxPolicyDraft,
    setThreadModelDialogOpen,
    setThreadControlsMenuOpen,
    setThreadRenameDialog,
    setThreadTabContextMenu,
    setSettingsDialogOpen,
    setSidebarCollapsed,
    setTaskFormOpen,
    setThreadPicker,
    showComposerSendButton,
    statusPanelExpanded,
    sidebarCollapsed,
    statusPanelAvailable,
    stopSshConnection,
    sshConfigHostOptions,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHosts,
    statusScopeKey,
    stopTurn,
    submitAuthToken,
    submitProjectPickerPath,
    switchSessionThread,
    taskBusyId,
    taskError,
    taskFormOpen,
    tasks,
    threadOrderBySession,
    threadPicker,
    toggleProjectMachineGroup,
    toggleProjectPinned,
    turnStatusItems,
    updateMessageRenderMode,
    updateThreadInput,
    updateTaskDraftMachine,
    updateTaskDraftProject,
    updateThreadGoal,
    openThreadEmptyMessage,
    openThreadTabs,
  };
  return <AppView viewModel={viewModel} />;
};

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
  <ConfigProvider theme={{ zeroRuntime: true }}>
    <App />
  </ConfigProvider>
);
