import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import type { VirtuosoHandle } from "react-virtuoso";
import { asRecord, type CodexRecord } from "../core/codexRecord.js";
import { recordsToViews, type CodexRecordView } from "../core/codexRecordView.js";
import { compactToolViews } from "../shared/compactRecordViews.js";
import { recordsToDetailedViews } from "./detailedRecordViews.js";
import { AppView } from "./AppView.js";
import { createComposerActions } from "./appActions/composerActions.js";
import { createProjectActions } from "./appActions/projectActions.js";
import { createRealtimeActions } from "./appActions/realtimeActions.js";
import { createSshActions } from "./appActions/sshActions.js";
import { createTaskActions } from "./appActions/taskActions.js";
import { createThreadActions } from "./appActions/threadActions.js";
import { jsonlLinesToRecords } from "./jsonlRecordViews.js";
import "antd/dist/antd.css";
import "./style.css";
import type {
  ChatSession,
  ComposerHistoryState,
  ComposerMode,
  ConnectionMode,
  GoalDialogState,
  LocalTask,
  MachineSummary,
  MessageContextMenuState,
  MessageDisplayMode,
  MessageRenderMode,
  ModelSelection,
  PluginSummary,
  ProjectPickerState,
  ProjectSummary,
  ReasoningSelection,
  SessionView,
  SshConnection,
  SshHost,
  SystemStatus,
  ThreadSummary,
  ThreadPickerState,
  TaskDraft,
  WebRecordView
} from "./types.js";

import { isVscodeSurface, storageKey } from "./appConfig.js";
import {
  authToken,
  activityStatusesFromRecords,
  activityStatusTitle,
  combineRecordSources,
  defaultTaskDraft,
  formatComposerModelButtonLabel,
  formatComposerModelTitle,
  formatContextTitle,
  formatContextUsage,
  formatRateLimitRemaining,
  formatResetTitle,
  groupProjectsByMachine,
  initAuthTokenFromUrl,
  isSimpleMainView,
  isSimpleRecord,
  latestSessionConfigFromRecords,
  latestThreadGoalFromRecords,
  latestThreadUsageFromRecords,
  latestTurnStatusFromRecords,
  latestUserTurnStatusScope,
  machineProjectLauncher,
  mergeThreadUsage,
  modelOptionsForSelection,
  normalizeReasoningEffort,
  primeTaskCompletionSound,
  projectKeyForProject,
  setAuthToken,
  threadDisplayTitle,
  turnUiStateFromStatus,
  usageTotal,
  userMessageHistoryFromRecords
} from "./appHelpers.js";
const resizeComposerTextarea = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) return;
  textarea.style.height = "auto";
  const maxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
  const shouldScroll = Number.isFinite(maxHeight) && textarea.scrollHeight > maxHeight;
  textarea.style.height = `${shouldScroll ? maxHeight : textarea.scrollHeight}px`;
  textarea.style.overflowY = shouldScroll ? "auto" : "hidden";
};

