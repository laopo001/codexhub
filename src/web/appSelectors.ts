import { useMemo, type Dispatch, type SetStateAction } from "react";
import { recordsToViews } from "../core/codexRecordView.js";
import { collapseHistoricalToolBatches, compactToolViews } from "../shared/compactRecordViews.js";
import { asRecord, type CodexRecord, type CodexRecordView } from "../shared/recordTypes.js";
import { recordsToDetailedViews } from "./detailedRecordViews.js";
import { isVscodeSurface, vscodeWorkspacePaths } from "./appConfig.js";
import {
  activityStatusesFromRecords,
  activityStatusSnapshotsFromRecords,
  authToken,
  combineRecordSources,
  groupProjectsByMachine,
  hideSupersededSimpleThinkingViews,
  isSimpleMainView,
  isSimpleRecord,
  latestThreadConfigFromRecords,
  latestThreadGoalFromRecords,
  latestThreadUsageFromRecords,
  latestTurnActivityScope,
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
  threadExecutionIsRunning,
  threadUsageFromSessionRateLimits,
  userMessageHistoryFromRecords,
  withActivityStatusSnapshots
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
  const activeRuntimeSession = useMemo(
    () => {
      if (selectedProjectByKey) return runtimeSessionForProject(selectedProjectByKey, state.sessionList);
      return state.sessionList.find((session) => session.sessionId === state.activeSessionId)
      ?? undefined;
    },
    [state.activeSessionId, state.activeWorkspacePath, projectList, selectedProjectByKey, state.sessionList]
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
      return isVscodeSurface ? groups.filter((group) => group.projects.length > 0) : groups;
    },
    [projectList, state.machines]
  );
  const selectedProject = useMemo(() => {
    if (selectedProjectByKey) return selectedProjectByKey;
    if (activeRuntimeSession) {
      return projectList.find((project) =>
        project.machineId === activeRuntimeSession.machineId
        && Boolean(state.activeWorkspacePath)
        && project.path === state.activeWorkspacePath
        )
        ?? projectList.find((project) =>
          project.machineId === activeRuntimeSession.machineId
          && project.path === activeRuntimeSession.workingDirectory
        );
    }
    if (state.activeSessionId) {
      const session = state.sessionList.find((session) => session.sessionId === state.activeSessionId);
      const sessionProject = session
        ? projectList.find((project) =>
          project.machineId === session.machineId
          && (!state.activeWorkspacePath || project.path === state.activeWorkspacePath || project.path === session.workingDirectory)
        )
        : undefined;
      if (sessionProject) return sessionProject;
    }
    return state.activeWorkspacePath ? projectList.find((project) => project.path === state.activeWorkspacePath) : undefined;
  }, [activeRuntimeSession, state.activeSessionId, state.activeWorkspacePath, projectList, selectedProjectByKey, state.sessionList]);
  const activeProjectKey = selectedProject ? projectKeyForProject(selectedProject) : "";
  const activeProjectThreads = useMemo(() => {
    const byId = new Map<string, ThreadSummary>();
    const projectPath = selectedProject?.path ?? state.activeWorkspacePath;
    for (const thread of activeRuntimeSession?.threads ?? []) {
      if (projectPath && thread.workingDirectory !== projectPath) continue;
      byId.set(thread.threadId, thread);
    }
    const orderedIds = state.threadOrderBySession[activeRuntimeSession?.sessionId ?? ""] ?? [];
    return [
      ...orderedIds.flatMap((threadId) => {
        const thread = byId.get(threadId);
        if (!thread) return [];
        byId.delete(threadId);
        return [thread];
      }),
      ...byId.values()
    ];
  }, [activeRuntimeSession, selectedProject?.path, state.activeWorkspacePath, state.threadOrderBySession]);
  const openThreadIds = useMemo(
    () => state.openThreads.map((thread) => thread.threadId),
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
      withStatusDurations(
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
  const activeRuntimeOnline = Boolean(activeThread?.session.online && activeThread.session.runnable !== false);
  const activeCanStop = Boolean(activeThreadIsOpen && activeRuntimeOnline && activeThread?.running);
  const showComposerSendButton = Boolean(activeThread && !activeThread.running);
  const openThreadEmptyMessage = openThreadIds.length
    ? selectedProject
      ? activeRuntimeSession?.online
        ? activeProjectThreads.length ? "Select a thread" : "No threads"
        : selectedProject.machineOnline ? "No threads" : "Machine offline"
      : "Select a thread"
    : activeRuntimeSession
    ? activeRuntimeSession.online
      ? activeProjectThreads.length ? "Select a thread" : "No threads"
      : "Session disconnected"
    : selectedProject
    ? selectedProject.machineOnline ? "No threads" : "Machine offline"
    : "No session";
  const latestThreadUsage = useMemo(
    () => latestThreadUsageFromRecords(latestTurnActivity.records) ?? latestThreadUsageFromRecords(displayRecords),
    [displayRecords, latestTurnActivity.records]
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
  const effectiveReasoningSelection: ReasoningSelection = activeThreadReasoningDraft === "auto" && activeThreadReasoning
    ? activeThreadReasoning
    : activeThreadReasoningDraft;
  const effectiveServiceTierSelection: ServiceTierSelection = activeThreadServiceTierDraft === "auto" && activeThreadServiceTier
    ? activeThreadServiceTier
    : activeThreadServiceTierDraft;
  const activeModelCatalogState = activeRuntimeSession?.sessionId
    ? state.modelCatalogBySession[activeRuntimeSession.sessionId]
    : undefined;
  const activeModelCatalog = activeModelCatalogState?.status === "ready"
    ? activeModelCatalogState.models
    : [];
  const activeModelCatalogStatus: "unavailable" | "idle" | "loading" | "ready" | "error" = activeRuntimeSession?.sessionId
    ? activeModelCatalogState?.status ?? "idle"
    : "unavailable";
  const activeModelCatalogError = activeModelCatalogState?.status === "error"
    ? activeModelCatalogState.error ?? "Model catalog unavailable."
    : "";
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
    activeRuntimeSession,
    activeThread,
    activeThreadModel,
    activeThreadIsOpen,
    activeThreadModelDraft,
    activeThreadApprovalPolicySelection,
    activeModelCatalogError,
    activeModelCatalogStatus,
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
  };
};

const withStatusDurations = <T extends CodexRecordView>(
  views: T[],
  turnDurations: Map<string, number>
): T[] =>
  views.map((view) => {
    if (!isFinalAnswerView(view) || view.statusDurationMs != null) return view;
    if (view.status !== "completed" && view.status !== "failed") return view;
    const turnId = turnIdFromRecordView(view);
    const statusDurationMs = turnId ? turnDurations.get(turnId) : undefined;
    if (statusDurationMs == null) return view;
    return {
      ...view,
      statusDurationMs
    };
  });

const turnDurationMapFromRecords = (records: CodexRecord[]) => {
  const startedByTurn = new Map<string, number>();
  const durationByTurn = new Map<string, number>();
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type !== "event_msg" || !payload) continue;
    const turnId = typeof payload.turn_id === "string"
      ? payload.turn_id
      : typeof payload.turnId === "string" ? payload.turnId : "";
    if (!turnId) continue;
    if (payload.type === "task_started") {
      const startedMs = timestampMsFromRecord(record);
      if (startedMs != null) startedByTurn.set(turnId, startedMs);
      continue;
    }
    if (payload.type !== "task_complete" && payload.type !== "turn_aborted") continue;
    const direct = typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms)
      ? Math.max(0, payload.duration_ms)
      : undefined;
    if (direct != null) {
      durationByTurn.set(turnId, direct);
      continue;
    }
    const startedMs = startedByTurn.get(turnId);
    const finishedMs = timestampMsFromRecord(record);
    if (startedMs != null && finishedMs != null) {
      durationByTurn.set(turnId, Math.max(0, finishedMs - startedMs));
    }
  }
  return durationByTurn;
};

const isFinalAnswerView = (view: CodexRecordView) =>
  view.role === "codex" && view.label === "final_answer";

const turnIdFromRecordView = (view: CodexRecordView) => {
  const parts = view.record.id.split(":");
  return parts[0] === "app" && parts.length >= 3 ? parts[2] : "";
};

const timestampMsFromRecord = (record: CodexRecord) => {
  const parsed = Date.parse(record.timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
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
