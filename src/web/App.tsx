import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, message, Modal } from "antd";
import { AppView } from "./AppView.js";
import { AppErrorBoundary } from "./AppErrorBoundary.js";
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

import { isElectronDesktopPetWindow, isEmbeddedHostSurface, isFixedWorkspaceSurface, isNativeElectronSurface } from "./appConfig.js";
import { setAuthToken } from "./appHelpers.js";
import { parseCodexHubHostIncomingMessage } from "./hostBridge.js";
import { subagentDialogConversationThreads } from "./helpers/subagentThreadDialog.js";
import { partitionAppViewModel } from "./viewModel.js";
import type { WebRecordView } from "./types.js";
import { updateRendererDiagnosticContext } from "./helpers/rendererDiagnostics.js";
import { PetOverlay, PetPicker, usePetFeature } from "./pets/index.js";
import { registerPwaServiceWorker } from "./pwa.js";

void registerPwaServiceWorker();

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
  const [modalApi, modalContextHolder] = Modal.useModal();
  const [composerRecentlyChanged, setComposerRecentlyChanged] = React.useState(false);
  const composerChangeTimerRef = React.useRef<number | null>(null);
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
    expandedStatusKeys,
    expandedStatusTurns,
    expandedToolBatchKeys,
    commandPaletteByScope,
    commandPaletteLoadingScopes,
    connectionMode,
    deletingProjectId,
    forkingMessageKey,
    goalDialog,
    imagePreview,
    inspectMessageSelection,
    machines,
    messageSelectionToolbar,
    messageRenderModes,
    offlineProjectsCollapsed,
    openingProjectKey,
    openThreadModelDialog,
    openThreads,
    parentRegistration,
    parentRegistrationBusy,
    parentRegistrationError,
    permissionProfilesByScope,
    projectActionError,
    projectPicker,
    registeredCommandCopied,
    serverShareCopied,
    subagentThreadDialog,
    runtimeList,
    threadProjectTargets,
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
    setInspectMessageSelection,
    setMessageSelectionToolbar,
    setModelCatalogByMachine,
    setOfflineProjectsCollapsed,
    setProjectPicker,
    setServerShareCopied,
    setSettingsDialogOpen,
    setSidebarCollapsed,
    setSubagentThreadDialog,
    setTaskFormOpen,
    setTasksDialogOpen,
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
    systemStatus,
    taskBusyId,
    taskError,
    taskFormOpen,
    tasksDialogOpen,
    tasks,
    threadControlsMenuOpen,
    threadModelDialogOpen,
    threadOrderByMachine,
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
    activeRuntime,
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
    activeModelCatalogCacheNotice,
    activeModelCatalogError,
    activeModelCatalogStatus,
    activeUserMessageHistory,
    activeViews,
    composerMode,
    currentServerShareUrl,
    inspectMessage,
    threadModelDialogModelSelection,
    threadModelDialogReasoningSelection,
    threadModelDialogServiceTierSelection,
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
    setThreadModelDialogModelDraft,
    setThreadModelDialogReasoningDraft,
    setThreadModelDialogServiceTierDraft,
    setComposerMode,
    showComposerSendButton,
    statusPanelExpanded,
    sshConfigHostOptions,
    statusScopeKey,
    threadModelDialogMachineId,
    turnStatusItems
  } = selectors;
  React.useEffect(() => {
    if (inspectMessageSelection && !inspectMessage) setInspectMessageSelection(null);
  }, [inspectMessage, inspectMessageSelection, setInspectMessageSelection]);
  const petDialogThreads = React.useMemo(
    () => subagentDialogConversationThreads(subagentThreadDialog),
    [subagentThreadDialog]
  );
  const petFeature = usePetFeature(
    openThreads,
    isElectronDesktopPetWindow ? appSettings.showDesktopPet : appSettings.showFloatingPet,
    appSettings.showDesktopPet,
    appSettings.selectedPetId,
    setAppSettings,
    isElectronDesktopPetWindow ? "desktop" : "window",
    { runtimeList, machines, dialogThreads: petDialogThreads, projects: projectList, threadProjectTargets }
  );
  React.useEffect(() => {
    if (!isElectronDesktopPetWindow) return undefined;
    document.documentElement.dataset.codexhubWindow = "desktop-pet";
    return () => {
      delete document.documentElement.dataset.codexhubWindow;
    };
  }, []);
  React.useEffect(() => {
    setComposerRecentlyChanged(false);
    if (composerChangeTimerRef.current !== null) {
      window.clearTimeout(composerChangeTimerRef.current);
      composerChangeTimerRef.current = null;
    }
    const handleComposerInput = (event: Event) => {
      if (!(event.target instanceof HTMLTextAreaElement)
        || event.target.dataset.threadId !== activeTabThreadId) return;
      setComposerRecentlyChanged(true);
      if (composerChangeTimerRef.current !== null) {
        window.clearTimeout(composerChangeTimerRef.current);
      }
      composerChangeTimerRef.current = window.setTimeout(() => {
        composerChangeTimerRef.current = null;
        setComposerRecentlyChanged(false);
      }, 1_000);
    };
    document.addEventListener("input", handleComposerInput);
    return () => {
      document.removeEventListener("input", handleComposerInput);
      if (composerChangeTimerRef.current !== null) {
        window.clearTimeout(composerChangeTimerRef.current);
        composerChangeTimerRef.current = null;
      }
    };
  }, [activeTabThreadId]);
  const actionContext = { ...appState, ...selectors, resizeComposerTextarea };
  React.useEffect(() => {
    updateRendererDiagnosticContext({
      activeThreadId: activeTabThreadId || undefined,
      openThreadIds: openThreads.map((thread) => thread.threadId)
    });
  }, [activeTabThreadId, openThreads]);
  let threadActions: ThreadActions | null = null;
  const requireThreadActions = () => {
    if (!threadActions) throw new Error("Thread actions used before initialization.");
    return threadActions;
  };
  const showActionError = (key: string, title: string, errorMessage: string) => {
    void messageApi.error({
      key: `thread-action:${key}`,
      content: `${title}: ${errorMessage}`,
      duration: 5
    });
  };
  const realtimeActions = createRealtimeActions(actionContext, {
    clearActiveThreadIfLatest: (threadId) => requireThreadActions().clearActiveThreadIfLatest(threadId),
    notifyRegisteredMachineConnected: (machine) => {
      if (isElectronDesktopPetWindow) return;
      void messageApi.success({
        key: `registered-machine-connection:${machine.machineId}`,
        content: `Registered machine connected · ${machine.name ?? machine.hostname ?? machine.machineId}`
      });
    },
    notifyRegisteredMachineDisconnected: (machine) => {
      if (isElectronDesktopPetWindow) return;
      void messageApi.warning({
        key: `registered-machine-connection:${machine.machineId}`,
        content: `Registered machine disconnected · ${machine.name ?? machine.hostname ?? machine.machineId}`
      });
    },
    onThreadCompleted: petFeature.handleThreadCompleted,
    openThread: (threadId, options) => requireThreadActions().openThread(threadId, options)
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
    refreshRuntimes: taskActions.refreshRuntimes,
    resetComposerHistory: composerActions.resetComposerHistory,
    sendRealtime: realtimeActions.sendRealtime,
    showActionError,
    showForkError: (errorMessage) => {
      modalApi.error({
        title: "Fork failed",
        content: errorMessage,
        okText: "Close"
      });
    }
  });
  const openThreadFromSurface = threadActions.openThread;
  React.useEffect(() => {
    if (!isNativeElectronSurface || isElectronDesktopPetWindow) return undefined;
    return window.codexhubElectronPet?.onOpenThread((threadId) => {
      void openThreadFromSurface(threadId);
    });
  }, [openThreadFromSurface]);
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
        void messageApi.warning({
          content: "Open a Codex Hub thread before sending selected content from the IDE.",
          duration: 5
        });
        return;
      }
      composerActions.addThreadTextAttachment(activeThread.threadId, message.text);
      window.requestAnimationFrame(() => {
        const textarea = [...document.querySelectorAll<HTMLTextAreaElement>("textarea[data-thread-id]")]
          .find((item) => item.dataset.threadId === activeThread.threadId) ?? null;
        textarea?.focus();
        resizeComposerTextarea(textarea);
      });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [activeThread?.threadId, composerActions]);
  const {
    addSelectionToConversation,
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
    copySelection,
    copyRegisteredCommand,
    createMachineThread,
    createWorktreeThread,
    createTask,
    deleteProject,
    deleteTask,
    disconnectParentRegistration,
    dismissPendingUserMessage,
    cancelQueuedSubmission,
    focusTaskDraftProject,
    forkMessage,
    handleComposerKeyDown,
    initialize,
    insertThreadPathText,
    loadCommandPalette,
    loadOlderThread,
    loadProjectPickerDirectory,
    loadThreadPickerCandidates,
    selectThreadPickerWorkingDirectory,
    openMessageSelectionToolbar,
    openSubagentThread,
    setThreadApprovalPolicyDraft,
    setThreadApprovalsReviewerDraft,
    setThreadComposerMode,
    setThreadPermissionProfileDraft,
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
    terminateBackgroundTerminal,
    submitProjectPickerPath,
    switchMachineThread,
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
    const machineId = threadModelDialogMachineId;
    if (!machineId) return;
    setModelCatalogByMachine((current) => {
      const existing = current[machineId];
      return {
        ...current,
        [machineId]: {
          status: "idle",
          models: existing?.models ?? [],
          source: existing?.source,
          updatedAt: existing?.updatedAt,
          stale: existing?.stale,
          refresh: true
        }
      };
    });
  };

  const viewModel = {
    activeCanStop,
    activeTabThreadId: appState.activeTabThreadId,
    activeDisplayThreadId,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeRuntime,
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
    addSelectionToConversation,
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
    commandPaletteByScope,
    commandPaletteLoadingScopes,
    confirmProjectPicker,
    connectionMode,
    connectParentRegistration,
    connectSshHost,
    copyCurrentServerShareUrl,
    copySelection,
    copyRegisteredCommand,
    createMachineThread,
    createWorktreeThread,
    createTask,
    currentServerShareUrl,
    deleteProject,
    deleteTask,
    deletingProjectId,
    disconnectParentRegistration,
    dismissPendingUserMessage,
    cancelQueuedSubmission,
    threadModelDialogModelSelection,
    threadModelDialogReasoningSelection,
    threadModelDialogServiceTierSelection,
    expandedStatusKeys,
    expandedStatusTurns,
    expandedToolBatchKeys,
    focusTaskDraftProject,
    forkingMessageKey,
    forkMessage,
    goalDialog,
    handleComposerKeyDown,
    imagePreview,
    inspectMessage,
    inspectMessageSelection,
    latestTurnActivityScope,
    loadCommandPalette,
    loadOlderThread,
    loadProjectPickerDirectory,
    loadThreadPickerCandidates,
    localMachines,
    machines,
    messageSelectionToolbar,
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
    permissionProfilesByScope,
    activeModelCatalogCacheNotice,
    activeModelCatalogError,
    activeModelCatalogStatus,
    modelOptions,
    reasoningOptions,
    serviceTierOptions,
    systemStatus,
    offlineProjectsCollapsed,
    onlineMachines,
    openingProjectKey,
    openMessageSelectionToolbar,
    openSubagentThread,
    openThreadModelDialog,
    setThreadApprovalPolicyDraft,
    setThreadApprovalsReviewerDraft,
    setThreadComposerMode,
    setThreadPermissionProfileDraft,
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
    projectScopeLocked: isFixedWorkspaceSurface,
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
    runtimeList,
    threadControlsMenuOpen,
    settingsDialogOpen,
    subagentThreadDialog,
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
    setInspectMessageSelection,
    openInspectMessage: (threadId: string, message: WebRecordView) => {
      if (threadId && message.record.id) setInspectMessageSelection({ threadId, recordId: message.record.id });
    },
    setMessageSelectionToolbar,
    setOfflineProjectsCollapsed,
    setProjectPicker,
    setAuthTokenDraft,
    setActiveThreadApprovalPolicyDraft,
    setActiveThreadApprovalsReviewerDraft,
    setActiveThreadPermissionProfileDraft,
    setThreadModelDialogModelDraft,
    setThreadModelDialogReasoningDraft,
    setThreadModelDialogServiceTierDraft,
    setThreadModelDialogOpen,
    setThreadControlsMenuOpen,
    setThreadRenameDialog,
    setThreadTabContextMenu,
    setSettingsDialogOpen,
    setSidebarCollapsed,
    setSubagentThreadDialog,
    setTaskFormOpen,
    setTasksDialogOpen,
    setThreadPicker,
    showComposerSendButton,
    statusPanelExpanded,
    sidebarCollapsed,
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
    terminateBackgroundTerminal,
    submitAuthToken,
    submitProjectPickerPath,
    selectThreadPickerWorkingDirectory,
    switchMachineThread,
    taskBusyId,
    taskError,
    taskFormOpen,
    tasksDialogOpen,
    tasks,
    threadOrderByMachine,
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
      {modalContextHolder}
      {messageContextHolder}
      {!isElectronDesktopPetWindow ? <AppView viewModel={partitionAppViewModel(viewModel)} /> : null}
      {!authRequired ? (
        <PetOverlay
          composerRecentlyChanged={composerRecentlyChanged}
          controller={petFeature}
          desktopPetWindow={isElectronDesktopPetWindow}
          onOpenThread={threadActions.openThread}
        />
      ) : null}
      {!isElectronDesktopPetWindow ? <PetPicker controller={petFeature} /> : null}
    </>
  );
};

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
  <AppErrorBoundary>
    <ConfigProvider>
      <App />
    </ConfigProvider>
  </AppErrorBoundary>
);