const registeredMachineCommand = (origin: string, token: string) => {
  const command = `codexhub machine --server ${shellQuote(origin)} --type registered`;
  return token.trim()
    ? `CODEX_HUB_AUTH_TOKEN=${shellQuote(token.trim())} ${command}`
    : command;
};

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const App = () => {
  useState(() => initAuthTokenFromUrl());
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
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
  const [registeredCommandCopied, setRegisteredCommandCopied] = useState(false);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [tasks, setTasks] = useState<LocalTask[]>([]);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(() => defaultTaskDraft());
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [taskBusyId, setTaskBusyId] = useState("");
  const [taskError, setTaskError] = useState("");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [openingProjectKey, setOpeningProjectKey] = useState("");
  const [projectOpenError, setProjectOpenError] = useState("");
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
    contextWindowTokens: null
  });
  const [selectedModel, setSelectedModel] = useState<ModelSelection>("auto");
  const [selectedReasoning, setSelectedReasoning] = useState<ReasoningSelection>("auto");
  const [composerMode, setComposerMode] = useState<ComposerMode>("chat");
  const [messageDisplayMode, setMessageDisplayMode] = useState<MessageDisplayMode>("compact");
  const [messageRenderModes, setMessageRenderModes] = useState<Record<string, MessageRenderMode>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isVscodeSurface);
  const [collapsedProjectMachineKeys, setCollapsedProjectMachineKeys] = useState<string[]>([]);
  const [offlineProjectsCollapsed, setOfflineProjectsCollapsed] = useState(true);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [goalDialog, setGoalDialog] = useState<GoalDialogState | null>(null);
  const [hiddenStatusTurns, setHiddenStatusTurns] = useState<Record<string, string>>({});
  const [expandedStatusKeys, setExpandedStatusKeys] = useState<Record<string, string[]>>({});
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
  const messagesScrollerRef = useRef<HTMLElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerHistoryRef = useRef<ComposerHistoryState | null>(null);
  const notificationRecordsByThread = useRef(new Map<string, CodexRecord[]>());
  const notifiedTaskCompletions = useRef(new Set<string>());
  const notificationAudioContext = useRef<AudioContext | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.threadId === activeTabThreadId),
    [activeTabThreadId, sessions]
  );
  useEffect(() => {
    resizeComposerTextarea(composerTextareaRef.current);
  }, [activeSession?.threadId, activeSession?.input]);

  const projectList = useMemo(() => projects, [projects]);
  const activeProjectSession = useMemo(
    () => sessionList.find((session) => session.sessionId === activeSessionId)
      ?? projectList.find((project) => project.session?.sessionId === activeSessionId)?.session
      ?? undefined,
    [activeSessionId, projectList, sessionList]
  );
  const onlineMachines = useMemo(() => machines.filter((machine) => machine.online), [machines]);
  const localMachines = useMemo(() => machines.filter((machine) => machine.type === "local"), [machines]);
  const registeredMachines = useMemo(() => machines.filter((machine) => machine.type === "registered"), [machines]);
  const sshConfigHostOptions = useMemo(() => {
    const savedAliases = new Set(sshHosts.map((host) => host.alias));
    return sshConfigHosts.filter((host) => !savedAliases.has(host.alias));
  }, [sshConfigHosts, sshHosts]);
  const registeredCommand = useMemo(() => registeredMachineCommand(window.location.origin, serverAuthRequired ? authToken() : ""), [serverAuthRequired, authRequired]);
  const registeredCommandIncludesToken = serverAuthRequired && registeredCommand.includes("CODEX_HUB_AUTH_TOKEN=");
  const projectGroups = useMemo(() => groupProjectsByMachine(projectList, machines), [projectList, machines]);
  const selectedProject = useMemo(() => {
    const explicitProject = selectedProjectKey
      ? projectList.find((project) => projectKeyForProject(project) === selectedProjectKey)
      : undefined;
    if (explicitProject) return explicitProject;
    if (activeProjectSession) {
      return projectList.find((project) => project.session?.sessionId === activeProjectSession.sessionId)
        ?? projectList.find((project) => project.machineId === activeProjectSession.machineId && project.path === activeProjectSession.workingDirectory);
    }
    if (activeSessionId) {
      const sessionProject = projectList.find((project) => project.session?.sessionId === activeSessionId);
      if (sessionProject) return sessionProject;
    }
    return activeWorkspacePath ? projectList.find((project) => project.path === activeWorkspacePath) : undefined;
  }, [activeProjectSession, activeSessionId, activeWorkspacePath, projectList, selectedProjectKey]);
  const activeProjectKey = selectedProject ? projectKeyForProject(selectedProject) : "";
  const activeProjectSessionThreads = useMemo(() => {
    const byId = new Map<string, ThreadSummary>();
    for (const thread of activeProjectSession?.threads ?? []) byId.set(thread.threadId, thread);
    const orderedIds = threadOrderBySession[activeProjectSession?.sessionId ?? ""] ?? [];
    return [
      ...orderedIds.flatMap((threadId) => {
        const thread = byId.get(threadId);
        if (!thread) return [];
        byId.delete(threadId);
        return [thread];
      }),
      ...byId.values()
    ];
  }, [activeProjectSession, threadOrderBySession]);
  const activeProjectSessionThreadIds = useMemo(
    () => activeProjectSessionThreads.map((thread) => thread.threadId),
    [activeProjectSessionThreads]
  );
  const activeThreadSummary = useMemo(
    () => activeProjectSessionThreads.find((thread) => thread.threadId === activeTabThreadId) ?? null,
    [activeProjectSessionThreads, activeTabThreadId]
  );
  const activeProjectSessionThreadIdsKey = activeProjectSessionThreadIds.join("\n");
  const activeProjectSessionThreadTabs = useMemo(() => activeProjectSessionThreads.map((thread) => {
    const title = threadDisplayTitle(thread);
    return {
      key: thread.threadId,
      label: (
        <span className="workspaceThreadTabLabel" title={`${title}\n${thread.threadId}`}>
          <span>{title}</span>
          <code>{thread.threadId}</code>
        </span>
      )
    };
  }), [activeProjectSessionThreads]);
  const displayRecords = useMemo(
    () => activeSession?.jsonl?.lines.length
      ? jsonlLinesToRecords(activeSession.threadId, activeSession.jsonl)
      : activeSession?.records ?? [],
    [activeSession?.jsonl, activeSession?.records, activeSession?.threadId]
  );
  const goalRecords = useMemo(
    () => combineRecordSources(displayRecords, activeSession?.records ?? []),
    [activeSession?.records, displayRecords]
  );
  const simpleRecords = useMemo(
    () => displayRecords.filter(isSimpleRecord),
    [displayRecords]
  );
  const baseViews = useMemo<CodexRecordView[]>(
    () => recordsToViews(simpleRecords).filter(isSimpleMainView),
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
  const latestGoalScope = useMemo(
    () => latestUserTurnStatusScope(goalRecords),
    [goalRecords]
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
    () => messageDisplayMode === "compact" ? latestTurnStatuses : [],
    [latestTurnStatuses, messageDisplayMode]
  );
  const activeGoal = useMemo(
    () => latestThreadGoalFromRecords(latestGoalScope.records, activeSession?.threadId),
    [activeSession?.threadId, latestGoalScope.records]
  );
  const turnUiState = useMemo(
    () => turnUiStateFromStatus(latestTurnStatus, Boolean(activeSession?.running)),
    [activeSession?.running, latestTurnStatus]
  );
  const statusPanelHidden = Boolean(
    activeSession?.threadId
    && latestTurnStatusScope.key
    && hiddenStatusTurns[activeSession.threadId] === latestTurnStatusScope.key
  );
  const showInlineStatusPanel = Boolean(simpleStatuses.length && !statusPanelHidden);
  const statusButtonLabel = simpleStatuses.length ? `Status ${simpleStatuses.length}` : "Status";
  const statusButtonTitle = simpleStatuses.length
    ? `Show latest turn status\n${activityStatusTitle(simpleStatuses)}`
    : turnUiState.title;
  const statusScopeKey = activeSession?.threadId && latestTurnStatusScope.key
    ? `${activeSession.threadId}:${latestTurnStatusScope.key}`
    : "";
  const activeExpandedStatusKeys = useMemo(
    () => new Set(statusScopeKey ? expandedStatusKeys[statusScopeKey] ?? [] : []),
    [expandedStatusKeys, statusScopeKey]
  );
  const activeViews = useMemo<WebRecordView[]>(
    () => messageDisplayMode === "compact" ? compactToolViews(baseViews) : detailedViews,
    [baseViews, detailedViews, messageDisplayMode]
  );
  const activeUserMessageHistory = useMemo(
    () => userMessageHistoryFromRecords(displayRecords),
    [displayRecords]
  );
  const latestView = activeViews.at(-1);
  const latestViewKey = latestView
    ? `${latestView.id}:${latestView.status ?? ""}:${latestView.text.length}:${latestView.usage ? usageTotal(latestView.usage) : ""}`
    : "";
  const activeDisplayThreadId = activeSession?.threadId ?? activeTabThreadId;
  const activeThreadBelongsToSession = Boolean(activeSession && activeProjectSessionThreads.some((thread) => thread.threadId === activeSession.threadId));
  const activeHasDraft = Boolean(activeSession?.input.trim() || activeSession?.imageAttachments.length || activeSession?.textAttachments.length);
  const activeCanSend = Boolean(
    activeSession
    && activeThreadBelongsToSession
    && activeProjectSession?.online
    && activeHasDraft
  );
  const activeCanStop = Boolean(activeThreadBelongsToSession && activeSession?.running);
  const activeCanSubmit = activeCanSend;
  const showComposerSendButton = Boolean(activeSession && !activeSession.running);
  const workspaceEmptyMessage = activeProjectSession
    ? activeProjectSession.online
      ? activeProjectSessionThreads.length ? "Select a thread" : "No threads"
      : "Session disconnected"
    : "No session";
  const latestThreadUsage = useMemo(
    () => latestThreadUsageFromRecords(latestTurnStatusScope.records) ?? latestThreadUsageFromRecords(displayRecords),
    [displayRecords, latestTurnStatusScope.records]
  );
  const summaryThreadUsage = activeSession?.threadUsage
    ?? activeThreadSummary?.threadUsage
    ?? null;
  const activeThreadUsage = mergeThreadUsage(latestThreadUsage, summaryThreadUsage);
  const latestSessionConfig = useMemo(
    () => latestSessionConfigFromRecords(latestTurnStatusScope.records) ?? latestSessionConfigFromRecords(displayRecords),
    [displayRecords, latestTurnStatusScope.records]
  );
  const activeSessionModel = latestSessionConfig?.model
    ?? activeSession?.model
    ?? activeThreadSummary?.model
    ?? systemStatus.model
    ?? null;
  const activeSessionReasoning = latestSessionConfig?.reasoning
    ?? activeSession?.modelReasoningEffort
    ?? activeThreadSummary?.modelReasoningEffort
    ?? normalizeReasoningEffort(systemStatus.modelReasoningEffort)
    ?? null;
  const effectiveModelSelection = selectedModel === "auto" && activeSessionModel ? activeSessionModel : selectedModel;
  const effectiveReasoningSelection: ReasoningSelection = selectedReasoning === "auto" && activeSessionReasoning
    ? activeSessionReasoning
    : selectedReasoning;
  const modelOptions = useMemo(
    () => modelOptionsForSelection(effectiveModelSelection),
    [effectiveModelSelection]
  );
  const composerModelButtonLabel = formatComposerModelButtonLabel(
    selectedModel,
    selectedReasoning,
    activeSessionModel,
    activeSessionReasoning
  );
  const composerModelButtonTitle = formatComposerModelTitle(
    selectedModel,
    selectedReasoning,
    activeSessionModel,
    activeSessionReasoning
  );
  const renderComposerSessionControls = (mode: "inline" | "popover") => (
    <div className={`composerSessionControls ${mode}`} aria-label="Session usage and model">
      <div className="composerUsagePills" aria-label="Session usage">
        <button
          type="button"
          className={`usagePill statusPill${simpleStatuses.length ? " available" : ""}`}
          disabled={!simpleStatuses.length}
          title={statusButtonTitle}
          onClick={() => {
            if (!activeSession?.threadId) return;
            setHiddenStatusTurns((current) => {
              if (!(activeSession.threadId in current)) return current;
              const next = { ...current };
              delete next[activeSession.threadId];
              return next;
            });
          }}
        >
          {statusButtonLabel}
        </button>
        <span className="usagePill" title={formatContextTitle(activeThreadUsage)}>
          Context {formatContextUsage(activeThreadUsage)}
        </span>

        <span className="usagePill" title={formatResetTitle(activeThreadUsage?.primaryRateLimit)}>5h {formatRateLimitRemaining(activeThreadUsage?.primaryRateLimit)}</span>
        <span className="usagePill" title={formatResetTitle(activeThreadUsage?.secondaryRateLimit)}>weekly {formatRateLimitRemaining(activeThreadUsage?.secondaryRateLimit)}</span>
      </div>
      <button
        type="button"
        className="composerModelButton"
        title={composerModelButtonTitle}
        onClick={() => {
          setSessionMenuOpen(false);
          setSessionDialogOpen(true);
        }}
      >
        {composerModelButtonLabel}
      </button>
    </div>
  );

  useEffect(() => {
    void initialize();
    return () => {
      realtimeSocket.current?.close();
      if (controlReconnectTimer.current !== null) {
        window.clearTimeout(controlReconnectTimer.current);
        controlReconnectTimer.current = null;
      }
      realtimeThreadSubscriptions.current.clear();
    };
  }, []);

  useEffect(() => {
    const primeSound = () => primeTaskCompletionSound(notificationAudioContext);
    window.addEventListener("pointerdown", primeSound, { capture: true, once: true });
    window.addEventListener("keydown", primeSound, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", primeSound, true);
      window.removeEventListener("keydown", primeSound, true);
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    localStorage.setItem(storageKey, JSON.stringify({
      activeWorkspacePath,
      activeSessionId,
      selectedProjectKey,
      projectSearch,
      selectedModel,
      selectedReasoning,
      messageDisplayMode,
      sidebarCollapsed,
      collapsedProjectMachineKeys
    }));
  }, [
    activeWorkspacePath,
    activeSessionId,
    selectedProjectKey,
    projectSearch,
    selectedModel,
    selectedReasoning,
    messageDisplayMode,
    sidebarCollapsed,
    collapsedProjectMachineKeys,
    initialized
  ]);

  useEffect(() => {
    if (!initialized) return;
    setTaskDraft((current) => {
      if (current.machineId && current.projectPath) return current;
      const preferredMachine = onlineMachines.find(machineProjectLauncher)
        ?? machines.find(machineProjectLauncher)
        ?? onlineMachines[0]
        ?? machines[0];
      const preferredProject = preferredMachine
        ? projectList.find((project) => project.machineId === preferredMachine.machineId)
        : projectList[0];
      const nextMachineId = current.machineId || preferredProject?.machineId || preferredMachine?.machineId || "";
      const nextProjectPath = current.projectPath || preferredProject?.path || "";
      if (nextMachineId === current.machineId && nextProjectPath === current.projectPath) return current;
      return {
        ...current,
        machineId: nextMachineId,
        projectPath: nextProjectPath
      };
    });
  }, [initialized, machines, onlineMachines, projectList]);

  useEffect(() => {
    if (!initialized || !selectedProject) return;
    setTaskDraft((current) => {
      if (current.machineId === selectedProject.machineId && current.projectPath === selectedProject.path) return current;
      return {
        ...current,
        machineId: selectedProject.machineId,
        projectPath: selectedProject.path,
        threadId: ""
      };
    });
  }, [initialized, selectedProject?.machineId, selectedProject?.path]);

  useEffect(() => {
    if (!initialized) return;
    const projectSessions = projectList.flatMap((project) => project.session ? [project.session] : []);
    if (!projectSessions.length) {
      if (activeSessionId) setActiveSessionId("");
      if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }

    const selectedProjectSession = selectedProject?.session;
    if (selectedProjectKey && selectedProject && activeProjectSession && selectedProject.session?.sessionId !== activeProjectSession.sessionId) {
      if (selectedProjectSession) setActiveSessionId(selectedProjectSession.sessionId);
      else {
        setActiveSessionId("");
        if (activeTabThreadId) setActiveTabThreadId("");
      }
      return;
    }
    if (!activeProjectSession && selectedProjectKey && selectedProject) {
      if (selectedProjectSession) setActiveSessionId(selectedProjectSession.sessionId);
      else if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }

    const session = activeProjectSession ?? projectSessions[0];
    if (!session) return;
    if (!activeProjectSession) {
      setActiveSessionId(session.sessionId);
      return;
    }

    setActiveWorkspacePath(session.workingDirectory);
    const threadIds = new Set((session.threads ?? []).map((thread) => thread.threadId));
    const activeTabThreadIdForSession = activeTabThreadBySession[session.sessionId];
    const currentThreadId = activeTabThreadId && threadIds.has(activeTabThreadId)
      ? activeTabThreadId
      : undefined;
    const projectLastThreadId = selectedProject?.session?.sessionId === session.sessionId
      ? selectedProject?.lastThreadId
      : undefined;
    const desiredThreadId = activeTabThreadIdForSession && threadIds.has(activeTabThreadIdForSession)
      ? activeTabThreadIdForSession
      : currentThreadId
      ?? (projectLastThreadId && threadIds.has(projectLastThreadId)
        ? projectLastThreadId
        : session.threads?.[0]?.threadId);

    if (activeTabThreadIdForSession && !threadIds.has(activeTabThreadIdForSession)) {
      setActiveTabThreadBySession(({ [session.sessionId]: _removed, ...rest }) => rest);
    }

    if (!desiredThreadId) {
      if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }
    if (activeTabThreadId !== desiredThreadId) {
      void openThread(desiredThreadId).catch(() => clearActiveThreadIfLatest(desiredThreadId));
    }
  }, [activeTabThreadId, activeProjectSession, activeSessionId, initialized, activeTabThreadBySession, projectList, selectedProject]);

  useEffect(() => {
    if (!initialized) return;
    syncThreadSubscriptions(activeProjectSessionThreadIds);
  }, [activeProjectSessionThreadIdsKey, initialized]);

  useEffect(() => {
    if (!activeSession) return;
    setSelectedModel(activeSession.model ?? "auto");
    setSelectedReasoning(activeSession.modelReasoningEffort ?? "auto");
  }, [activeSession?.threadId, activeSession?.model, activeSession?.modelReasoningEffort]);

  useEffect(() => {
    if (!activeViews.length) return;
    const scrollToBottom = (behavior: "auto" | "smooth" = "smooth") => {
      messagesRef.current?.scrollToIndex({
        index: "LAST",
        align: "end",
        behavior
      });
      const scroller = messagesScrollerRef.current;
      if (scroller) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      }
    };
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToBottom(activeSession?.running ? "auto" : "smooth");
      window.setTimeout(() => scrollToBottom("auto"), 80);
    });
    return () => window.cancelAnimationFrame(firstFrame);
  }, [activeTabThreadId, activeViews.length, latestViewKey, activeSession?.running]);

  useEffect(() => {
    if (!composerMenuOpen) return undefined;
    const close = () => setComposerMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [composerMenuOpen]);

  useEffect(() => {
    if (!sessionMenuOpen) return undefined;
    const close = () => setSessionMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [sessionMenuOpen]);

  useEffect(() => {
    if (!messageContextMenu) return undefined;
    const close = () => setMessageContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [messageContextMenu]);

  useEffect(() => {
    setMessageContextMenu(null);
  }, [activeTabThreadId]);

  useEffect(() => {
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !activeSession?.running) return;
      event.preventDefault();
      void stopTurn(activeSession.threadId);
    };
    window.addEventListener("keydown", stopOnEscape);
    return () => window.removeEventListener("keydown", stopOnEscape);
  }, [activeSession?.threadId, activeSession?.running]);

  useEffect(() => {
    const links: HTMLLinkElement[] = [];
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      for (const style of plugin.contributions?.web?.styles ?? []) {
        if (!style.url) continue;
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = style.url;
        link.dataset.codexhubPlugin = plugin.pluginId;
        link.dataset.codexhubPluginAsset = style.path;
        document.head.appendChild(link);
        links.push(link);
      }
    }
    return () => {
      for (const link of links) link.remove();
    };
  }, [plugins]);

  const actionContext = {
    activeCanSend,
    activeProjectSession,
    activeProjectSessionThreads,
    activeTabThreadBySession,
    activeTabThreadId,
    closedThreadIds,
    collapsedProjectMachineKeys,
    composerHistoryRef,
    composerMode,
    connectionsLastSeq,
    controlReconnectTimer,
    goalDialog,
    latestRequestedThreadId,
    machines,
    messageContextMenu,
    notificationAudioContext,
    notificationRecordsByThread,
    notifiedTaskCompletions,
    openingThreads,
    projectList,
    projectPicker,
    projectSearch,
    projectsLastSeq,
    realtimeSocket,
    realtimeThreadSubscriptions,
    registeredCommand,
    resizeComposerTextarea,
    selectedModel,
    selectedProjectKey,
    selectedReasoning,
    sessionList,
    sessions,
    sessionsLastSeq,
    setActiveSessionId,
    setActiveTabThreadBySession,
    setActiveTabThreadId,
    setActiveWorkspacePath,
    setAuthError,
    setAuthRequired,
    setServerAuthRequired,
    setCollapsedProjectMachineKeys,
    setComposerMenuOpen,
    setComposerMode,
    setDeletingProjectId,
    setGoalDialog,
    setInitialized,
    setInspectMessage,
    setMachines,
    setMessageContextMenu,
    setMessageDisplayMode,
    setMessageRenderModes,
    setOpeningProjectKey,
    setPlugins,
    setProjectOpenError,
    setProjectPicker,
    setProjects,
    setProjectSearch,
    setRegisteredCommandCopied,
    setSelectedModel,
    setSelectedProjectKey,
    setSelectedReasoning,
    setSessionDialogOpen,
    setSessionList,
    setSessionMenuOpen,
    setSessions,
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
    setThreadOrderBySession,
    setThreadPicker,
    sshHostDraft,
    sshHosts,
    taskDraft,
    tasksLastSeq,
    threadLastSeqs,
    threadOrderBySession,
    threadPicker
  };
  const actions: Record<string, any> = {};
  Object.assign(
    actions,
    createRealtimeActions(actionContext, actions),
    createSshActions(actionContext, actions),
    createTaskActions(actionContext, actions),
    createThreadActions(actionContext, actions),
    createComposerActions(actionContext, actions),
    createProjectActions(actionContext, actions)
  );
  const {
    addContextSelectionToConversation,
    addSessionFiles,
    addSessionImages,
    addSshHost,
    changeProjectPickerMachine,
    chooseThreadCandidate,
    clearActiveThreadIfLatest,
    clearThreadGoal,
    closeThread,
    confirmProjectPicker,
    connectSshHost,
    copyContextSelection,
    copyRegisteredCommand,
    createSessionThread,
    createTask,
    deleteProject,
    deleteTask,
    focusTaskDraftProject,
    forkMessage,
    handleComposerKeyDown,
    initialize,
    inspectContextMessage,
    loadProjectPickerDirectory,
    openMessageContextMenu,
    openProjectPicker,
    openThread,
    openThreadPicker,
    pasteSessionImages,
    patchTask,
    removeSessionImage,
    removeSessionTextAttachment,
    removeSshHost,
    resetComposerHistory,
    rollbackMessage,
    runTaskNow,
    saveGoalDialog,
    selectProject,
    send,
    stopTurn,
    submitProjectPickerPath,
    switchSessionThread,
    syncThreadSubscriptions,
    toggleProjectMachineGroup,
    toggleProjectPinned,
    updateMessageRenderMode,
    updateSessionInput,
    updateTaskDraftMachine,
    updateTaskDraftProject,
    updateThreadGoal
  } = actions;

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

  const viewModel = {
    activeCanSend,
    activeCanStop,
    activeCanSubmit,
    activeDisplayThreadId,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeProjectSession,
    activeProjectSessionThreadTabs,
    activeSession,
    activeThreadBelongsToSession,
    activeUserMessageHistory,
    activeViews,
    activeWorkspacePath,
    authError,
    authRequired,
    authTokenDraft,
    addContextSelectionToConversation,
    addSessionFiles,
    addSessionImages,
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
    connectSshHost,
    copyContextSelection,
    copyRegisteredCommand,
    createSessionThread,
    createTask,
    deleteProject,
    deleteTask,
    deletingProjectId,
    effectiveModelSelection,
    effectiveReasoningSelection,
    focusTaskDraftProject,
    forkMessage,
    goalDialog,
    handleComposerKeyDown,
    imageFileInputRef,
    inspectContextMessage,
    inspectMessage,
    latestTurnStatusScope,
    loadProjectPickerDirectory,
    localMachines,
    machines,
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    messagesRef,
    messagesScrollerRef,
    modelOptions,
    offlineProjectsCollapsed,
    onlineMachines,
    openingProjectKey,
    openMessageContextMenu,
    openProjectPicker,
    openThreadPicker,
    pasteSessionImages,
    patchTask,
    plugins,
    projectGroups,
    projectList,
    projectOpenError,
    projectPicker,
    projectSearch,
    registeredCommand,
    registeredCommandIncludesToken,
    registeredCommandCopied,
    registeredMachines,
    removeSessionImage,
    removeSessionTextAttachment,
    removeSshHost,
    renderComposerSessionControls,
    resetComposerHistory,
    resizeComposerTextarea,
    rollbackMessage,
    runTaskNow,
    saveGoalDialog,
    selectedProject,
    selectProject,
    send,
    sessionDialogOpen,
    sessionList,
    sessionMenuOpen,
    sessions,
    setComposerMenuOpen,
    setComposerMode,
    setConnectionMode,
    setExpandedStatusKeys,
    setGoalDialog,
    setHiddenStatusTurns,
    setInspectMessage,
    setMessageContextMenu,
    setMessageDisplayMode,
    setOfflineProjectsCollapsed,
    setProjectPicker,
    setProjectSearch,
    setAuthTokenDraft,
    setSelectedModel,
    setSelectedReasoning,
    setSessionDialogOpen,
    setSessionMenuOpen,
    setSidebarCollapsed,
    setSshHostDraft,
    setTaskDraft,
    setTaskFormOpen,
    setThreadPicker,
    showComposerSendButton,
    showInlineStatusPanel,
    sidebarCollapsed,
    simpleStatuses,
    sshConfigHostOptions,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHostDraft,
    sshHosts,
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
    turnUiState,
    updateMessageRenderMode,
    updateSessionInput,
    updateTaskDraftMachine,
    updateTaskDraftProject,
    updateThreadGoal,
    workspaceEmptyMessage
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
