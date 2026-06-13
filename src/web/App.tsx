import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, Popover } from "antd";
import type { VirtuosoHandle } from "react-virtuoso";
import { asRecord, type CodexRecord } from "../core/codexRecord.js";
import { recordsToViews, type CodexRecordView } from "../core/codexRecordView.js";
import { compactToolViews } from "../shared/compactRecordViews.js";
import { recordsToDetailedViews } from "./detailedRecordViews.js";
import { AppView } from "./AppView.js";
import { createComposerActions } from "./appActions/composerActions.js";
import { createProjectActions } from "./appActions/projectActions.js";
import { createRealtimeActions } from "./appActions/realtimeActions.js";
import { createServerConnectionActions } from "./appActions/serverConnectionActions.js";
import { createSshActions } from "./appActions/sshActions.js";
import { createTaskActions } from "./appActions/taskActions.js";
import { createThreadActions } from "./appActions/threadActions.js";
import "antd/dist/antd.css";
import "./style.css";
import type {
  ActivityStatusView,
  OpenThreadState,
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
  ServerConnection,
  ServerConnectionDraft,
  ServerThreadGroup,
  SessionView,
  SshConnection,
  SshHost,
  SystemStatus,
  ThreadSummary,
  ThreadPickerState,
  TaskDraft,
  WebRecordView
} from "./types.js";

import { storageKey } from "./appConfig.js";
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
  hideSupersededSimpleThinkingViews,
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
  preferredThreadIdForSession,
  projectKeyForProject,
  setAuthToken,
  threadDisplayRecords,
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

type ThreadTabTurnMeta = {
  status: "running" | "idle";
  duration: string;
};

const OpenThreadTabLabel = ({ thread, nowMs }: { thread: OpenThreadState; nowMs: number }) => {
  const title = threadDisplayTitle(thread);
  const records = threadDisplayRecords(thread.threadId, thread);
  const turnStatus = latestTurnStatusFromRecords(records);
  const turnMeta = threadTabTurnMeta(thread, records, turnStatus, nowMs);
  const badgeText = turnMeta.duration
    ? `${turnMeta.status} | ${turnMeta.duration}`
    : turnMeta.status;
  const details = (
    <div className="openThreadTabDetails">
      <div>
        <span>Path</span>
        <code>{thread.workingDirectory}</code>
      </div>
      <div>
        <span>Title</span>
        <code>{title}</code>
      </div>
      <div>
        <span>Thread</span>
        <code>{thread.threadId}</code>
      </div>
      <div>
        <span>Status</span>
        <code>{badgeText}</code>
      </div>
      {thread.session.sessionId ? (
        <div>
          <span>Session</span>
          <code>{thread.session.sessionId}</code>
        </div>
      ) : null}
    </div>
  );

  return (
    <Popover
      content={details}
      placement="bottomLeft"
      trigger="click"
      overlayClassName="openThreadTabDetailsPopover"
    >
      <span
        className="openThreadTabLabel"
        title={`${thread.workingDirectory}\n${title}\n${thread.threadId}`}
      >
        <code className="openThreadTabPath">{thread.workingDirectory}</code>
        <span className="openThreadTabTitle">{title}</span>
        <span className="openThreadTabMeta">
          <code>{thread.threadId}</code>
          <em className={`openThreadTabBadge ${turnMeta.status}`}>{badgeText}</em>
        </span>
      </span>
    </Popover>
  );
};

const threadTabTurnMeta = (
  thread: OpenThreadState,
  records: CodexRecord[],
  turnStatus: ActivityStatusView | null,
  nowMs: number
): ThreadTabTurnMeta => {
  const running = Boolean(thread.running || turnStatus?.status === "pending");
  if (running) {
    const startedAt = latestTurnStartedAt(records) ?? (turnStatus?.status === "pending" ? turnStatus.at : undefined);
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    return {
      status: "running",
      duration: Number.isFinite(startedMs) ? formatThreadTabDuration(nowMs - startedMs) : ""
    };
  }
  const durationMs = latestCompletedTurnDurationMs(records);
  return {
    status: "idle",
    duration: durationMs == null ? "" : formatThreadTabDuration(durationMs)
  };
};

