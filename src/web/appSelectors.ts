import { useMemo, type Dispatch, type SetStateAction } from "react";
import { recordsToViews } from "../core/codexRecordView.js";
import { collapseHistoricalToolBatches, compactToolViews } from "../shared/compactRecordViews.js";
import type { CodexRecordView } from "../shared/recordTypes.js";
import { recordsToDetailedViews } from "./detailedRecordViews.js";
import { finalAnswerViewsWithTurnDurations, turnDurationMapFromRecords } from "./helpers/turnDurations.js";
import { embeddedWorkspacePaths, isEmbeddedHostSurface, webSurface } from "./appConfig.js";
import {
  activityStatusesFromRecords,
  approvalPolicyKind,
  activityStatusSnapshotsFromRecords,
  authToken,
  combineRecordSources,
  effectiveReasoningSelectionForModel,
  groupProjectsByMachine,
  hideSupersededSimpleThinkingViews,
  isSimpleMainView,
  isSimpleRecord,
  latestThreadConfigFromRecords,
  latestThreadGoalFromRecords,
  latestThreadUsageFromRecords,
  latestTurnActivityScope,
  mergeThreadUsage,
  modelOptionsForSelection,
  normalizeReasoningEffort,
  projectKeyForProject,
  permissionProfileScopeKey,
  reasoningDraftForModelSelection,
  reasoningOptionsForSelection,
  runtimeForProject,
  serviceTierOptionsForSelection,
  threadDisplayRecords,
  threadExecutionIsRunning,
  threadUsageFromSessionRateLimits,
  userMessageHistoryFromRecords,
  withActivityStatusSnapshots
} from "./appHelpers.js";
import type { AppState } from "./appState.js";
import type {
  ComposerMode,
  ApprovalPolicyDraft,
  ApprovalsReviewerDraft,
  ModelSelection,
  ProjectSummary,
  ReasoningSelection,
  PermissionProfileDraft,
  ServiceTierSelection,
  ThreadSummary,
  WebRecordView
} from "./types.js";

const currentEmbeddedWorkspacePaths = new Set(embeddedWorkspacePaths);

