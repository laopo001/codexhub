import { useMemo, type Dispatch, type SetStateAction } from "react";
import { recordsToViews } from "../core/codexRecordView.js";
import { collapseHistoricalToolBatches, compactToolViews } from "../shared/compactRecordViews.js";
import type { CodexRecordView } from "../shared/recordTypes.js";
import { recordsToDetailedViews } from "./detailedRecordViews.js";
import { isVscodeSurface, vscodeWorkspacePaths } from "./appConfig.js";
import {
  activityStatusesFromRecords,
  authToken,
  combineRecordSources,
  groupProjectsByMachine,
  hideSupersededSimpleThinkingViews,
  isSimpleMainView,
  isSimpleRecord,
  latestThreadConfigFromRecords,
  latestThreadGoalFromRecords,
  latestThreadUsageFromRecords,
  latestTurnStatusFromRecords,
  latestUserTurnStatusScope,
  machineProjectLauncher,
  mergeThreadUsage,
  modelOptionsForSelection,
  normalizeReasoningEffort,
  preferredThreadIdForSession,
  projectKeyForProject,
  reasoningOptionsForSelection,
  runtimeSessionForProject,
  serviceTierOptionsForSelection,
  threadDisplayRecords,
  threadUsageFromSessionRateLimits,
  turnUiStateFromStatus,
  userMessageHistoryFromRecords
} from "./appHelpers.js";
import type { AppState } from "./appState.js";
import type {
  ComposerMode,
  ApprovalPolicyDraft,
  ApprovalPolicySelection,
  ModelSelection,
  ProjectSummary,
  ReasoningSelection,
  SandboxPolicyDraft,
  SandboxPolicySelection,
  ServiceTierSelection,
  ThreadSummary,
  WebRecordView
} from "./types.js";

const currentVscodeWorkspacePaths = new Set(vscodeWorkspacePaths);

