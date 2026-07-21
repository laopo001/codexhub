import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, message } from "antd";
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
import "./style.css";

import { isEmbeddedHostSurface } from "./appConfig.js";
import { setAuthToken } from "./appHelpers.js";
import { parseCodexHubHostIncomingMessage } from "./hostBridge.js";
import { partitionAppViewModel } from "./viewModel.js";
import { PetOverlay, PetPicker, usePetFeature } from "./pets/index.js";
const resizeComposerTextarea = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) return;
  textarea.style.height = "auto";
  const maxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
  const shouldScroll = Number.isFinite(maxHeight) && textarea.scrollHeight > maxHeight;
  textarea.style.height = `${shouldScroll ? maxHeight : textarea.scrollHeight}px`;
  textarea.style.overflowY = shouldScroll ? "auto" : "hidden";
};

const App = () => {
  const [messageApi, messageContextHolder] = message.useMessage();
  const appState = useAppState();
  const {
    activeWorkspacePath,
    activeTabThreadId,
    appSettings,
    authError,
    authRequired,
    authTokenDraft,
    collapsedProjectMachineKeys,
    composerDraftStore,
    composerMenuOpen,
    composerTextareaRef,
    commandPaletteByScope,
    commandPaletteLoadingScopes,
    connectionMode,
    deletingProjectId,
    goalDialog,
    imageFileInputRef,
    imagePreview,
    inspectMessage,
    machines,
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    messagesRef,
    messagesShouldFollowRef,
    offlineProjectsCollapsed,
    openingProjectKey,
    openThreads,
    parentRegistration,
    parentRegistrationBusy,
    parentRegistrationError,
    projectActionError,
    projectPicker,
    registeredCommandCopied,
    serverShareCopied,
    sessionList,
    setAppSettings,
    setAuthError,
    setAuthRequired,
    setAuthTokenDraft,
    setComposerMenuOpen,
    setConnectionMode,
    setExpandedStatusKeys,
    setExpandedToolBatchKeys,
    setGoalDialog,
    setExpandedStatusTurns,
    setImagePreview,
    setInitialized,
    setInspectMessage,
    setMessageContextMenu,
    setMessageDisplayMode,
    setModelCatalogBySession,
    setOfflineProjectsCollapsed,
    setProjectPicker,
    setServerShareCopied,
    setSettingsDialogOpen,
    setSidebarCollapsed,
    setTaskFormOpen,
    setThreadControlsMenuOpen,
    setThreadModelDialogOpen,
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
    taskBusyId,
    taskError,
    taskFormOpen,
    tasks,
    threadControlsMenuOpen,
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
    activeThreadApprovalPolicyDraft,
    activeThreadApprovalPolicyKind,
    activeThreadApprovalPolicySelection,
    activeThreadApprovalsReviewerDraft,
    activeThreadApprovalsReviewerSelection,
    activeThreadPermissionProfileDraft,
    activeThreadPermissionProfileSelection,
    activePermissionProfiles,
    activePermissionProfilesError,
    activePermissionProfilesStatus,
    activeModelCatalogError,
    activeModelCatalogStatus,
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadServiceTierDraft,
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
    projectGroups,
    projectList,
    registeredCommand,
    registeredCommandIncludesToken,
    registeredMachines,
    reasoningOptions,
    selectedProject,
    setActiveThreadApprovalPolicyDraft,
    setActiveThreadApprovalsReviewerDraft,
    setActiveThreadPermissionProfileDraft,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setActiveThreadServiceTierDraft,
    setComposerMode,
    showComposerSendButton,
    statusPanelExpanded,
    statusPanelAvailable,
    sshConfigHostOptions,
    statusScopeKey,
    turnStatusItems
  } = selectors;
  const petFeature = usePetFeature(openThreads, activeTabThreadId);
  const actionContext = { ...appState, ...selectors, resizeComposerTextarea };
  let threadActions: ThreadActions | null = null;
  const requireThreadActions = () => {
    if (!threadActions) throw new Error("Thread actions used before initialization.");
    return threadActions;
  };
  const realtimeActions = createRealtimeActions(actionContext, {
    clearActiveThreadIfLatest: (threadId) => requireThreadActions().clearActiveThreadIfLatest(threadId),
    notifyRegisteredMachineConnected: (machine) => {
      void messageApi.success({
        key: `registered-machine-connection:${machine.machineId}`,
        content: `Registered machine connected · ${machine.name ?? machine.hostname ?? machine.machineId}`
      });
    },
    notifyRegisteredMachineDisconnected: (machine) => {
      void messageApi.warning({
        key: `registered-machine-connection:${machine.machineId}`,
        content: `Registered machine disconnected · ${machine.name ?? machine.hostname ?? machine.machineId}`
      });
    },
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
    handleLocalComposerCommand: petFeature.handleLocalComposerCommand,
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
    if (!isEmbeddedHostSurface) return undefined;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const message = parseCodexHubHostIncomingMessage(event.data);
      if (!message) return;
      if (message.type === "codexhub.openThread") {
        void threadActions.openThread(message.threadId);
        return;
      }
      if (!activeThread?.threadId) {
        window.alert("Open a Codex Hub thread before sending selected content from the IDE.");
        return;
      }
      composerActions.addThreadTextAttachment(activeThread.threadId, message.text);
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
    runTaskNow,
    saveGoalDialog,
    saveThreadRenameDialog,
    selectProject,
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
    activeThreadApprovalPolicyDraft,
    activeThreadApprovalPolicyKind,
    activeThreadApprovalPolicySelection,
    activeThreadApprovalsReviewerDraft,
    activeThreadApprovalsReviewerSelection,
    activeThreadPermissionProfileDraft,
    activeThreadPermissionProfileSelection,
    activePermissionProfiles,
    activePermissionProfilesError,
    activePermissionProfilesStatus,
    activeModelCatalogError,
    activeModelCatalogStatus,
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadServiceTierDraft,
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
    projectGroups,
    projectList,
    projectScopeLocked: isEmbeddedHostSurface,
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
    runTaskNow,
    saveGoalDialog,
    saveThreadRenameDialog,
    selectedProject,
    selectProject,
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
    setActiveThreadApprovalsReviewerDraft,
    setActiveThreadPermissionProfileDraft,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setActiveThreadServiceTierDraft,
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
    openPetPicker: petFeature.openPicker,
    petEnabled: petFeature.enabled,
    petName: petFeature.selectedPet.displayName,
  };
  return (
    <>
      {messageContextHolder}
      <AppView viewModel={partitionAppViewModel(viewModel)} />
      {!authRequired ? <PetOverlay controller={petFeature} onOpenThread={threadActions.openThread} /> : null}
      <PetPicker controller={petFeature} />
    </>
  );
};

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
  <ConfigProvider>
    <App />
  </ConfigProvider>
);