export const useAppSelectors = (state: AppState) => {
  const activeThread = useMemo(
    () => state.openThreads.find((thread) => thread.threadId === state.activeTabThreadId),
    [state.activeTabThreadId, state.openThreads]
  );
  const composerMode = activeThread?.composerMode ?? "chat";
  const setComposerMode = (mode: ComposerMode) => {
    if (!state.activeTabThreadId) return;
    state.dispatchOpenThreads({ type: "set-composer-mode", threadId: state.activeTabThreadId, mode });
  };
  const activeThreadModelDraft = activeThread?.modelDraft ?? "auto";
  const activeThreadReasoningDraft = activeThread?.reasoningDraft ?? "auto";
  const activeThreadServiceTierDraft = activeThread?.serviceTierDraft ?? "auto";
  const activeThreadApprovalPolicyDraft = activeThread?.approvalPolicyDraft ?? "auto";
  const activeThreadApprovalsReviewerDraft = activeThread?.approvalsReviewerDraft ?? "auto";
  const activeThreadPermissionProfileDraft = activeThread?.permissionProfileDraft ?? null;
  const activeThreadApprovalPolicySelection = activeThreadApprovalPolicyDraft === "auto"
    ? activeThread?.approvalPolicy
    : activeThreadApprovalPolicyDraft;
  const activeThreadApprovalPolicyKind = approvalPolicyKind(activeThreadApprovalPolicySelection);
  const activeThreadApprovalsReviewerSelection = activeThreadApprovalsReviewerDraft === "auto"
    ? activeThread?.approvalsReviewer
    : activeThreadApprovalsReviewerDraft;
  const activeThreadPermissionProfileSelection = activeThreadPermissionProfileDraft
    ?? activeThread?.activePermissionProfile?.id
    ?? activeThread?.permissions;
  const setActiveThreadModelDraft: Dispatch<SetStateAction<ModelSelection>> = (value) => {
    if (!state.activeTabThreadId) return;
    const nextModel = typeof value === "function" ? value(activeThreadModelDraft) : value;
    state.dispatchOpenThreads({ type: "set-draft", threadId: state.activeTabThreadId, field: "modelDraft", value: nextModel });
    const nextReasoningDraft = reasoningDraftForModelSelection(
      activeThreadReasoningDraft,
      activeModelCatalog,
      nextModel
    );
    if (nextReasoningDraft !== activeThreadReasoningDraft) {
      state.dispatchOpenThreads({
        type: "set-draft",
        threadId: state.activeTabThreadId,
        field: "reasoningDraft",
        value: nextReasoningDraft
      });
    }
  };
  const setActiveThreadReasoningDraft: Dispatch<SetStateAction<ReasoningSelection>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.dispatchOpenThreads({ type: "set-draft", threadId: state.activeTabThreadId, field: "reasoningDraft", value });
  };
  const setActiveThreadServiceTierDraft: Dispatch<SetStateAction<ServiceTierSelection>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.dispatchOpenThreads({ type: "set-draft", threadId: state.activeTabThreadId, field: "serviceTierDraft", value });
  };
  const setActiveThreadApprovalPolicyDraft: Dispatch<SetStateAction<ApprovalPolicyDraft>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.dispatchOpenThreads({ type: "set-draft", threadId: state.activeTabThreadId, field: "approvalPolicyDraft", value });
  };
  const setActiveThreadApprovalsReviewerDraft: Dispatch<SetStateAction<ApprovalsReviewerDraft>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.dispatchOpenThreads({ type: "set-draft", threadId: state.activeTabThreadId, field: "approvalsReviewerDraft", value });
  };
  const setActiveThreadPermissionProfileDraft: Dispatch<SetStateAction<PermissionProfileDraft>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.dispatchOpenThreads({ type: "set-draft", threadId: state.activeTabThreadId, field: "permissionProfileDraft", value });
  };
  const projectList = useMemo(
    () => isEmbeddedHostSurface
      ? state.projects.filter(isCurrentEmbeddedWorkspaceProject)
      : state.projects,
    [state.projects]
  );
  const selectedProjectByKey = useMemo(
    () => state.selectedProjectKey
      ? projectList.find((project) => projectKeyForProject(project) === state.selectedProjectKey)
      : undefined,
    [projectList, state.selectedProjectKey]
  );
  const activeRuntime = useMemo(
    () => {
      if (selectedProjectByKey) return runtimeForProject(selectedProjectByKey, state.runtimeList);
      return state.runtimeList.find((runtime) => runtime.machineId === state.activeMachineId)
      ?? undefined;
    },
    [state.activeMachineId, state.activeWorkspacePath, projectList, selectedProjectByKey, state.runtimeList]
  );
  const onlineMachines = useMemo(() => state.machines.filter((machine) => machine.online), [state.machines]);
  const localMachines = useMemo(() => state.machines.filter((machine) => machine.type === "local"), [state.machines]);
  const registeredMachines = useMemo(() => state.machines.filter((machine) => machine.type === "registered"), [state.machines]);
  const sshConfigHostOptions = useMemo(() => {
    const savedAliases = new Set(state.sshHosts.map((host) => host.alias));
    return state.sshConfigHosts.filter((host) => !savedAliases.has(host.alias));
  }, [state.sshConfigHosts, state.sshHosts]);
  const registeredCommand = useMemo(
    () => registeredMachineCommand(window.location.origin, state.serverAuthRequired ? authToken() : ""),
    [state.serverAuthRequired, state.authRequired]
  );
  const registeredCommandIncludesToken = state.serverAuthRequired && registeredCommand.includes("--register-auth-token");
  const currentServerShareUrl = useMemo(
    () => currentServerRegisterUrlWithToken(),
    [state.authRequired, state.authTokenDraft, state.initialized, state.serverAuthRequired]
  );
  const projectGroups = useMemo(
    () => {
      const groups = groupProjectsByMachine(projectList, state.machines);
      return isEmbeddedHostSurface ? groups.filter((group) => group.projects.length > 0) : groups;
    },
    [projectList, state.machines]
  );
  const selectedProject = useMemo(() => {
    if (selectedProjectByKey) return selectedProjectByKey;
    if (activeRuntime) {
      return projectList.find((project) =>
        project.machineId === activeRuntime.machineId
        && Boolean(state.activeWorkspacePath)
        && project.path === state.activeWorkspacePath
        )
        ?? projectList.find((project) =>
          project.machineId === activeRuntime.machineId
          && project.path === activeRuntime.workingDirectory
        );
    }
    if (state.activeMachineId) {
      const runtime = state.runtimeList.find((runtime) => runtime.machineId === state.activeMachineId);
      const sessionProject = runtime
        ? projectList.find((project) =>
          project.machineId === runtime.machineId
          && (!state.activeWorkspacePath || project.path === state.activeWorkspacePath || project.path === runtime.workingDirectory)
        )
        : undefined;
      if (sessionProject) return sessionProject;
    }
    return state.activeWorkspacePath ? projectList.find((project) => project.path === state.activeWorkspacePath) : undefined;
  }, [activeRuntime, state.activeMachineId, state.activeWorkspacePath, projectList, selectedProjectByKey, state.runtimeList]);
  const activeProjectKey = selectedProject ? projectKeyForProject(selectedProject) : "";
  const activeProjectThreads = useMemo(() => {
    const byId = new Map<string, ThreadSummary>();
    const projectPath = selectedProject?.path ?? state.activeWorkspacePath;
    for (const thread of activeRuntime?.threads ?? []) {
      if (projectPath && thread.workingDirectory !== projectPath) continue;
      byId.set(thread.threadId, thread);
    }
    const orderedIds = state.threadOrderByMachine[activeRuntime?.machineId ?? ""] ?? [];
    return [
      ...orderedIds.flatMap((threadId) => {
        const thread = byId.get(threadId);
        if (!thread) return [];
        byId.delete(threadId);
        return [thread];
      }),
      ...byId.values()
    ];
  }, [activeRuntime, selectedProject?.path, state.activeWorkspacePath, state.threadOrderByMachine]);
  const openThreadIds = useMemo(
    () => state.openThreads.map((thread) => thread.threadId),
    [state.openThreads]
  );
  const activeThreadSummary = useMemo(
    () => {
      if (activeThread) return activeThread;
      for (const runtime of state.runtimeList) {
        const thread = runtime.threads?.find((item) => item.threadId === state.activeTabThreadId);
        if (thread) return thread;
      }
      return null;
    },
    [activeThread, state.activeTabThreadId, state.runtimeList]
  );
  const openThreadIdsKey = openThreadIds.join("\n");
  const displayRecords = useMemo(
    () => activeThread ? threadDisplayRecords(activeThread.threadId, activeThread) : [],
    [activeThread?.records, activeThread?.threadId]
  );
  const goalRecords = useMemo(
    () => combineRecordSources(displayRecords, activeThread?.records ?? []),
    [activeThread?.records, displayRecords]
  );
  const simpleRecords = useMemo(
    () => displayRecords.filter(isSimpleRecord),
    [displayRecords]
  );
  const baseViews = useMemo<CodexRecordView[]>(
    () => hideSupersededSimpleThinkingViews(recordsToViews(simpleRecords).filter(isSimpleMainView)),
    [simpleRecords]
  );
  const detailedViews = useMemo<CodexRecordView[]>(
    () => recordsToDetailedViews(displayRecords),
    [displayRecords]
  );
  const latestTurnActivity = useMemo(
    () => latestTurnActivityScope(displayRecords),
    [displayRecords]
  );
  const latestTurnStatuses = useMemo(
    () => activityStatusesFromRecords(latestTurnActivity.records),
    [latestTurnActivity.records]
  );
  const turnStatusItems = latestTurnStatuses;
  const latestTurnRunning = Boolean(
    activeThread
    && threadExecutionIsRunning(activeThread.running, latestTurnActivity.turnStatus)
  );
  const activityStatusSnapshots = useMemo(
    () => activityStatusSnapshotsFromRecords(displayRecords, latestTurnRunning),
    [displayRecords, latestTurnRunning]
  );
  const activeGoal = useMemo(
    () => latestThreadGoalFromRecords(goalRecords, activeThread?.threadId),
    [activeThread?.threadId, goalRecords]
  );
  const statusPanelExpanded = Boolean(
    activeThread?.threadId
    && latestTurnActivity.key
    && state.expandedStatusTurns[activeThread.threadId] === latestTurnActivity.key
  );
  const statusPanelAvailable = latestTurnRunning;
  const statusScopeKey = activeThread?.threadId && latestTurnActivity.key
    ? `${activeThread.threadId}:${latestTurnActivity.key}`
    : "";
  const activeExpandedStatusKeys = useMemo(
    () => new Set(statusScopeKey ? state.expandedStatusKeys[statusScopeKey] ?? [] : []),
    [state.expandedStatusKeys, statusScopeKey]
  );
  const activeExpandedToolBatchKeys = useMemo(
    () => new Set(activeThread?.threadId ? state.expandedToolBatchKeys[activeThread.threadId] ?? [] : []),
    [activeThread?.threadId, state.expandedToolBatchKeys]
  );
  const turnDurations = useMemo(
    () => turnDurationMapFromRecords(displayRecords),
    [displayRecords]
  );
  const activeViews = useMemo<WebRecordView[]>(
    () => withActivityStatusSnapshots(
      finalAnswerViewsWithTurnDurations(
        state.messageDisplayMode === "compact"
          ? collapseHistoricalToolBatches(compactToolViews(baseViews), activeExpandedToolBatchKeys)
          : detailedViews,
        turnDurations
      ),
      activityStatusSnapshots
    ),
    [activeExpandedToolBatchKeys, activityStatusSnapshots, baseViews, detailedViews, state.messageDisplayMode, turnDurations]
  );
  const activeUserMessageHistory = useMemo(
    () => userMessageHistoryFromRecords(displayRecords),
    [displayRecords]
  );
  const activeDisplayThreadId = activeThread?.threadId ?? state.activeTabThreadId;
  const activeThreadIsOpen = Boolean(activeThread && openThreadIds.includes(activeThread.threadId));
  const activeRuntimeOnline = Boolean(activeThread?.runtime.online && activeThread.runtime.runnable !== false);
  const activeCanStop = Boolean(activeThreadIsOpen && activeRuntimeOnline && activeThread?.running);
  const showComposerSendButton = Boolean(activeThread && !activeThread.running);
  const openThreadEmptyMessage = openThreadIds.length
    ? selectedProject
      ? activeRuntime?.online
        ? activeProjectThreads.length ? "Select a thread" : "No threads"
        : selectedProject.machineOnline ? "No threads" : "Machine offline"
      : "Select a thread"
    : activeRuntime
    ? activeRuntime.online
      ? activeProjectThreads.length ? "Select a thread" : "No threads"
      : "Runtime disconnected"
    : selectedProject
    ? selectedProject.machineOnline ? "No threads" : "Machine offline"
    : "No runtime";
  const latestThreadUsage = useMemo(
    () => latestThreadUsageFromRecords(latestTurnActivity.records) ?? latestThreadUsageFromRecords(displayRecords),
    [displayRecords, latestTurnActivity.records]
  );
  const summaryThreadUsage = activeThread?.threadUsage
    ?? activeThreadSummary?.threadUsage
    ?? null;
  const sessionRateLimitUsage = useMemo(
    () => threadUsageFromSessionRateLimits(activeRuntime?.accountRateLimits),
    [activeRuntime?.accountRateLimits]
  );
  const activeThreadUsage = mergeThreadUsage(
    mergeThreadUsage(latestThreadUsage, summaryThreadUsage),
    sessionRateLimitUsage
  );
  const latestThreadConfig = useMemo(
    () => latestThreadConfigFromRecords(latestTurnActivity.records) ?? latestThreadConfigFromRecords(displayRecords),
    [displayRecords, latestTurnActivity.records]
  );
  const activeThreadModel = latestThreadConfig?.model
    ?? activeThread?.model
    ?? activeThreadSummary?.model
    ?? state.systemStatus.model
    ?? null;
  const activeThreadReasoning = latestThreadConfig?.reasoning
    ?? activeThread?.modelReasoningEffort
    ?? activeThreadSummary?.modelReasoningEffort
    ?? normalizeReasoningEffort(state.systemStatus.modelReasoningEffort)
    ?? null;
  const activeThreadServiceTier = latestThreadConfig?.serviceTier
    ?? activeThread?.serviceTier
    ?? activeThreadSummary?.serviceTier
    ?? state.systemStatus.serviceTier
    ?? null;
  const effectiveModelSelection = activeThreadModelDraft === "auto" && activeThreadModel ? activeThreadModel : activeThreadModelDraft;
  const activeModelCatalogState = activeRuntime?.machineId
    ? state.modelCatalogByMachine[activeRuntime.machineId]
    : undefined;
  const activeModelCatalog = activeModelCatalogState?.status === "ready"
    ? activeModelCatalogState.models
    : [];
  const activeModelCatalogStatus: "unavailable" | "idle" | "loading" | "ready" | "error" = activeRuntime?.machineId
    ? activeModelCatalogState?.status ?? "idle"
    : "unavailable";
  const activeModelCatalogError = activeModelCatalogState?.status === "error"
    ? activeModelCatalogState.error ?? "Model catalog unavailable."
    : "";
  const activeModelCatalogCacheNotice = activeModelCatalogState?.status === "ready"
    && activeModelCatalogState.source === "cache"
    ? [
        `Using ${activeModelCatalogState.stale ? "stale " : ""}CodexHub model catalog cache`,
        activeModelCatalogState.updatedAt
          ? `from ${new Date(activeModelCatalogState.updatedAt).toLocaleString()}`
          : "",
        activeModelCatalogState.error ? `Live refresh failed: ${activeModelCatalogState.error}` : ""
      ].filter(Boolean).join(" · ")
    : "";
  const activePermissionProfileScopeKey = activeThread?.runtime.machineId && activeThread.workingDirectory
    ? permissionProfileScopeKey(activeThread.runtime.machineId, activeThread.workingDirectory)
    : "";
  const activePermissionProfileCatalogState = activePermissionProfileScopeKey
    ? state.permissionProfilesByScope[activePermissionProfileScopeKey]
    : undefined;
  const activePermissionProfiles = activePermissionProfileCatalogState?.status === "ready"
    ? activePermissionProfileCatalogState.profiles
    : [];
  const activePermissionProfilesStatus: "unavailable" | "idle" | "loading" | "ready" | "error" = activeThread?.runtime.machineId
    && activeThread.runtime.online
    ? activePermissionProfileCatalogState?.status ?? "idle"
    : "unavailable";
  const activePermissionProfilesError = activePermissionProfileCatalogState?.status === "error"
    ? activePermissionProfileCatalogState.error ?? "Permission profiles unavailable."
    : "";
  const effectiveReasoningSelection = effectiveReasoningSelectionForModel(
    activeThreadReasoningDraft,
    activeThreadReasoning,
    activeModelCatalog,
    effectiveModelSelection
  );
  const effectiveServiceTierSelection: ServiceTierSelection = activeThreadServiceTierDraft === "auto" && activeThreadServiceTier
    ? activeThreadServiceTier
    : activeThreadServiceTierDraft;
  const modelOptions = useMemo(
    () => modelOptionsForSelection(effectiveModelSelection, activeModelCatalog),
    [effectiveModelSelection, activeModelCatalog]
  );
  const reasoningOptions = useMemo(
    () => reasoningOptionsForSelection(effectiveReasoningSelection, activeModelCatalog, effectiveModelSelection),
    [effectiveReasoningSelection, effectiveModelSelection, activeModelCatalog]
  );
  const serviceTierOptions = useMemo(
    () => serviceTierOptionsForSelection(effectiveServiceTierSelection, activeModelCatalog, effectiveModelSelection),
    [effectiveServiceTierSelection, effectiveModelSelection, activeModelCatalog]
  );
  return {
    activeCanStop,
    activeDisplayThreadId,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeProjectThreads,
    activeRuntime,
    activeThread,
    activeThreadModel,
    activeThreadIsOpen,
    activeThreadModelDraft,
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
    activeThreadReasoning,
    activeThreadReasoningDraft,
    activeThreadServiceTier,
    activeThreadServiceTierDraft,
    activeThreadUsage,
    activeUserMessageHistory,
    activeViews,
    composerMode,
    currentServerShareUrl,
    effectiveModelSelection,
    effectiveReasoningSelection,
    effectiveServiceTierSelection,
    latestTurnActivityScope: latestTurnActivity,
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
    setActiveThreadApprovalsReviewerDraft,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setActiveThreadServiceTierDraft,
    setActiveThreadPermissionProfileDraft,
    setComposerMode,
    showComposerSendButton,
    statusPanelExpanded,
    statusPanelAvailable,
    sshConfigHostOptions,
    statusScopeKey,
    turnStatusItems
  };
};

export type AppSelectors = ReturnType<typeof useAppSelectors>;


const isCurrentEmbeddedWorkspaceProject = (project: ProjectSummary) =>
  project.source?.kind === webSurface
  && (!currentEmbeddedWorkspacePaths.size || currentEmbeddedWorkspacePaths.has(project.path));

const registeredMachineCommand = (origin: string, token: string) => {
  const command = `codexhub server --register-to ${shellQuote(origin)}`;
  return token.trim()
    ? `${command} --register-auth-token ${shellQuote(token.trim())}`
    : command;
};

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const currentServerRegisterUrlWithToken = () => {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.origin);
  url.searchParams.delete("codexhub_token");
  const token = authToken();
  if (token) url.searchParams.set("codexhub_token", token);
  return url.toString();
};
