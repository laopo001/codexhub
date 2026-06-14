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
import { createSshActions } from "./appActions/sshActions.js";
import { createTaskActions } from "./appActions/taskActions.js";
import { createThreadActions } from "./appActions/threadActions.js";
import "antd/dist/antd.css";
import "./style.css";
import type {
  ActivityStatusView,
  AppSettings,
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
  ParentRegistrationDraft,
  ParentRegistrationStatus,
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

import { defaultAppSettings, isVscodeSurface, storageKey, vscodeWorkspacePaths } from "./appConfig.js";
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
  latestThreadConfigFromRecords,
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
  shortId,
  threadUsageFromSessionRateLimits,
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
  const command = `codexhub server --register-to ${shellQuote(origin)}`;
  return token.trim()
    ? `${command} --register-auth-token ${shellQuote(token.trim())}`
    : command;
};

const defaultParentRegistrationDraft = (): ParentRegistrationDraft => ({
  url: "",
  machineId: "",
  name: ""
});

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const compactWorkspaceName = (value: string) => {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? (value || "workspace");
};

type ThreadTabTurnMeta = {
  status: "running" | "idle";
  duration: string;
};

const OpenThreadTabLabel = ({ thread, nowMs }: { thread: OpenThreadState; nowMs: number }) => {
  const title = threadDisplayTitle(thread);
  const workspaceName = compactWorkspaceName(thread.workingDirectory);
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
        <span className="openThreadTabTitle">{title}</span>
        <span className="openThreadTabMeta">
          <code title={`${thread.workingDirectory}\n${thread.threadId}`}>{workspaceName} · {shortId(thread.threadId)}</code>
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

const currentVscodeWorkspacePaths = new Set(vscodeWorkspacePaths);

const isCurrentVscodeWorkspaceProject = (project: ProjectSummary) =>
  project.source?.kind === "vscode"
  && (!currentVscodeWorkspacePaths.size || currentVscodeWorkspacePaths.has(project.path));

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
  const [parentRegistration, setParentRegistration] = useState<ParentRegistrationStatus>({ status: "idle" });
  const [parentRegistrationDraft, setParentRegistrationDraft] = useState<ParentRegistrationDraft>(() => defaultParentRegistrationDraft());
  const [parentRegistrationBusy, setParentRegistrationBusy] = useState(false);
  const [parentRegistrationError, setParentRegistrationError] = useState("");
  const [registeredCommandCopied, setRegisteredCommandCopied] = useState(false);
  const [serverShareCopied, setServerShareCopied] = useState(false);
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
  const appSettingsRef = useRef<AppSettings>(appSettings);
  appSettingsRef.current = appSettings;

  const activeThread = useMemo(
    () => openThreads.find((thread) => thread.threadId === activeTabThreadId),
    [activeTabThreadId, openThreads]
  );
  const composerMode = activeThread?.composerMode ?? "chat";
  const setComposerMode = (mode: ComposerMode) => {
    if (!activeTabThreadId) return;
    setOpenThreads((current) => current.map((thread) => thread.threadId === activeTabThreadId
      ? { ...thread, composerMode: mode }
      : thread));
  };
  const activeThreadModelDraft = activeThread?.modelDraft ?? "auto";
  const activeThreadReasoningDraft = activeThread?.reasoningDraft ?? "auto";
  const setActiveThreadModelDraft: React.Dispatch<React.SetStateAction<ModelSelection>> = (value) => {
    if (!activeTabThreadId) return;
    setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== activeTabThreadId) return thread;
      const next = typeof value === "function"
        ? (value as (current: ModelSelection) => ModelSelection)(thread.modelDraft)
        : value;
      return { ...thread, modelDraft: next };
    }));
  };
  const setActiveThreadReasoningDraft: React.Dispatch<React.SetStateAction<ReasoningSelection>> = (value) => {
    if (!activeTabThreadId) return;
    setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== activeTabThreadId) return thread;
      const next = typeof value === "function"
        ? (value as (current: ReasoningSelection) => ReasoningSelection)(thread.reasoningDraft)
        : value;
      return { ...thread, reasoningDraft: next };
    }));
  };
  useEffect(() => {
    resizeComposerTextarea(composerTextareaRef.current);
  }, [activeThread?.threadId, activeThread?.input]);

  const projectList = useMemo(
    () => isVscodeSurface
      ? projects.filter(isCurrentVscodeWorkspaceProject)
      : projects,
    [projects]
  );
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
  const activeRuntimeSession = useMemo(
    () => activeProjectSession?.sessionId
      ? sessionList.find((session) => session.sessionId === activeProjectSession.sessionId) ?? activeProjectSession
      : activeProjectSession,
    [activeProjectSession, sessionList]
  );
  const onlineMachines = useMemo(() => machines.filter((machine) => machine.online), [machines]);
  const localMachines = useMemo(() => machines.filter((machine) => machine.type === "local"), [machines]);
  const registeredMachines = useMemo(() => machines.filter((machine) => machine.type === "registered" && machine.online), [machines]);
  const sshConfigHostOptions = useMemo(() => {
    const savedAliases = new Set(sshHosts.map((host) => host.alias));
    return sshConfigHosts.filter((host) => !savedAliases.has(host.alias));
  }, [sshConfigHosts, sshHosts]);
  const registeredCommand = useMemo(() => registeredMachineCommand(window.location.origin, serverAuthRequired ? authToken() : ""), [serverAuthRequired, authRequired]);
  const registeredCommandIncludesToken = serverAuthRequired && registeredCommand.includes("--register-auth-token");
  const currentServerShareUrl = useMemo(
    () => currentServerRegisterUrlWithToken(),
    [authRequired, authTokenDraft, initialized, serverAuthRequired]
  );
  const projectGroups = useMemo(
    () => {
      const groups = groupProjectsByMachine(projectList, machines);
      return isVscodeSurface ? groups.filter((group) => group.projects.length > 0) : groups;
    },
    [projectList, machines]
  );
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
    () => messageDisplayMode === "compact" ? latestTurnStatuses : [],
    [latestTurnStatuses, messageDisplayMode]
  );
  const activeGoal = useMemo(
    () => latestThreadGoalFromRecords(goalRecords, activeThread?.threadId),
    [activeThread?.threadId, goalRecords]
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
    ?? systemStatus.model
    ?? null;
  const activeThreadReasoning = latestThreadConfig?.reasoning
    ?? activeThread?.modelReasoningEffort
    ?? activeThreadSummary?.modelReasoningEffort
    ?? normalizeReasoningEffort(systemStatus.modelReasoningEffort)
    ?? null;
  const effectiveModelSelection = activeThreadModelDraft === "auto" && activeThreadModel ? activeThreadModel : activeThreadModelDraft;
  const effectiveReasoningSelection: ReasoningSelection = activeThreadReasoningDraft === "auto" && activeThreadReasoning
    ? activeThreadReasoning
    : activeThreadReasoningDraft;
  const modelOptions = useMemo(
    () => modelOptionsForSelection(effectiveModelSelection),
    [effectiveModelSelection]
  );
  const composerModelButtonLabel = formatComposerModelButtonLabel(
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadModel,
    activeThreadReasoning
  );
  const composerModelButtonTitle = formatComposerModelTitle(
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadModel,
    activeThreadReasoning
  );
  const renderComposerThreadControls = (mode: "inline" | "popover") => (
    <div className={`composerSessionControls ${mode}`} aria-label="Thread usage and model">
      <div className="composerUsagePills" aria-label="Thread usage">
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
          setThreadControlsMenuOpen(false);
          setThreadModelDialogOpen(true);
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
      messageDisplayMode,
      settings: appSettings,
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
    messageDisplayMode,
    appSettings,
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
    if (!threadControlsMenuOpen) return undefined;
    const close = () => setThreadControlsMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [threadControlsMenuOpen]);

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

  const setAppSettings: React.Dispatch<React.SetStateAction<AppSettings>> = (value) => {
    setAppSettingsState((current) => {
      const next = typeof value === "function"
        ? (value as (current: AppSettings) => AppSettings)(current)
        : value;
      appSettingsRef.current = next;
      return next;
    });
  };

  const actionContext = {
    activeCanSend,
    activeProjectSession,
    activeTabThreadBySession,
    activeTabThreadId,
    appSettingsRef,
    closedThreadIds,
    collapsedProjectMachineKeys,
    composerHistoryRef,
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
    parentRegistrationDraft,
    projectList,
    projectPicker,
    projectSearch,
    projectsLastSeq,
    realtimeSocket,
    realtimeThreadSubscriptions,
    registeredCommand,
    resizeComposerTextarea,
    selectedProjectKey,
    sessionList,
    openThreads,
    sessionsLastSeq,
    setActiveSessionId,
    setActiveTabThreadBySession,
    setActiveTabThreadId,
    setActiveWorkspacePath,
    setAppSettings,
    setAuthError,
    setAuthRequired,
    setServerAuthRequired,
    setCollapsedProjectMachineKeys,
    setComposerMenuOpen,
    setDeletingProjectId,
    setGoalDialog,
    setInitialized,
    setInspectMessage,
    setMachines,
    setMessageContextMenu,
    setMessageDisplayMode,
    setMessageRenderModes,
    setOpeningProjectKey,
    setParentRegistration,
    setParentRegistrationBusy,
    setParentRegistrationDraft,
    setParentRegistrationError,
    setPlugins,
    setProjectOpenError,
    setProjectPicker,
    setProjects,
    setProjectSearch,
    setRegisteredCommandCopied,
    setSelectedProjectKey,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setThreadModelDialogOpen,
    setSessionList,
    setThreadControlsMenuOpen,
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
    addThreadFiles,
    addThreadImages,
    addSshHost,
    changeProjectPickerMachine,
    chooseThreadCandidate,
    clearActiveThreadIfLatest,
    clearThreadGoal,
    closeThread,
    confirmProjectPicker,
    connectParentRegistration,
    connectSshHost,
    copyContextSelection,
    copyRegisteredCommand,
    createSessionThread,
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
    openMessageContextMenu,
    openProjectPicker,
    openThread,
    openThreadPicker,
    pasteThreadImages,
    patchTask,
    removeThreadImage,
    removeThreadTextAttachment,
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
    activeProjectSession,
    activeThread,
    activeThreadIsOpen,
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
    createTask,
    currentServerShareUrl,
    deleteProject,
    deleteTask,
    deletingProjectId,
    disconnectParentRegistration,
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
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    messagesRef,
    messagesScrollerRef,
    modelOptions,
    offlineProjectsCollapsed,
    onlineMachines,
    openingProjectKey,
    openMessageContextMenu,
    openProjectPicker,
    openThreadPicker,
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
    projectOpenError,
    projectPicker,
    projectSearch,
    registeredCommand,
    registeredCommandIncludesToken,
    registeredCommandCopied,
    registeredMachines,
    removeThreadImage,
    removeThreadTextAttachment,
    removeSshHost,
    renderComposerThreadControls,
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
    serverShareCopied,
    threadModelDialogOpen,
    sessionList,
    threadControlsMenuOpen,
    settingsDialogOpen,
    openThreads,
    setAppSettings,
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
    setParentRegistrationDraft,
    setProjectPicker,
    setProjectSearch,
    setAuthTokenDraft,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setThreadModelDialogOpen,
    setThreadControlsMenuOpen,
    setSettingsDialogOpen,
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

function currentServerRegisterUrlWithToken() {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.origin);
  url.searchParams.delete("codexhub_token");
  url.searchParams.delete("token");
  const token = authToken();
  if (token) url.searchParams.set("token", token);
  const search = url.searchParams.toString();
  return `${url.origin}${search ? `?${search}` : ""}`;
}
