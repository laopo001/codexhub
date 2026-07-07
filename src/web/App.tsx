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
    composerHistoryRef,
    composerMenuOpen,
    composerTextareaRef,
    connectionMode,
    connectionsLastSeq,
    controlReconnectTimer,
    deletingProjectId,
    expandedStatusKeys,
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
    setSshSearch,
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
    sshSearch,
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
  } = appState;

  const selectors = useAppSelectors(appState);
  const {
    activeCanSend,
    activeCanStop,
    activeCanSubmit,
    activeDisplayThreadId,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeRuntimeSession,
    activeThread,
    activeThreadIsOpen,
    activeThreadApprovalPolicySelection,
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
    latestTurnStatusScope,
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
    runningOpenThreadIds,
    selectedProject,
    setActiveThreadApprovalPolicyDraft,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setActiveThreadServiceTierDraft,
    setActiveThreadSandboxPolicyDraft,
    setComposerMode,
    showComposerSendButton,
    showInlineStatusPanel,
    statusPanelAvailable,
    sshConfigHostOptions,
    statusScopeKey,
    turnStatusItems,
    turnUiState
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
    inspectContextMessage,
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
    activeRunningTurnDuration,
    activeThreadTurnMeta,
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

  const viewModel = {
    activeCanSend,
    activeCanStop,
    activeCanSubmit,
    activeDisplayThreadId,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeRuntimeSession,
    activeRunningTurnDuration,
    activeThread,
    activeThreadIsOpen,
    activeThreadTurnMeta,
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
    composerMenuOpen,
    composerMode,
    composerTextareaRef,
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
    inspectContextMessage,
    inspectMessage,
    latestTurnStatusScope,
    loadProjectPickerDirectory,
    loadThreadPickerCandidates,
    localMachines,
    machines,
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    activeThreadApprovalPolicySelection,
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
    parentRegistration,
    parentRegistrationBusy,
    parentRegistrationDraft,
    parentRegistrationError,
    pasteThreadImages,
    patchTask,
    plugins,
    projectGroups,
    projectList,
    projectScopeLocked: isVscodeSurface,
    projectActionError,
    projectPicker,
    projectSearch,
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
    setAppSettings,
    setComposerMenuOpen,
    setComposerMode,
    setConnectionMode,
    setExpandedStatusKeys,
    setExpandedToolBatchKeys,
    setGoalDialog,
    setHiddenStatusTurns,
    setInspectMessage,
    setMessageContextMenu,
    setMessageDisplayMode,
    setOfflineProjectsCollapsed,
    setParentRegistrationDraft,
    setProjectPicker,
    setProjectSearch,
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
    setSshHostDraft,
    setSshSearch,
    setTaskDraft,
    setTaskFormOpen,
    setThreadPicker,
    showComposerSendButton,
    showInlineStatusPanel,
    sidebarCollapsed,
    statusPanelAvailable,
    stopSshConnection,
    sshConfigHostOptions,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHostDraft,
    sshHosts,
    sshSearch,
    statusScopeKey,
    stopTurn,
    submitAuthToken,
    submitProjectPickerPath,
    switchSessionThread,
    taskBusyId,
    taskDraft,
    taskError,
    taskFormOpen,
    tasks,
    threadOrderBySession,
    threadPicker,
    toggleProjectMachineGroup,
    toggleProjectPinned,
    turnStatusItems,
    turnUiState,
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