export const useAppSelectors = (state: AppState) => {
  const activeThread = useMemo(
    () => state.openThreads.find((thread) => thread.threadId === state.activeTabThreadId),
    [state.activeTabThreadId, state.openThreads]
  );
  const composerMode = activeThread?.composerMode ?? "chat";
  const setComposerMode = (mode: ComposerMode) => {
    if (!state.activeTabThreadId) return;
    state.setOpenThreads((current) => current.map((thread) => thread.threadId === state.activeTabThreadId
      ? { ...thread, composerMode: mode }
      : thread));
  };
  const activeThreadModelDraft = activeThread?.modelDraft ?? "auto";
  const activeThreadReasoningDraft = activeThread?.reasoningDraft ?? "auto";
  const activeThreadServiceTierDraft = activeThread?.serviceTierDraft ?? "auto";
  const activeThreadApprovalPolicyDraft = activeThread?.approvalPolicyDraft ?? "auto";
  const activeThreadSandboxPolicyDraft = activeThread?.sandboxPolicyDraft ?? "auto";
  const activeThreadApprovalPolicySelection = activeThreadApprovalPolicyDraft === "auto"
    ? activeThread?.approvalPolicy
    : activeThreadApprovalPolicyDraft;
  const activeThreadSandboxPolicySelection = activeThreadSandboxPolicyDraft === "auto"
    ? sandboxPolicySelectionFromThread(activeThread?.sandboxPolicy)
    : activeThreadSandboxPolicyDraft;
  const setActiveThreadModelDraft: Dispatch<SetStateAction<ModelSelection>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== state.activeTabThreadId) return thread;
      const next = typeof value === "function"
        ? (value as (current: ModelSelection) => ModelSelection)(thread.modelDraft)
        : value;
      return { ...thread, modelDraft: next };
    }));
  };
  const setActiveThreadReasoningDraft: Dispatch<SetStateAction<ReasoningSelection>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== state.activeTabThreadId) return thread;
      const next = typeof value === "function"
        ? (value as (current: ReasoningSelection) => ReasoningSelection)(thread.reasoningDraft)
        : value;
      return { ...thread, reasoningDraft: next };
    }));
  };
  const setActiveThreadServiceTierDraft: Dispatch<SetStateAction<ServiceTierSelection>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== state.activeTabThreadId) return thread;
      const next = typeof value === "function"
        ? (value as (current: ServiceTierSelection) => ServiceTierSelection)(thread.serviceTierDraft)
        : value;
      return { ...thread, serviceTierDraft: next };
    }));
  };
  const setActiveThreadApprovalPolicyDraft: Dispatch<SetStateAction<ApprovalPolicyDraft>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== state.activeTabThreadId) return thread;
      const next = typeof value === "function"
        ? (value as (current: ApprovalPolicyDraft) => ApprovalPolicyDraft)(thread.approvalPolicyDraft)
        : value;
      return { ...thread, approvalPolicyDraft: next };
    }));
  };
  const setActiveThreadSandboxPolicyDraft: Dispatch<SetStateAction<SandboxPolicyDraft>> = (value) => {
    if (!state.activeTabThreadId) return;
    state.setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== state.activeTabThreadId) return thread;
      const next = typeof value === "function"
        ? (value as (current: SandboxPolicyDraft) => SandboxPolicyDraft)(thread.sandboxPolicyDraft)
        : value;
      return { ...thread, sandboxPolicyDraft: next };
    }));
  };
  const projectList = useMemo(
    () => isVscodeSurface
      ? state.projects.filter(isCurrentVscodeWorkspaceProject)
      : state.projects,
    [state.projects]
  );
  const selectedProjectByKey = useMemo(
    () => state.selectedProjectKey
      ? projectList.find((project) => projectKeyForProject(project) === state.selectedProjectKey)
      : undefined,
    [projectList, state.selectedProjectKey]
  );
  const activeProjectSession = useMemo(
    () => {
      if (selectedProjectByKey) return runtimeSessionForProject(selectedProjectByKey, state.sessionList);
      return projectList.find((project) =>
        project.session?.sessionId === state.activeSessionId
        && (!state.activeWorkspacePath || project.path === state.activeWorkspacePath)
      )?.session
      ?? projectList.find((project) => project.session?.sessionId === state.activeSessionId)?.session
      ?? state.sessionList.find((session) => session.sessionId === state.activeSessionId)
      ?? undefined;
    },
    [state.activeSessionId, state.activeWorkspacePath, projectList, selectedProjectByKey, state.sessionList]
  );
  const activeRuntimeSession = useMemo(
    () => activeProjectSession?.sessionId
      ? state.sessionList.find((session) => session.sessionId === activeProjectSession.sessionId) ?? activeProjectSession
      : activeProjectSession,
    [activeProjectSession, state.sessionList]
  );
  const onlineMachines = useMemo(() => state.machines.filter((machine) => machine.online), [state.machines]);
  const localMachines = useMemo(() => state.machines.filter((machine) => machine.type === "local"), [state.machines]);
  const registeredMachines = useMemo(() => state.machines.filter((machine) => machine.type === "registered" && machine.online), [state.machines]);
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
      return isVscodeSurface ? groups.filter((group) => group.projects.length > 0) : groups;
    },
    [projectList, state.machines]
  );
  const selectedProject = useMemo(() => {
    if (selectedProjectByKey) return selectedProjectByKey;
    if (activeProjectSession) {
      return projectList.find((project) =>
        project.machineId === activeProjectSession.machineId
        && Boolean(state.activeWorkspacePath)
        && project.path === state.activeWorkspacePath
      )
        ?? projectList.find((project) =>
          project.machineId === activeProjectSession.machineId
          && project.path === activeProjectSession.workingDirectory
        )
        ?? projectList.find((project) =>
          project.session?.sessionId === activeProjectSession.sessionId
          && (!state.activeWorkspacePath || project.path === state.activeWorkspacePath)
        )
        ?? projectList.find((project) => project.session?.sessionId === activeProjectSession.sessionId)
        ?? projectList.find((project) => project.machineId === activeProjectSession.machineId && project.path === activeProjectSession.workingDirectory);
    }
    if (state.activeSessionId) {
      const sessionProject = projectList.find((project) => project.session?.sessionId === state.activeSessionId);
      if (sessionProject) return sessionProject;
    }
    return state.activeWorkspacePath ? projectList.find((project) => project.path === state.activeWorkspacePath) : undefined;
  }, [activeProjectSession, state.activeSessionId, state.activeWorkspacePath, projectList, selectedProjectByKey]);
  const activeProjectKey = selectedProject ? projectKeyForProject(selectedProject) : "";
  const activeProjectSessionThreads = useMemo(() => {
    const byId = new Map<string, ThreadSummary>();
    const projectPath = selectedProject?.path ?? state.activeWorkspacePath;
    for (const thread of activeProjectSession?.threads ?? []) {
      if (projectPath && thread.workingDirectory !== projectPath) continue;
      byId.set(thread.threadId, thread);
    }
    const orderedIds = state.threadOrderBySession[activeProjectSession?.sessionId ?? ""] ?? [];
    return [
      ...orderedIds.flatMap((threadId) => {
        const thread = byId.get(threadId);
        if (!thread) return [];
        byId.delete(threadId);
        return [thread];
      }),
      ...byId.values()
    ];
  }, [activeProjectSession, selectedProject?.path, state.activeWorkspacePath, state.threadOrderBySession]);
  const openThreadIds = useMemo(
    () => state.openThreads.map((thread) => thread.threadId),
    [state.openThreads]
  );
  const runningOpenThreadIds = useMemo(
    () => state.openThreads.filter((thread) => thread.running).map((thread) => thread.threadId).join("\n"),
    [state.openThreads]
  );
  const activeThreadSummary = useMemo(
    () => {
      if (activeThread) return activeThread;
      for (const session of state.sessionList) {
        const thread = session.threads?.find((item) => item.threadId === state.activeTabThreadId);
        if (thread) return thread;
      }
      return null;
    },
    [activeThread, state.activeTabThreadId, state.sessionList]
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
  const latestTurnStatusScope = useMemo(
    () => latestUserTurnStatusScope(displayRecords),
    [displayRecords]
  );
  const latestTurnStatuses = useMemo(
    () => activityStatusesFromRecords(latestTurnStatusScope.records),
    [latestTurnStatusScope.records]
  );
  const latestTurnStatus = useMemo(
    () => latestTurnStatusFromRecords(displayRecords),
    [displayRecords]
  );
  const simpleStatuses = useMemo(
    () => state.messageDisplayMode === "compact" ? latestTurnStatuses : [],
    [latestTurnStatuses, state.messageDisplayMode]
  );
  const activeGoal = useMemo(
    () => latestThreadGoalFromRecords(goalRecords, activeThread?.threadId),
    [activeThread?.threadId, goalRecords]
  );
  const turnUiState = useMemo(
    () => turnUiStateFromStatus(latestTurnStatus, Boolean(activeThread?.running)),
    [activeThread?.running, latestTurnStatus]
  );
  const statusRowsHidden = Boolean(
    activeThread?.threadId
    && latestTurnStatusScope.key
    && state.hiddenStatusTurns[activeThread.threadId] === latestTurnStatusScope.key
  );
  const showStatusRows = Boolean(simpleStatuses.length && !statusRowsHidden);
  const showInlineStatusPanel = Boolean(
    activeThread
    && (
      showStatusRows
      || statusRowsHidden
      || activeThread.running
      || turnUiState.kind === "running"
      || latestTurnStatus
    )
  );
  const statusScopeKey = activeThread?.threadId && latestTurnStatusScope.key
    ? `${activeThread.threadId}:${latestTurnStatusScope.key}`
    : "";
  const activeExpandedStatusKeys = useMemo(
    () => new Set(statusScopeKey ? state.expandedStatusKeys[statusScopeKey] ?? [] : []),
    [state.expandedStatusKeys, statusScopeKey]
  );
  const activeExpandedToolBatchKeys = useMemo(
    () => new Set(activeThread?.threadId ? state.expandedToolBatchKeys[activeThread.threadId] ?? [] : []),
    [activeThread?.threadId, state.expandedToolBatchKeys]
  );
  const activeViews = useMemo<WebRecordView[]>(
    () => state.messageDisplayMode === "compact"
      ? collapseHistoricalToolBatches(compactToolViews(baseViews), activeExpandedToolBatchKeys)
      : detailedViews,
    [activeExpandedToolBatchKeys, baseViews, detailedViews, state.messageDisplayMode]
  );
  const activeUserMessageHistory = useMemo(
    () => userMessageHistoryFromRecords(displayRecords),
    [displayRecords]
  );
  const activeDisplayThreadId = activeThread?.threadId ?? state.activeTabThreadId;
  const activeThreadIsOpen = Boolean(activeThread && openThreadIds.includes(activeThread.threadId));
  const activeHasDraft = Boolean(activeThread?.input.trim() || activeThread?.imageAttachments.length || activeThread?.textAttachments.length);
  const activeRuntimeOnline = Boolean(activeThread?.session.online && activeThread.session.runnable !== false);
  const activeCanSend = Boolean(
    activeThread
    && activeThreadIsOpen
    && activeRuntimeOnline
    && activeHasDraft
  );
  const activeCanStop = Boolean(activeThreadIsOpen && activeRuntimeOnline && activeThread?.running);
  const activeCanSubmit = activeCanSend;
  const showComposerSendButton = Boolean(activeThread && !activeThread.running);
  const openThreadEmptyMessage = openThreadIds.length
    ? selectedProject
      ? activeProjectSession?.online
        ? activeProjectSessionThreads.length ? "Select a thread" : "No threads"
        : selectedProject.machineOnline ? "No threads" : "Machine offline"
      : "Select a thread"
    : activeProjectSession
    ? activeProjectSession.online
      ? activeProjectSessionThreads.length ? "Select a thread" : "No threads"
      : "Session disconnected"
    : selectedProject
    ? selectedProject.machineOnline ? "No threads" : "Machine offline"
    : "No session";
  const latestThreadUsage = useMemo(
    () => latestThreadUsageFromRecords(latestTurnStatusScope.records) ?? latestThreadUsageFromRecords(displayRecords),
    [displayRecords, latestTurnStatusScope.records]
  );
  const summaryThreadUsage = activeThread?.threadUsage
    ?? activeThreadSummary?.threadUsage
    ?? null;
  const sessionRateLimitUsage = useMemo(
    () => threadUsageFromSessionRateLimits(activeRuntimeSession?.accountRateLimits),
    [activeRuntimeSession?.accountRateLimits]
  );
  const activeThreadUsage = mergeThreadUsage(
    mergeThreadUsage(latestThreadUsage, summaryThreadUsage),
    sessionRateLimitUsage
  );
  const latestThreadConfig = useMemo(
    () => latestThreadConfigFromRecords(latestTurnStatusScope.records) ?? latestThreadConfigFromRecords(displayRecords),
    [displayRecords, latestTurnStatusScope.records]
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
  const effectiveReasoningSelection: ReasoningSelection = activeThreadReasoningDraft === "auto" && activeThreadReasoning
    ? activeThreadReasoning
    : activeThreadReasoningDraft;
  const effectiveServiceTierSelection: ServiceTierSelection = activeThreadServiceTierDraft === "auto" && activeThreadServiceTier
    ? activeThreadServiceTier
    : activeThreadServiceTierDraft;
  const activeModelCatalog = activeRuntimeSession?.sessionId
    ? state.modelCatalogBySession[activeRuntimeSession.sessionId] ?? []
    : [];
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
    activeCanSend,
    activeCanStop,
    activeCanSubmit,
    activeDisplayThreadId,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeProjectSession,
    activeProjectSessionThreads,
    activeRuntimeSession,
    activeThread,
    activeThreadModel,
    activeThreadIsOpen,
    activeThreadModelDraft,
    activeThreadApprovalPolicySelection,
    activeThreadReasoning,
    activeThreadReasoningDraft,
    activeThreadServiceTier,
    activeThreadServiceTierDraft,
    activeThreadSandboxPolicySelection,
    activeThreadUsage,
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
    showStatusRows,
    simpleStatuses,
    sshConfigHostOptions,
    statusScopeKey,
    turnUiState
  };
};

export type AppSelectors = ReturnType<typeof useAppSelectors>;

const sandboxPolicySelectionFromThread = (policy: ThreadSummary["sandboxPolicy"]): SandboxPolicySelection | undefined => {
  if (!policy) return undefined;
  if (policy.type === "readOnly") return "read-only";
  if (policy.type === "workspaceWrite") return "workspace-write";
  if (policy.type === "dangerFullAccess") return "danger-full-access";
  return undefined;
};

const isCurrentVscodeWorkspaceProject = (project: ProjectSummary) =>
  project.source?.kind === "vscode"
  && (!currentVscodeWorkspacePaths.size || currentVscodeWorkspacePaths.has(project.path));

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
  url.searchParams.delete("token");
  const token = authToken();
  if (token) url.searchParams.set("codexhub_token", token);
  return url.toString();
};