const latestTurnStartedAt = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const payload = asRecord(record.payload);
    if (record.type === "event_msg" && payload?.type === "task_started") return record.timestamp;
  }
  return undefined;
};

const latestCompletedTurnDurationMs = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = asRecord(records[index].payload);
    if (!payload || (payload.type !== "task_complete" && payload.type !== "turn_aborted")) continue;
    const duration = payload.duration_ms;
    return typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, duration) : undefined;
  }
  return undefined;
};

const formatThreadTabDuration = (durationMs: number) => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h${minutes}m${remainder}s`;
  if (minutes) return `${minutes}m${remainder}s`;
  return `${remainder}s`;
};

const App = () => {
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
  const [serverConnections, setServerConnections] = useState<ServerConnection[]>([]);
  const [serverConnectionDraft, setServerConnectionDraft] = useState<ServerConnectionDraft>({ name: "", url: "" });
  const [serverConnectionBusyId, setServerConnectionBusyId] = useState("");
  const [serverConnectionError, setServerConnectionError] = useState("");
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const serverConnectionsLastSeq = useRef(0);
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

  const activeThread = useMemo(
    () => openThreads.find((thread) => thread.threadId === activeTabThreadId),
    [activeTabThreadId, openThreads]
  );
  useEffect(() => {
    resizeComposerTextarea(composerTextareaRef.current);
  }, [activeThread?.threadId, activeThread?.input]);

  const projectList = useMemo(() => projects, [projects]);
  const selectedProjectByKey = useMemo(
    () => selectedProjectKey
      ? projectList.find((project) => projectKeyForProject(project) === selectedProjectKey)
      : undefined,
    [projectList, selectedProjectKey]
  );
  const activeProjectSession = useMemo(
    () => {
      if (selectedProjectByKey) return selectedProjectByKey.session ?? undefined;
      return projectList.find((project) =>
        project.session?.sessionId === activeSessionId
        && (!activeWorkspacePath || project.path === activeWorkspacePath)
      )?.session
      ?? projectList.find((project) => project.session?.sessionId === activeSessionId)?.session
      ?? sessionList.find((session) => session.sessionId === activeSessionId)
      ?? undefined;
    },
    [activeSessionId, activeWorkspacePath, projectList, selectedProjectByKey, sessionList]
  );
  const onlineMachines = useMemo(() => machines.filter((machine) => machine.online), [machines]);
  const localMachines = useMemo(() => machines.filter((machine) => machine.type === "local"), [machines]);
  const serverMachines = useMemo(() => machines.filter((machine) => machine.type === "server"), [machines]);
  const serverThreadGroups = useMemo<ServerThreadGroup[]>(() => serverMachines.map((machine) => {
    const connectionSessions = sessionList.filter((session) => session.machineId === machine.machineId);
    const threads = connectionSessions
      .flatMap((session) => (session.threads ?? []).map((thread) => ({
        session,
        thread
      })))
      .sort((left, right) => Number(right.thread.running) - Number(left.thread.running)
        || right.thread.updatedAt.localeCompare(left.thread.updatedAt));
    return {
      machine,
      sessions: connectionSessions,
      threads
    };
  }), [serverMachines, sessionList]);
  const registeredMachines = useMemo(() => machines.filter((machine) => machine.type === "registered"), [machines]);
  const sshConfigHostOptions = useMemo(() => {
    const savedAliases = new Set(sshHosts.map((host) => host.alias));
    return sshConfigHosts.filter((host) => !savedAliases.has(host.alias));
  }, [sshConfigHosts, sshHosts]);
  const registeredCommand = useMemo(() => registeredMachineCommand(window.location.origin, serverAuthRequired ? authToken() : ""), [serverAuthRequired, authRequired]);
  const registeredCommandIncludesToken = serverAuthRequired && registeredCommand.includes("CODEX_HUB_AUTH_TOKEN=");
  const currentServerShareUrl = useMemo(
    () => currentPageUrlWithToken(serverAuthRequired),
    [authRequired, authTokenDraft, initialized, serverAuthRequired]
  );
  const projectGroups = useMemo(() => groupProjectsByMachine(projectList, machines), [projectList, machines]);
  const selectedProject = useMemo(() => {
    if (selectedProjectByKey) return selectedProjectByKey;
    if (activeProjectSession) {
      return projectList.find((project) =>
        project.session?.sessionId === activeProjectSession.sessionId
        && project.path === activeProjectSession.workingDirectory
      )
        ?? projectList.find((project) =>
          project.session?.sessionId === activeProjectSession.sessionId
          && (!activeWorkspacePath || project.path === activeWorkspacePath)
        )
        ?? projectList.find((project) => project.session?.sessionId === activeProjectSession.sessionId)
        ?? projectList.find((project) => project.machineId === activeProjectSession.machineId && project.path === activeProjectSession.workingDirectory);
    }
    if (activeSessionId) {
      const sessionProject = projectList.find((project) => project.session?.sessionId === activeSessionId);
      if (sessionProject) return sessionProject;
    }
    return activeWorkspacePath ? projectList.find((project) => project.path === activeWorkspacePath) : undefined;
  }, [activeProjectSession, activeSessionId, activeWorkspacePath, projectList, selectedProjectByKey]);
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
  const openThreadIds = useMemo(
    () => openThreads.map((thread) => thread.threadId),
    [openThreads]
  );
  const runningOpenThreadIds = useMemo(
    () => openThreads.filter((thread) => thread.running).map((thread) => thread.threadId).join("\n"),
    [openThreads]
  );
  useEffect(() => {
    if (!runningOpenThreadIds) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningOpenThreadIds]);
  const activeThreadSummary = useMemo(
    () => {
      if (activeThread) return activeThread;
      for (const session of sessionList) {
        const thread = session.threads?.find((item) => item.threadId === activeTabThreadId);
        if (thread) return thread;
      }
      return null;
    },
    [activeThread, activeTabThreadId, sessionList]
  );
  const openThreadIdsKey = openThreadIds.join("\n");
  const openThreadTabs = useMemo(() => openThreads.map((thread) => {
    return {
      key: thread.threadId,
      label: <OpenThreadTabLabel thread={thread} nowMs={nowMs} />
    };
  }), [nowMs, openThreads]);
  const displayRecords = useMemo(
    () => activeThread ? threadDisplayRecords(activeThread.threadId, activeThread) : [],
    [activeThread?.jsonl, activeThread?.records, activeThread?.threadId]
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
    () => latestThreadGoalFromRecords(latestGoalScope.records, activeThread?.threadId),
    [activeThread?.threadId, latestGoalScope.records]
  );
  const turnUiState = useMemo(
    () => turnUiStateFromStatus(latestTurnStatus, Boolean(activeThread?.running)),
    [activeThread?.running, latestTurnStatus]
  );
  const statusPanelHidden = Boolean(
    activeThread?.threadId
    && latestTurnStatusScope.key
    && hiddenStatusTurns[activeThread.threadId] === latestTurnStatusScope.key
  );
  const showInlineStatusPanel = Boolean(simpleStatuses.length && !statusPanelHidden);
  const statusButtonLabel = simpleStatuses.length ? `Status ${simpleStatuses.length}` : "Status";
  const statusButtonTitle = simpleStatuses.length
    ? `Show latest turn status\n${activityStatusTitle(simpleStatuses)}`
    : turnUiState.title;
  const statusScopeKey = activeThread?.threadId && latestTurnStatusScope.key
    ? `${activeThread.threadId}:${latestTurnStatusScope.key}`
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
  const activeDisplayThreadId = activeThread?.threadId ?? activeTabThreadId;
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
  const openThreadEmptyMessage = openThreadTabs.length
    ? "Select a thread"
    : activeProjectSession
    ? activeProjectSession.online
      ? activeProjectSessionThreads.length ? "Select a thread" : "No threads"
      : "Session disconnected"
    : "No session";
  const latestThreadUsage = useMemo(
    () => latestThreadUsageFromRecords(latestTurnStatusScope.records) ?? latestThreadUsageFromRecords(displayRecords),
    [displayRecords, latestTurnStatusScope.records]
  );
  const summaryThreadUsage = activeThread?.threadUsage
    ?? activeThreadSummary?.threadUsage
    ?? null;
  const activeThreadUsage = mergeThreadUsage(latestThreadUsage, summaryThreadUsage);
  const latestSessionConfig = useMemo(
    () => latestSessionConfigFromRecords(latestTurnStatusScope.records) ?? latestSessionConfigFromRecords(displayRecords),
    [displayRecords, latestTurnStatusScope.records]
  );
  const activeThreadModel = latestSessionConfig?.model
    ?? activeThread?.model
    ?? activeThreadSummary?.model
    ?? systemStatus.model
    ?? null;
  const activeThreadReasoning = latestSessionConfig?.reasoning
    ?? activeThread?.modelReasoningEffort
    ?? activeThreadSummary?.modelReasoningEffort
    ?? normalizeReasoningEffort(systemStatus.modelReasoningEffort)
    ?? null;
  const effectiveModelSelection = selectedModel === "auto" && activeThreadModel ? activeThreadModel : selectedModel;
  const effectiveReasoningSelection: ReasoningSelection = selectedReasoning === "auto" && activeThreadReasoning
    ? activeThreadReasoning
    : selectedReasoning;
  const modelOptions = useMemo(
    () => modelOptionsForSelection(effectiveModelSelection),
    [effectiveModelSelection]
  );
  const composerModelButtonLabel = formatComposerModelButtonLabel(
    selectedModel,
    selectedReasoning,
    activeThreadModel,
    activeThreadReasoning
  );
  const composerModelButtonTitle = formatComposerModelTitle(
    selectedModel,
    selectedReasoning,
    activeThreadModel,
    activeThreadReasoning
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
            if (!activeThread?.threadId) return;
            setHiddenStatusTurns((current) => {
              if (!(activeThread.threadId in current)) return current;
              const next = { ...current };
              delete next[activeThread.threadId];
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
      activeTabThreadId,
      activeTabThreadBySession,
      openThreadIds,
      threadOrderBySession,
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
    activeTabThreadBySession,
    activeTabThreadId,
    openThreadIds,
    selectedProjectKey,
    projectSearch,
    selectedModel,
    selectedReasoning,
    messageDisplayMode,
    sidebarCollapsed,
    collapsedProjectMachineKeys,
    threadOrderBySession,
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
    const availableSessions = [...projectSessions, ...sessionList];
    if (!availableSessions.length) {
      if (activeSessionId) setActiveSessionId("");
      if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }

    const selectedProjectSession = selectedProject?.session;
    if (selectedProjectKey && selectedProject) {
      if (selectedProjectSession && activeSessionId !== selectedProjectSession.sessionId) {
        setActiveSessionId(selectedProjectSession.sessionId);
      } else if (!selectedProjectSession && !selectedProject.machineOnline && activeSessionId) {
        setActiveSessionId("");
      }
      return;
    }

    const activeTabSessionId = activeThread?.session.sessionId;
    const preferredSession = activeTabSessionId
      ? availableSessions.find((session) => session.sessionId === activeTabSessionId)
      : undefined;
    const session = preferredSession ?? activeProjectSession ?? projectSessions[0] ?? sessionList[0];
    if (session && !activeSessionId) setActiveSessionId(session.sessionId);

    if (activeTabThreadId || openThreads.length) return;

    const initialThreadId = session
      ? preferredThreadIdForSession(
        session,
        projectList.find((project) =>
          project.session?.sessionId === session.sessionId
          && project.path === session.workingDirectory
        )
      )
      : undefined;
    if (initialThreadId) {
      void openThread(initialThreadId).catch(() => clearActiveThreadIfLatest(initialThreadId));
    }
  }, [activeThread?.session.sessionId, activeSessionId, activeTabThreadId, activeProjectSession, initialized, projectList, selectedProject, selectedProjectKey, sessionList, openThreads.length]);

  useEffect(() => {
    if (!initialized) return;
    syncThreadSubscriptions(openThreadIds);
  }, [openThreadIdsKey, initialized]);

  useEffect(() => {
    if (!activeThread) return;
    setSelectedModel(activeThread.model ?? "auto");
    setSelectedReasoning(activeThread.modelReasoningEffort ?? "auto");
  }, [activeThread?.threadId, activeThread?.model, activeThread?.modelReasoningEffort]);

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
      scrollToBottom(activeThread?.running ? "auto" : "smooth");
      window.setTimeout(() => scrollToBottom("auto"), 80);
    });
    return () => window.cancelAnimationFrame(firstFrame);
  }, [activeTabThreadId, activeViews.length, latestViewKey, activeThread?.running]);

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
      if (event.key !== "Escape" || !activeThread?.running) return;
      event.preventDefault();
      void stopTurn(activeThread.threadId);
    };
    window.addEventListener("keydown", stopOnEscape);
    return () => window.removeEventListener("keydown", stopOnEscape);
  }, [activeThread?.threadId, activeThread?.running]);

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
    serverConnectionDraft,
    serverConnectionsLastSeq,
    sessionList,
    openThreads,
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
    setServerConnectionBusyId,
    setServerConnectionDraft,
    setServerConnectionError,
    setServerConnections,
    setSelectedModel,
    setSelectedProjectKey,
    setSelectedReasoning,
    setSessionDialogOpen,
    setSessionList,
    setSessionMenuOpen,
    setOpenThreads,
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
    serverConnections,
    serverConnectionBusyId,
    serverConnectionError,
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
    createServerConnectionActions(actionContext, actions),
    createSshActions(actionContext, actions),
    createTaskActions(actionContext, actions),
    createThreadActions(actionContext, actions),
    createComposerActions(actionContext, actions),
    createProjectActions(actionContext, actions)
  );
  const {
    addContextSelectionToConversation,
    addThreadFiles,
    addThreadImages,
    addServerConnection,
    addSshHost,
    changeProjectPickerMachine,
    chooseThreadCandidate,
    clearActiveThreadIfLatest,
    clearThreadGoal,
    closeThread,
    confirmProjectPicker,
    connectServerConnection,
    connectSshHost,
    copyContextSelection,
    copyRegisteredCommand,
    createSessionThread,
    createTask,
    deleteProject,
    deleteTask,
    disconnectServerConnection,
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
    pasteThreadImages,
    patchTask,
    removeThreadImage,
    removeThreadTextAttachment,
    removeServerConnection,
    removeSshHost,
    resetComposerHistory,
    rollbackMessage,
    runTaskNow,
    saveGoalDialog,
    selectProject,
    selectProjectSession,
    selectSessionThread,
    send,
    stopTurn,
    submitProjectPickerPath,
    switchSessionThread,
    syncThreadSubscriptions,
    toggleProjectMachineGroup,
    toggleProjectPinned,
    toggleServerConnectionEnabled,
    updateMessageRenderMode,
    updateThreadInput,
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
    activeThread,
    activeThreadIsOpen,
    activeUserMessageHistory,
    activeViews,
    activeWorkspacePath,
    authError,
    authRequired,
    authTokenDraft,
    addContextSelectionToConversation,
    addThreadFiles,
    addThreadImages,
    addServerConnection,
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
    connectServerConnection,
    connectSshHost,
    copyContextSelection,
    copyRegisteredCommand,
    createSessionThread,
    createTask,
    currentServerShareUrl,
    deleteProject,
    deleteTask,
    deletingProjectId,
    disconnectServerConnection,
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
    pasteThreadImages,
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
    removeThreadImage,
    removeThreadTextAttachment,
    removeServerConnection,
    removeSshHost,
    renderComposerSessionControls,
    resetComposerHistory,
    resizeComposerTextarea,
    rollbackMessage,
    runTaskNow,
    saveGoalDialog,
    selectedProject,
    selectProject,
    selectProjectSession,
    selectSessionThread,
    send,
    sessionDialogOpen,
    sessionList,
    sessionMenuOpen,
    serverConnectionBusyId,
    serverConnectionDraft,
    serverConnectionError,
    serverConnections,
    serverMachines,
    serverThreadGroups,
    openThreads,
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
    setServerConnectionDraft,
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
    toggleServerConnectionEnabled,
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

function currentPageUrlWithToken(includeToken: boolean) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  url.searchParams.delete("codexhub_token");
  url.searchParams.delete("token");
  const token = authToken();
  if (includeToken && token) url.searchParams.set("token", token);
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  const search = url.searchParams.toString();
  return `${url.origin}${pathname}${search ? `?${search}` : ""}${url.hash}`;
}
