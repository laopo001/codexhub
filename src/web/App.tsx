import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { type Components } from "react-markdown";
import { ConfigProvider, Switch, Tabs } from "antd";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import remarkGfm from "remark-gfm";
import { asRecord, type CodexRecord } from "../core/codexRecord.js";
import { recordsToViews, type CodexRecordView } from "../core/codexRecordView.js";
import { threadUsageFromRecord } from "../core/threadUsage.js";
import { compactToolViews, type CompactRecordView } from "../shared/compactRecordViews.js";
import { recordsToDetailedViews } from "./detailedRecordViews.js";
import { jsonlLinesToRecords, type JsonlLine, type ThreadJsonl } from "./jsonlRecordViews.js";
import {
  normalizeUpdatePlanStatus,
  parseUpdatePlanArguments,
  updatePlanStatusIcon,
  updatePlanStatusLabel,
  type UpdatePlanView as UpdatePlanViewModel
} from "../shared/updatePlanView.js";
import "antd/dist/antd.css";
import "./style.css";

type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  runtime: ThreadRuntimeSummary;
  model?: string;
  modelReasoningEffort?: ReasoningEffort;
  status: ThreadStatus;
  running: boolean;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
  threadUsage: ThreadUsage;
};

type ThreadRuntimeSummary =
  {
    sessionId?: string;
    name?: string;
    online: boolean;
    runnable: boolean;
    lastSeenAt?: string;
  };

type ThreadDetail = ThreadSummary & {
  records: CodexRecord[];
  jsonl?: ThreadJsonl;
  lastSeq: number;
};

type ThreadGoalView = {
  objective: string;
  status: string;
  tokenBudget?: number;
  updatedAt?: string;
};

type GoalDialogState = {
  threadId: string;
  objective: string;
  saving: boolean;
  error: string;
};

type RuntimeSessionSummary = {
  sessionId: string;
  machineId?: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  online: boolean;
  status?: "online" | "offline";
  lastSeenAt: string;
  offlineSinceAt?: string;
  offlineReason?: "heartbeat_timeout" | "transport_disconnected" | "unregistered";
  pid?: number;
  hostname?: string;
  threads?: ThreadSummary[];
};

type RuntimeSession = RuntimeSessionSummary & {
  sessionId: string;
};

type MachineSummary = {
  machineId: string;
  type?: "local" | "ssh" | "registered";
  name?: string;
  hostname: string;
  online: boolean;
  status: "online" | "offline";
  lastSeenAt: string;
  offlineSinceAt?: string;
  offlineReason?: "transport_disconnected" | "unregistered";
  cwd?: string;
  capabilities?: {
    projectLauncher?: boolean;
  };
};

type MachineDirectoryEntry = {
  name: string;
  path: string;
};

type MachineDirectoryListing = {
  cwd: string;
  parent?: string;
  home: string;
  entries: MachineDirectoryEntry[];
};

type SshHost = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFiles?: string[];
  proxyJump?: string;
  configured?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type SshConnection = {
  connectionId: string;
  host: string;
  name?: string;
  status: "starting" | "running" | "exited";
  remotePort: number;
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: string | null;
  lastOutput?: string;
};

type PluginSummary = {
  pluginId: string;
  name: string;
  version?: string;
  enabled: boolean;
  origin?: "builtin" | "local";
  contributions?: {
    web?: {
      styles?: Array<{
        path: string;
        url: string;
      }>;
    };
    integrations?: Array<{
      type: string;
      runtime: "builtin" | "external";
      enabled: boolean;
      label?: string;
      requiredEnv?: string[];
      configured?: boolean;
      started?: boolean;
    }>;
  };
};

type StoredProjectThread = {
  threadId: string;
  projectId: string;
  title: string;
  updatedAt: string;
  status: ThreadStatus;
  messageCount: number;
};

type CodexThreadCandidate = {
  threadId: string;
  cwd: string;
  path: string;
  updatedAt: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  artifactCount: number;
  messageCount: number;
};

type ProjectSummary = {
  projectId: string;
  machineId: string;
  path: string;
  name: string;
  pinned?: boolean;
  createdAt: string;
  lastOpenedAt: string;
  lastSessionId?: string;
  lastThreadId?: string;
  machine?: MachineSummary;
  machineOnline: boolean;
  runtime: RuntimeSession | null;
  online: boolean;
  running: boolean;
  sessions: RuntimeSession[];
  threads: ThreadSummary[];
  storedThreads: StoredProjectThread[];
};

type LocalTaskStatus = "queued" | "completed" | "failed" | "skipped";

type LocalTask = {
  taskId: string;
  name: string;
  enabled: boolean;
  schedule: string;
  machineId: string;
  projectPath: string;
  projectId?: string;
  threadId?: string;
  input: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: LocalTaskStatus;
  lastError?: string;
};

type TaskDraft = {
  name: string;
  enabled: boolean;
  schedule: string;
  machineId: string;
  projectPath: string;
  threadId: string;
  input: string;
};

type ProjectMachineGroup = {
  key: string;
  label: string;
  online: boolean;
  projectLauncher: boolean;
  statusLabel: string;
  projects: ProjectSummary[];
};

type ProjectPickerState = {
  machineId: string;
  path: string;
  parent?: string;
  home?: string;
  entries: MachineDirectoryEntry[];
  loading: boolean;
  error: string;
};

type ThreadPickerState = {
  sessionId: string;
  loading: boolean;
  error: string;
  candidates: CodexThreadCandidate[];
  acting: "new" | string | null;
};

type ProjectsPayload = {
  seq?: number;
  kind?: "projects";
  statePath?: string;
  machines?: MachineSummary[];
  projects?: ProjectSummary[];
};

type ChatSession = ThreadDetail & {
  input: string;
  imageAttachments: ImageAttachment[];
  textAttachments: TextAttachment[];
};

type ComposerHistoryState = {
  threadId: string;
  draft: string;
  offsetFromEnd: number;
};

type ImageAttachment = {
  id: string;
  file: File;
  name: string;
  previewUrl: string;
};

type TextAttachment = {
  id: string;
  text: string;
};

type MessageContextMenuState = {
  x: number;
  y: number;
  threadId: string;
  message: WebRecordView;
  selectedText: string;
  canInspect: boolean;
};

type StreamEvent = {
  seq: number;
  kind: "thread" | "record" | "done" | "jsonl_snapshot" | "jsonl_append";
  thread: ThreadSummary;
  record?: CodexRecord;
  jsonl?: ThreadJsonl;
};

type TaskCompleteNotification = {
  title: string;
  body: string;
  threadId: string;
  duration?: string;
};

type RuntimeSessionStreamEvent = {
  seq: number;
  kind: "sessions";
  sessions: RuntimeSession[];
};

type TasksStreamEvent = {
  seq: number;
  kind: "tasks";
  tasks: LocalTask[];
};

type ConnectionsStreamEvent = {
  seq: number;
  kind: "connections";
  connections: SshConnection[];
};

type RealtimeMessage =
  | ({ type: "sessions" } & RuntimeSessionStreamEvent)
  | ({ type: "projects" } & ProjectsPayload)
  | ({ type: "tasks" } & TasksStreamEvent)
  | ({ type: "connections" } & ConnectionsStreamEvent)
  | ({ type: "thread" | "record" | "done" | "jsonl_snapshot" | "jsonl_append" } & StreamEvent)
  | { type: "ready" }
  | { type: "thread_subscribed" | "thread_unsubscribed"; threadId: string }
  | { type: "error"; message: string; scope?: string; threadId?: string };

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens?: number;
};

type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type ThreadStatus = "running" | "idle";
type ModelSelection = string;
type ReasoningSelection = "auto" | ReasoningEffort;
type ComposerMode = "chat" | "plan" | "goal";
type MessageDisplayMode = "compact" | "detailed";
type MessageRenderMode = "markdown" | "raw";
type ConnectionMode = "local" | "ssh" | "registered";
type WebRecordView = CompactRecordView;
type RuntimeStatusView = {
  key: string;
  label: string;
  text: string;
  at?: string;
  status?: CodexRecordView["status"];
  files?: RuntimeStatusFile[];
};
type TurnUiStateKind = "idle" | "running" | "completed" | "aborted" | "failed";
type TurnUiState = {
  kind: TurnUiStateKind;
  label: string;
  title: string;
};
type RuntimeStatusFile = {
  path: string;
  added?: number;
  removed?: number;
};
type MemoryCitationEntry = {
  source: string;
  lineStart?: number;
  lineEnd?: number;
  note?: string;
  raw: string;
};
type MemoryCitationView = {
  text: string;
  entries: MemoryCitationEntry[];
  rolloutIds: string[];
};
type InspectDetail = {
  inputMeta: string;
  inputBlockLabel?: string;
  inputBlock?: string;
  memoryCitation?: MemoryCitationView;
  outputMeta?: string;
  outputBlockLabel?: string;
  outputBlock?: string;
  rawBlockLabel?: string;
  rawBlock?: string;
};
type WebToolPresenter = {
  render?: (args: Record<string, unknown>, status?: CodexRecordView["status"]) => React.ReactNode | null;
  inspect?: (args: Record<string, unknown>, output: string) => InspectDetail | null;
};
type ParsedToolCall = {
  name: string;
  args: Record<string, unknown>;
};

type SystemStatus = {
  model: string | null;
  modelReasoningEffort: string | null;
  contextWindowTokens: number | null;
};

type RateLimitWindow = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
};

type ThreadUsage = {
  context: {
    usedTokens: number;
    windowTokens: number;
  } | null;
  primaryRateLimit: RateLimitWindow | null;
  secondaryRateLimit: RateLimitWindow | null;
  observedAt: string | null;
};

const webSurface = new URLSearchParams(window.location.search).get("surface") === "vscode" ? "vscode" : "default";
const isVscodeSurface = webSurface === "vscode";
const storageKey = isVscodeSurface ? "codexhub-ui-state-vscode-v1" : "codexhub-ui-state-v5";
const legacyStorageKey = "codexhub-ui-state-v4";
const modelOptions: Array<{ value: ModelSelection; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  { value: "gpt-5.2", label: "GPT-5.2" }
];
const reasoningOptions: Array<{ value: ReasoningSelection; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" }
];
const composerModeOptions: Array<{ value: ComposerMode; label: string }> = [
  { value: "chat", label: "Chat" },
  { value: "plan", label: "Plan" },
  { value: "goal", label: "Goal" }
];

const SyntaxCodeBlock = lazy(() => import("./SyntaxCodeBlock.js"));

const languageAliases: Record<string, string> = {
  console: "bash",
  html: "markup",
  js: "javascript",
  md: "markdown",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  xml: "markup",
  yml: "yaml",
  zsh: "bash"
};
const highlightedLanguages = new Set([
  "bash",
  "css",
  "diff",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "markup",
  "python",
  "sql",
  "tsx",
  "typescript",
  "yaml"
]);

const resizeComposerTextarea = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) return;
  textarea.style.height = "auto";
  const maxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
  const shouldScroll = Number.isFinite(maxHeight) && textarea.scrollHeight > maxHeight;
  textarea.style.height = `${shouldScroll ? maxHeight : textarea.scrollHeight}px`;
  textarea.style.overflowY = shouldScroll ? "auto" : "hidden";
};

const App = () => {
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeTabThreadId, setActiveTabThreadId] = useState("");
  const [runtimeSessions, setRuntimeSessions] = useState<RuntimeSession[]>([]);
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
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [goalDialog, setGoalDialog] = useState<GoalDialogState | null>(null);
  const [hiddenStatusTurns, setHiddenStatusTurns] = useState<Record<string, string>>({});
  const [expandedStatusKeys, setExpandedStatusKeys] = useState<Record<string, string[]>>({});
  const realtimeSocket = useRef<WebSocket | null>(null);
  const runtimeSessionsLastSeq = useRef(0);
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
  const activeRuntimeSession = useMemo(
    () => runtimeSessions.find((session) => session.sessionId === activeSessionId)
      ?? projectList.find((project) => project.runtime?.sessionId === activeSessionId)?.runtime
      ?? undefined,
    [activeSessionId, projectList, runtimeSessions]
  );
  const onlineMachines = useMemo(() => machines.filter((machine) => machine.online), [machines]);
  const localMachines = useMemo(() => machines.filter((machine) => machine.type === "local"), [machines]);
  const registeredMachines = useMemo(() => machines.filter((machine) => machine.type === "registered"), [machines]);
  const sshConfigHostOptions = useMemo(() => {
    const savedAliases = new Set(sshHosts.map((host) => host.alias));
    return sshConfigHosts.filter((host) => !savedAliases.has(host.alias));
  }, [sshConfigHosts, sshHosts]);
  const registeredCommand = useMemo(() => {
    const origin = window.location.origin;
    return `codexhub machine --server ${origin} --type registered`;
  }, []);
  const projectGroups = useMemo(() => groupProjectsByMachine(projectList, machines), [projectList, machines]);
  const selectedProject = useMemo(() => {
    const explicitProject = selectedProjectKey
      ? projectList.find((project) => projectKeyForProject(project) === selectedProjectKey)
      : undefined;
    if (explicitProject) return explicitProject;
    if (activeRuntimeSession) {
      return projectList.find((project) => project.runtime?.sessionId === activeRuntimeSession.sessionId)
        ?? projectList.find((project) => project.machineId === activeRuntimeSession.machineId && project.path === activeRuntimeSession.workingDirectory);
    }
    if (activeSessionId) {
      const sessionProject = projectList.find((project) => project.runtime?.sessionId === activeSessionId);
      if (sessionProject) return sessionProject;
    }
    return activeWorkspacePath ? projectList.find((project) => project.path === activeWorkspacePath) : undefined;
  }, [activeRuntimeSession, activeSessionId, activeWorkspacePath, projectList, selectedProjectKey]);
  const activeProjectKey = selectedProject ? projectKeyForProject(selectedProject) : "";
  const activeRuntimeSessionThreads = useMemo(() => {
    const byId = new Map<string, ThreadSummary>();
    for (const thread of activeRuntimeSession?.threads ?? []) byId.set(thread.threadId, thread);
    const orderedIds = threadOrderBySession[activeRuntimeSession?.sessionId ?? ""] ?? [];
    return [
      ...orderedIds.flatMap((threadId) => {
        const thread = byId.get(threadId);
        if (!thread) return [];
        byId.delete(threadId);
        return [thread];
      }),
      ...byId.values()
    ];
  }, [activeRuntimeSession, threadOrderBySession]);
  const activeRuntimeSessionThreadIds = useMemo(
    () => activeRuntimeSessionThreads.map((thread) => thread.threadId),
    [activeRuntimeSessionThreads]
  );
  const activeThreadSummary = useMemo(
    () => activeRuntimeSessionThreads.find((thread) => thread.threadId === activeTabThreadId) ?? null,
    [activeRuntimeSessionThreads, activeTabThreadId]
  );
  const activeRuntimeSessionThreadIdsKey = activeRuntimeSessionThreadIds.join("\n");
  const activeRuntimeSessionThreadTabs = useMemo(() => activeRuntimeSessionThreads.map((thread) => {
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
  }), [activeRuntimeSessionThreads]);
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
    () => runtimeStatusesFromRecords(latestTurnStatusScope.records),
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
    ? `Show latest turn status\n${runtimeStatusTitle(simpleStatuses)}`
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
  const activeThreadBelongsToSession = Boolean(activeSession && activeRuntimeSessionThreads.some((thread) => thread.threadId === activeSession.threadId));
  const activeHasDraft = Boolean(activeSession?.input.trim() || activeSession?.imageAttachments.length || activeSession?.textAttachments.length);
  const activeCanSend = Boolean(
    activeSession
    && activeThreadBelongsToSession
    && activeRuntimeSession?.online
    && activeHasDraft
  );
  const activeCanStop = Boolean(activeThreadBelongsToSession && activeSession?.running);
  const activeCanSubmit = activeCanSend;
  const showComposerSendButton = Boolean(activeSession && !activeSession.running);
  const workspaceEmptyMessage = activeRuntimeSession
    ? activeRuntimeSession.online
      ? activeRuntimeSessionThreads.length ? "Select a thread" : "No threads"
      : "Runtime session disconnected"
    : "No runtime session";
  const latestThreadUsage = useMemo(
    () => latestThreadUsageFromRecords(latestTurnStatusScope.records) ?? latestThreadUsageFromRecords(displayRecords),
    [displayRecords, latestTurnStatusScope.records]
  );
  const summaryThreadUsage = activeSession?.threadUsage
    ?? activeThreadSummary?.threadUsage
    ?? null;
  const activeThreadUsage = mergeThreadUsage(latestThreadUsage, summaryThreadUsage);
  const latestRuntimeConfig = useMemo(
    () => latestRuntimeConfigFromRecords(latestTurnStatusScope.records) ?? latestRuntimeConfigFromRecords(displayRecords),
    [displayRecords, latestTurnStatusScope.records]
  );
  const activeRuntimeModel = latestRuntimeConfig?.model
    ?? activeSession?.model
    ?? activeThreadSummary?.model
    ?? systemStatus.model
    ?? null;
  const activeRuntimeReasoning = latestRuntimeConfig?.reasoning
    ?? activeSession?.modelReasoningEffort
    ?? activeThreadSummary?.modelReasoningEffort
    ?? normalizeReasoningEffort(systemStatus.modelReasoningEffort)
    ?? null;
  const effectiveModelSelection = selectedModel === "auto" && activeRuntimeModel ? activeRuntimeModel : selectedModel;
  const effectiveReasoningSelection: ReasoningSelection = selectedReasoning === "auto" && activeRuntimeReasoning
    ? activeRuntimeReasoning
    : selectedReasoning;
  const runtimeModelOptions = useMemo(
    () => modelOptionsForSelection(effectiveModelSelection),
    [effectiveModelSelection]
  );
  const composerModelButtonLabel = formatComposerModelButtonLabel(
    selectedModel,
    selectedReasoning,
    activeRuntimeModel,
    activeRuntimeReasoning
  );
  const composerModelButtonTitle = formatComposerModelTitle(
    selectedModel,
    selectedReasoning,
    activeRuntimeModel,
    activeRuntimeReasoning
  );
  const renderComposerRuntimeControls = (mode: "inline" | "popover") => (
    <div className={`composerRuntimeControls ${mode}`} aria-label="Runtime usage and model">
      <div className="composerUsagePills" aria-label="Runtime usage">
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
          setRuntimeMenuOpen(false);
          setRuntimeDialogOpen(true);
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
    const projectRuntimeSessions = projectList.flatMap((project) => project.runtime ? [project.runtime] : []);
    if (!projectRuntimeSessions.length) {
      if (activeSessionId) setActiveSessionId("");
      if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }

    const selectedProjectSession = selectedProject?.runtime;
    if (selectedProjectKey && selectedProject && activeRuntimeSession && selectedProject.runtime?.sessionId !== activeRuntimeSession.sessionId) {
      if (selectedProjectSession) setActiveSessionId(selectedProjectSession.sessionId);
      else {
        setActiveSessionId("");
        if (activeTabThreadId) setActiveTabThreadId("");
      }
      return;
    }
    if (!activeRuntimeSession && selectedProjectKey && selectedProject) {
      if (selectedProjectSession) setActiveSessionId(selectedProjectSession.sessionId);
      else if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }

    const session = activeRuntimeSession ?? projectRuntimeSessions[0];
    if (!activeRuntimeSession) {
      setActiveSessionId(session.sessionId);
      return;
    }

    setActiveWorkspacePath(session.workingDirectory);
    const threadIds = new Set((session.threads ?? []).map((thread) => thread.threadId));
    const activeTabThreadIdForRuntimeSession = activeTabThreadBySession[session.sessionId];
    const currentThreadId = activeTabThreadId && threadIds.has(activeTabThreadId)
      ? activeTabThreadId
      : undefined;
    const projectLastThreadId = selectedProject?.runtime?.sessionId === session.sessionId
      ? selectedProject.lastThreadId
      : undefined;
    const desiredThreadId = activeTabThreadIdForRuntimeSession && threadIds.has(activeTabThreadIdForRuntimeSession)
      ? activeTabThreadIdForRuntimeSession
      : currentThreadId
      ?? (projectLastThreadId && threadIds.has(projectLastThreadId)
        ? projectLastThreadId
        : session.threads?.[0]?.threadId);

    if (activeTabThreadIdForRuntimeSession && !threadIds.has(activeTabThreadIdForRuntimeSession)) {
      setActiveTabThreadBySession(({ [session.sessionId]: _removed, ...rest }) => rest);
    }

    if (!desiredThreadId) {
      if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }
    if (activeTabThreadId !== desiredThreadId) {
      void openThread(desiredThreadId).catch(() => clearActiveThreadIfLatest(desiredThreadId));
    }
  }, [activeTabThreadId, activeRuntimeSession, activeSessionId, initialized, activeTabThreadBySession, projectList, selectedProject]);

  useEffect(() => {
    if (!initialized) return;
    syncThreadSubscriptions(activeRuntimeSessionThreadIds);
  }, [activeRuntimeSessionThreadIdsKey, initialized]);

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
    if (!runtimeMenuOpen) return undefined;
    const close = () => setRuntimeMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [runtimeMenuOpen]);

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

  const initialize = async () => {
    const [health, sessionData, projectData, sshHostData, sshConfigHostData, sshConnectionData, pluginData, taskData] = await Promise.all([
      apiJson<{ defaultWorkingDirectory?: string | null } & SystemStatus>("/api/health"),
      apiJson<{ sessions?: RuntimeSession[] }>("/api/sessions"),
      apiJson<ProjectsPayload>("/api/projects"),
      isVscodeSurface ? Promise.resolve({ hosts: [] }) : apiJson<{ hosts?: SshHost[] }>("/api/ssh/hosts").catch(() => ({ hosts: [] })),
      isVscodeSurface ? Promise.resolve({ hosts: [] }) : apiJson<{ hosts?: SshHost[] }>("/api/ssh/config-hosts").catch(() => ({ hosts: [] })),
      isVscodeSurface ? Promise.resolve({ connections: [] }) : apiJson<{ connections?: SshConnection[] }>("/api/ssh/connections").catch(() => ({ connections: [] })),
      isVscodeSurface ? Promise.resolve({ plugins: [] }) : apiJson<{ plugins?: PluginSummary[] }>("/api/plugins").catch(() => ({ plugins: [] })),
      isVscodeSurface ? Promise.resolve({ tasks: [] }) : apiJson<{ tasks?: LocalTask[] }>("/api/tasks").catch(() => ({ tasks: [] }))
    ]);
    const defaultDirectory = health.defaultWorkingDirectory ?? "";
    const loadedRuntimeSessions = normalizeRuntimeSessions(sessionData.sessions);
    const loadedMachines = normalizeMachines(projectData.machines);
    const loadedProjects = normalizeProjects(projectData.projects);
    const loadedProjectRuntimeSessions = loadedProjects.flatMap((project) => project.runtime ? [project.runtime] : []);
    const saved = readStoredUiState();
    const savedRuntimeSession = saved?.activeSessionId
      ? loadedProjectRuntimeSessions.find((session) => session.sessionId === saved.activeSessionId)
      : undefined;
    const initialRuntimeSession = savedRuntimeSession ?? loadedProjectRuntimeSessions[0];

    setSystemStatus({
      model: health.model,
      modelReasoningEffort: health.modelReasoningEffort,
      contextWindowTokens: health.contextWindowTokens
    });
    setActiveWorkspacePath(saved?.activeWorkspacePath ?? defaultDirectory);
    setSelectedModel(saved?.selectedModel ?? "auto");
    setSelectedReasoning(saved?.selectedReasoning ?? "auto");
    setComposerMode("chat");
    setMessageDisplayMode(saved?.messageDisplayMode ?? "compact");
    setSidebarCollapsed(isVscodeSurface ? true : window.matchMedia("(max-width: 860px)").matches ? true : saved?.sidebarCollapsed ?? false);
    setSelectedProjectKey(saved?.selectedProjectKey ?? "");
    setCollapsedProjectMachineKeys(saved?.collapsedProjectMachineKeys ?? []);
    setMachines(loadedMachines);
    setProjects(loadedProjects);
    setSshHosts(Array.isArray(sshHostData.hosts) ? sshHostData.hosts : []);
    setSshConfigHosts(Array.isArray(sshConfigHostData.hosts) ? sshConfigHostData.hosts : []);
    setSshConnections(Array.isArray(sshConnectionData.connections) ? sshConnectionData.connections : []);
    setPlugins(normalizePlugins(pluginData.plugins));
    setTasks(normalizeTasks(taskData.tasks));
    setRuntimeSessions(loadedRuntimeSessions);
    setThreadOrderBySession((current) => mergeThreadOrderByRuntimeSession(current, loadedRuntimeSessions));
    connectRealtimeEvents();
    if (initialRuntimeSession) {
      setActiveSessionId(initialRuntimeSession.sessionId);
      setActiveWorkspacePath(initialRuntimeSession.workingDirectory);
      const initialProject = loadedProjects.find((project) => project.runtime?.sessionId === initialRuntimeSession.sessionId)
        ?? loadedProjects.find((project) => project.machineId === initialRuntimeSession.machineId && project.path === initialRuntimeSession.workingDirectory);
      const initialThreadId = preferredThreadIdForRuntimeSession(initialRuntimeSession, initialProject);
      if (initialThreadId) {
        await openThread(initialThreadId).catch(() => clearActiveThreadIfLatest(initialThreadId));
      }
    }
    setInitialized(true);
  };

  function clearControlReconnectTimer() {
    if (controlReconnectTimer.current === null) return;
    window.clearTimeout(controlReconnectTimer.current);
    controlReconnectTimer.current = null;
  }

  function scheduleControlReconnect() {
    clearControlReconnectTimer();
    controlReconnectTimer.current = window.setTimeout(() => {
      controlReconnectTimer.current = null;
      connectRealtimeEvents();
    }, 1000);
  }

  function realtimeUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/events/ws`;
  }

  function sendRealtime(message: unknown) {
    const socket = realtimeSocket.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function sendRealtimeHello() {
    sendRealtime({
      type: "hello",
      sessionsAfter: runtimeSessionsLastSeq.current,
      projectsAfter: projectsLastSeq.current,
      tasksAfter: tasksLastSeq.current,
      connectionsAfter: connectionsLastSeq.current
    });
  }

  function resubscribeRealtimeThreads() {
    for (const threadId of realtimeThreadSubscriptions.current) {
      sendRealtime({
        type: "subscribe_thread",
        threadId,
        after: threadLastSeqs.current.get(threadId) ?? 0
      });
    }
  }

  function connectRealtimeEvents() {
    clearControlReconnectTimer();
    realtimeSocket.current?.close();
    const socket = new WebSocket(realtimeUrl());
    socket.addEventListener("open", () => {
      sendRealtimeHello();
      resubscribeRealtimeThreads();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      const message = parseRealtimeMessage(event.data);
      if (!message) return;
      handleRealtimeMessage(message);
    });
    socket.addEventListener("error", () => {
      if (realtimeSocket.current === socket) socket.close();
    });
    socket.addEventListener("close", () => {
      if (realtimeSocket.current !== socket) return;
      realtimeSocket.current = null;
      scheduleControlReconnect();
    });
    realtimeSocket.current = socket;
  }

  function handleRealtimeMessage(message: RealtimeMessage) {
    if (message.type === "sessions") {
      const payload = message;
      runtimeSessionsLastSeq.current = Math.max(runtimeSessionsLastSeq.current, payload.seq);
      const nextRuntimeSessions = normalizeRuntimeSessions(payload.sessions);
      setRuntimeSessions(nextRuntimeSessions);
      setThreadOrderBySession((current) => mergeThreadOrderByRuntimeSession(current, nextRuntimeSessions));
      return;
    }
    if (message.type === "projects") {
      const payload = message;
      if (typeof payload.seq === "number") projectsLastSeq.current = Math.max(projectsLastSeq.current, payload.seq);
      setMachines(normalizeMachines(payload.machines));
      setProjects(normalizeProjects(payload.projects));
      return;
    }
    if (message.type === "tasks") {
      const payload = message;
      tasksLastSeq.current = Math.max(tasksLastSeq.current, payload.seq);
      setTasks(normalizeTasks(payload.tasks));
      return;
    }
    if (message.type === "connections") {
      const payload = message;
      connectionsLastSeq.current = Math.max(connectionsLastSeq.current, payload.seq);
      setSshConnections(Array.isArray(payload.connections) ? payload.connections : []);
      return;
    }
    if (
      message.type === "thread"
      || message.type === "record"
      || message.type === "done"
      || message.type === "jsonl_snapshot"
      || message.type === "jsonl_append"
    ) {
      applyThreadStreamEvent(message);
    }
  }

  const refreshSshHosts = async () => {
    const [hostData, configHostData] = await Promise.all([
      apiJson<{ hosts?: SshHost[] }>("/api/ssh/hosts"),
      apiJson<{ hosts?: SshHost[] }>("/api/ssh/config-hosts")
    ]);
    setSshHosts(Array.isArray(hostData.hosts) ? hostData.hosts : []);
    setSshConfigHosts(Array.isArray(configHostData.hosts) ? configHostData.hosts : []);
  };

  const refreshSshConnections = async () => {
    const payload = await apiJson<{ connections?: SshConnection[] }>("/api/ssh/connections");
    setSshConnections(Array.isArray(payload.connections) ? payload.connections : []);
  };

  const addSshHost = async (event: React.FormEvent) => {
    event.preventDefault();
    const alias = sshHostDraft.trim();
    if (!alias) return;
    setSshError("");
    setSshHostBusy(alias);
    try {
      const payload = await apiJson<{ hosts?: SshHost[] }>("/api/ssh/hosts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias })
      });
      setSshHosts(Array.isArray(payload.hosts) ? payload.hosts : []);
      await refreshSshHosts().catch(() => undefined);
      setSshHostDraft("");
    } catch (error) {
      setSshError(error instanceof Error ? error.message : String(error));
    } finally {
      setSshHostBusy((current) => current === alias ? "" : current);
    }
  };

  const connectSshHost = async (host: string, name?: string) => {
    const trimmedHost = host.trim();
    if (!trimmedHost) return;
    setSshError("");
    setSshConnectingHost(trimmedHost);
    try {
      const payload = await apiJson<{ connection?: SshConnection }>("/api/ssh/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: trimmedHost, name })
      });
      if (payload.connection) {
        setSshConnections((current) => [payload.connection!, ...current.filter((item) => item.connectionId !== payload.connection!.connectionId)]);
      }
      await refreshSshConnections().catch(() => undefined);
    } catch (error) {
      setSshError(error instanceof Error ? error.message : String(error));
    } finally {
      setSshConnectingHost((current) => current === trimmedHost ? "" : current);
    }
  };

  const stopSshConnection = async (connectionId: string) => {
    try {
      const payload = await apiJson<{ connection?: SshConnection }>(`/api/ssh/connections/${encodeURIComponent(connectionId)}`, {
        method: "DELETE"
      });
      if (payload.connection) {
        setSshConnections((current) => [payload.connection!, ...current.filter((item) => item.connectionId !== connectionId)]);
      }
      await refreshSshConnections().catch(() => undefined);
    } catch (error) {
      setSshError(error instanceof Error ? error.message : String(error));
    }
  };

  const removeSshHost = async (host: SshHost, activeConnection?: SshConnection) => {
    const suffix = activeConnection ? " and stop the current connection" : "";
    if (!window.confirm(`Remove ${host.alias} from CodexHub SSH hosts${suffix}?`)) return;
    setSshError("");
    setSshHostBusy(host.alias);
    try {
      const payload = await apiJson<{ hosts?: SshHost[] }>(`/api/ssh/hosts/${encodeURIComponent(host.alias)}`, {
        method: "DELETE"
      });
      setSshHosts(Array.isArray(payload.hosts) ? payload.hosts : []);
      await refreshSshHosts().catch(() => undefined);
      if (activeConnection) await stopSshConnection(activeConnection.connectionId);
    } catch (error) {
      setSshError(error instanceof Error ? error.message : String(error));
    } finally {
      setSshHostBusy((current) => current === host.alias ? "" : current);
    }
  };

  const copyRegisteredCommand = async () => {
    await navigator.clipboard?.writeText(registeredCommand).catch(() => undefined);
    setRegisteredCommandCopied(true);
    window.setTimeout(() => setRegisteredCommandCopied(false), 1200);
  };

  const refreshRuntimeSessions = async () => {
    const freshRuntimeSessions = await apiJson<{ sessions?: RuntimeSession[] }>("/api/sessions")
      .then((data) => normalizeRuntimeSessions(data.sessions));
    setRuntimeSessions(freshRuntimeSessions);
    setThreadOrderBySession((current) => mergeThreadOrderByRuntimeSession(current, freshRuntimeSessions));
    return freshRuntimeSessions;
  };

  const refreshProjects = async () => {
    const payload = await apiJson<ProjectsPayload>("/api/projects");
    setMachines(normalizeMachines(payload.machines));
    setProjects(normalizeProjects(payload.projects));
    return payload;
  };

  const refreshTasks = async () => {
    const payload = await apiJson<{ tasks?: LocalTask[] }>("/api/tasks");
    setTasks(normalizeTasks(payload.tasks));
  };

  const updateTaskDraftMachine = (machineId: string) => {
    const nextProject = projectList.find((project) => project.machineId === machineId);
    setTaskDraft((current) => ({
      ...current,
      machineId,
      projectPath: nextProject?.path ?? "",
      threadId: ""
    }));
  };

  const updateTaskDraftProject = (projectPath: string) => {
    setTaskDraft((current) => ({
      ...current,
      projectPath,
      threadId: ""
    }));
  };

  const focusTaskDraftProject = (project: Pick<ProjectSummary, "machineId" | "path">) => {
    setTaskDraft((current) => {
      if (current.machineId === project.machineId && current.projectPath === project.path) return current;
      return {
        ...current,
        machineId: project.machineId,
        projectPath: project.path,
        threadId: ""
      };
    });
  };

  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    primeTaskCompletionFeedback();
    const name = taskDraft.name.trim() || "Scheduled task";
    const schedule = taskDraft.schedule.trim();
    const machineId = taskDraft.machineId.trim();
    const projectPath = taskDraft.projectPath.trim();
    const input = taskDraft.input.trim();
    const threadId = taskDraft.threadId.trim();
    if (!machineId || !projectPath || !schedule || !input) {
      setTaskError("Missing task fields");
      return;
    }
    const project = projectList.find((item) => item.machineId === machineId && item.path === projectPath);
    setTaskBusyId("create");
    setTaskError("");
    try {
      const payload = await apiJson<{ task?: LocalTask }>("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          enabled: taskDraft.enabled,
          schedule,
          machineId,
          projectId: project?.projectId,
          projectPath,
          input,
          ...(threadId ? { threadId } : {})
        })
      });
      if (payload.task) {
        setTasks((current) => normalizeTasks([payload.task!, ...current.filter((task) => task.taskId !== payload.task!.taskId)]));
      } else {
        await refreshTasks();
      }
      setTaskDraft((current) => ({
        ...defaultTaskDraft(),
        machineId,
        projectPath,
        schedule: current.schedule,
        input: current.input
      }));
      setTaskFormOpen(false);
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : String(error));
    } finally {
      setTaskBusyId((current) => current === "create" ? "" : current);
    }
  };

  const patchTask = async (taskId: string, patch: Partial<Pick<LocalTask, "enabled" | "name" | "schedule" | "machineId" | "projectId" | "projectPath" | "threadId" | "input">>) => {
    setTaskBusyId(taskId);
    setTaskError("");
    try {
      const payload = await apiJson<{ task?: LocalTask }>(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (payload.task) {
        setTasks((current) => normalizeTasks(current.map((task) => task.taskId === taskId ? payload.task! : task)));
      } else {
        await refreshTasks();
      }
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : String(error));
    } finally {
      setTaskBusyId((current) => current === taskId ? "" : current);
    }
  };

  const deleteTask = async (taskId: string) => {
    setTaskBusyId(taskId);
    setTaskError("");
    try {
      await apiJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
      setTasks((current) => current.filter((task) => task.taskId !== taskId));
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : String(error));
    } finally {
      setTaskBusyId((current) => current === taskId ? "" : current);
    }
  };

  const runTaskNow = async (task: LocalTask) => {
    primeTaskCompletionFeedback();
    setTaskBusyId(task.taskId);
    setTaskError("");
    try {
      const payload = await apiJson<{ task?: LocalTask; threadId?: string; sessionId?: string }>(
        `/api/tasks/${encodeURIComponent(task.taskId)}/run`,
        { method: "POST" }
      );
      if (payload.task) {
        setTasks((current) => normalizeTasks(current.map((item) => item.taskId === task.taskId ? payload.task! : item)));
      }
      await refreshTasks().catch(() => undefined);
      const freshRuntimeSessions = await refreshRuntimeSessions().catch(() => runtimeSessions);
      if (payload.sessionId) {
        const session = freshRuntimeSessions.find((item) => item.sessionId === payload.sessionId);
        if (session) setActiveSessionId(session.sessionId);
      }
      if (payload.threadId) {
        await openThread(payload.threadId).catch(() => clearActiveThreadIfLatest(payload.threadId!));
      }
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : String(error));
      await refreshTasks().catch(() => undefined);
    } finally {
      setTaskBusyId((current) => current === task.taskId ? "" : current);
    }
  };

  const openThread = async (threadId: string) => {
    closedThreadIds.current.delete(threadId);
    latestRequestedThreadId.current = threadId;
    setActiveTabThreadId(threadId);

    const existingSession = sessions.find((session) => session.threadId === threadId);
    if (existingSession) {
      subscribeThread(threadId, existingSession.lastSeq);
      setActiveWorkspacePath(existingSession.workingDirectory);
      if (existingSession.runtime.sessionId) {
        setActiveTabThreadBySession((current) => ({ ...current, [existingSession.runtime.sessionId!]: threadId }));
      }
      return;
    }

    const existingOpen = openingThreads.current.get(threadId);
    if (existingOpen) return existingOpen;

    const open = (async () => {
      const thread = await apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`);
      const session: ChatSession = { ...thread, input: "", imageAttachments: [], textAttachments: [] };
      const sessionId = thread.runtime.sessionId;
      if (sessionId) {
        setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, thread.threadId));
      }
      setRuntimeSessions((current) => patchRuntimeSessionsThread(current, thread));
      setProjects((current) => patchProjectsThread(current, thread));
      notificationRecordsByThread.current.set(thread.threadId, threadRecordsForNotifications(thread.threadId, thread));
      setSessions((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextSession = existing
          ? { ...session, input: existing.input, imageAttachments: existing.imageAttachments, textAttachments: existing.textAttachments ?? [] }
          : session;
        return current.some((item) => item.threadId === thread.threadId)
          ? current.map((item) => item.threadId === thread.threadId ? nextSession : item)
          : [...current, nextSession];
      });
      if (latestRequestedThreadId.current !== thread.threadId) return;
      if (sessionId) {
        setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: thread.threadId }));
      }
      setActiveWorkspacePath(thread.workingDirectory);
      setActiveTabThreadId(thread.threadId);
      threadLastSeqs.current.set(
        thread.threadId,
        Math.max(threadLastSeqs.current.get(thread.threadId) ?? 0, thread.lastSeq)
      );
      subscribeThread(thread.threadId, thread.lastSeq);
    })();

    openingThreads.current.set(threadId, open);
    try {
      await open;
    } catch (error) {
      clearActiveThreadIfLatest(threadId);
      throw error;
    } finally {
      openingThreads.current.delete(threadId);
    }
  };

  const clearActiveThreadIfLatest = (threadId: string) => {
    if (latestRequestedThreadId.current === threadId) setActiveTabThreadId("");
  };

  const closeThread = async (threadId: string) => {
    if (closedThreadIds.current.has(threadId)) return;
    const threadIds = activeRuntimeSessionThreads.map((thread) => thread.threadId);
    const closingThread = activeRuntimeSessionThreads.find((thread) => thread.threadId === threadId)
      ?? sessions.find((session) => session.threadId === threadId);
    const sessionId = closingThread?.runtime.sessionId ?? activeRuntimeSession?.sessionId ?? "";
    const nextThreadId = activeTabThreadId === threadId
      ? adjacentThreadId(threadIds, threadId)
      : activeTabThreadId;

    closedThreadIds.current.add(threadId);
    removeThreadFromUi(threadId, sessionId, nextThreadId);
    try {
      await deleteThread(threadId);
      if (activeTabThreadId === threadId && nextThreadId) {
        await openThread(nextThreadId).catch(() => clearActiveThreadIfLatest(nextThreadId));
      }
    } catch (error) {
      closedThreadIds.current.delete(threadId);
      window.alert(error instanceof Error ? error.message : String(error));
      await Promise.all([
        refreshRuntimeSessions().catch(() => undefined),
        refreshProjects().catch(() => undefined)
      ]);
    }
  };

  function removeThreadFromUi(threadId: string, sessionId: string, nextThreadId: string) {
    openingThreads.current.delete(threadId);
    threadLastSeqs.current.delete(threadId);
    unsubscribeThread(threadId);
    setSessions((current) => {
      for (const session of current) {
        if (session.threadId !== threadId) continue;
        for (const image of session.imageAttachments) URL.revokeObjectURL(image.previewUrl);
      }
      return current.filter((session) => session.threadId !== threadId);
    });
    setRuntimeSessions((current) => removeRuntimeSessionsThread(current, threadId));
    setProjects((current) => removeProjectsThread(current, threadId));
    setThreadOrderBySession((current) => removeThreadOrder(current, threadId));
    setActiveTabThreadBySession((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(current)) {
        if (value === threadId) delete next[key];
      }
      if (sessionId && nextThreadId) next[sessionId] = nextThreadId;
      return next;
    });
    if (activeTabThreadId === threadId) {
      latestRequestedThreadId.current = nextThreadId;
      setActiveTabThreadId(nextThreadId);
    }
  }

  const deleteThread = async (threadId: string) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
    if (response.ok || response.status === 404) return;
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  };

  function subscribeThread(threadId: string, after: number) {
    const subscribedAfter = Math.max(after, threadLastSeqs.current.get(threadId) ?? 0);
    threadLastSeqs.current.set(threadId, subscribedAfter);
    const alreadySubscribed = realtimeThreadSubscriptions.current.has(threadId);
    realtimeThreadSubscriptions.current.add(threadId);
    if (alreadySubscribed) return;
    sendRealtime({
      type: "subscribe_thread",
      threadId,
      after: subscribedAfter
    });
  }

  function unsubscribeThread(threadId: string) {
    if (!realtimeThreadSubscriptions.current.delete(threadId)) return;
    sendRealtime({ type: "unsubscribe_thread", threadId });
  }

  function syncThreadSubscriptions(threadIds: string[]) {
    const desired = new Set(threadIds);
    for (const threadId of [...realtimeThreadSubscriptions.current]) {
      if (!desired.has(threadId)) unsubscribeThread(threadId);
    }
    for (const threadId of desired) {
      subscribeThread(threadId, threadLastSeqs.current.get(threadId) ?? 0);
    }
  }

  function applyThreadStreamEvent(payload: StreamEvent) {
    if (closedThreadIds.current.has(payload.thread.threadId)) return;
    notifyTaskCompletionsFromStreamEvent(payload);
    threadLastSeqs.current.set(
      payload.thread.threadId,
      Math.max(threadLastSeqs.current.get(payload.thread.threadId) ?? 0, payload.seq)
    );
    setSessions((current) => current.map((session) => {
      if (session.threadId !== payload.thread.threadId) return session;
      const records = payload.record ? mergeRecord(session.records, payload.record) : session.records;
      const jsonl = mergeThreadJsonl(session.jsonl, payload);
      return { ...session, ...payload.thread, records, jsonl };
    }));
    if (payload.thread.runtime.sessionId) {
      setThreadOrderBySession((current) => appendThreadOrder(current, payload.thread.runtime.sessionId!, payload.thread.threadId));
    }
    setRuntimeSessions((current) => patchRuntimeSessionsThread(current, payload.thread));
    setProjects((current) => patchProjectsThread(current, payload.thread));
  }

  function notifyTaskCompletionsFromStreamEvent(event: StreamEvent) {
    const threadId = event.thread.threadId;
    const incomingRecords = streamEventRecords(event);
    if (!incomingRecords.length) return;

    const previousRecords = notificationRecordsByThread.current.get(threadId) ?? [];
    const nextRecords = mergeNotificationRecords(previousRecords, event, incomingRecords);
    notificationRecordsByThread.current.set(threadId, nextRecords);
    if (event.kind !== "record" && event.kind !== "jsonl_append") return;

    for (const record of incomingRecords) {
      if (!isTaskCompleteRecord(record)) continue;
      const key = taskCompletionNotificationKey(threadId, record);
      if (notifiedTaskCompletions.current.has(key)) continue;
      notifiedTaskCompletions.current.add(key);
      dispatchTaskCompleteNotification(taskCompleteNotification(event.thread, record, nextRecords));
    }
  }

  function dispatchTaskCompleteNotification(notification: TaskCompleteNotification) {
    playTaskCompletionSound(notificationAudioContext);
    if (isVscodeSurface) {
      window.parent?.postMessage({
        type: "codexhub.taskCompleteNotification",
        notification
      }, "*");
      return;
    }

    const NotificationApi = window.Notification;
    if (!NotificationApi || NotificationApi.permission !== "granted") return;
    const browserNotification = new NotificationApi(notification.title, {
      body: notification.body,
      tag: `codexhub-task-complete:${notification.threadId}`
    });
    browserNotification.onclick = () => {
      window.focus();
      browserNotification.close();
    };
  }

  const forkMessage = async (threadId: string, messageId: string) => {
    try {
      const thread = await apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId })
      });
      const sessionId = thread.runtime.sessionId ?? activeRuntimeSession?.sessionId;
      if (sessionId) {
        setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: thread.threadId }));
        setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, thread.threadId));
      }
      await openThread(thread.threadId);
    } catch (error) {
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          records: [...item.records, errorRecord("fork failed", error)]
        }
        : item));
    }
  };

  const rollbackMessage = async (threadId: string, messageId: string) => {
    try {
      const thread = await apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId })
      });
      const session: ChatSession = { ...thread, input: "", imageAttachments: [], textAttachments: [] };
      setSessions((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextSession = existing
          ? { ...session, input: existing.input, imageAttachments: existing.imageAttachments, textAttachments: existing.textAttachments ?? [] }
          : session;
        return current.some((item) => item.threadId === thread.threadId)
          ? current.map((item) => item.threadId === thread.threadId ? nextSession : item)
          : [...current, nextSession];
      });
      setActiveWorkspacePath(thread.workingDirectory);
      setActiveTabThreadId(thread.threadId);
      subscribeThread(thread.threadId, thread.lastSeq);
    } catch (error) {
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          records: [...item.records, errorRecord("rollback failed", error)]
        }
        : item));
    }
  };

  const send = async (threadId: string) => {
    primeTaskCompletionFeedback();
    const session = sessions.find((item) => item.threadId === threadId);
    if (!session) return;
    const typedText = session.input.trim();
    const textAttachments = session.textAttachments;
    const text = composeUserInputText(typedText, textAttachments);
    const imageAttachments = session.imageAttachments;
    if (!text && !imageAttachments.length) return;
    if (!textAttachments.length && !imageAttachments.length && isModelCommand(typedText)) {
      resetComposerHistory(threadId);
      setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "" } : item));
      setRuntimeDialogOpen(true);
      return;
    }
    resetComposerHistory(threadId);
    setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "", imageAttachments: [], textAttachments: [] } : item));
    let encodedImages: Array<{ url: string }>;
    try {
      encodedImages = await Promise.all(imageAttachments.map(async (image) => ({ url: await fileToDataUrl(image.file) })));
      for (const image of imageAttachments) URL.revokeObjectURL(image.previewUrl);
    } catch (error) {
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          input: typedText,
          imageAttachments,
          textAttachments,
          records: [...item.records, errorRecord("image encode failed", error)]
        }
        : item));
      return;
    }
    const input = encodedImages.length
      ? [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...encodedImages.map((image) => ({ type: "image" as const, url: image.url }))
      ]
      : text;
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input,
        source: "web",
        options: selectedThreadOptions(selectedModel, selectedReasoning, composerMode)
      })
    });
    if (!response.ok) {
      const text = await response.text();
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("error", text)] }
        : item));
    }
  };

  function primeTaskCompletionFeedback() {
    primeTaskNotificationPermission();
    primeTaskCompletionSound(notificationAudioContext);
  }

  const stopTurn = async (threadId: string) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/stop`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("stop failed", text)] }
        : item));
    }
  };

  const updateThreadGoal = async (
    threadId: string,
    goal: { objective?: string; status?: string; tokenBudget?: number | null },
    options: { dialog?: boolean } = {}
  ) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(goal)
    });
    if (response.ok) return true;
    const text = await response.text();
    if (options.dialog) {
      setGoalDialog((current) => current && current.threadId === threadId
        ? { ...current, saving: false, error: text || "保存失败" }
        : current);
    } else {
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("goal update failed", text)] }
        : item));
    }
    return false;
  };

  const clearThreadGoal = async (threadId: string) => {
    const clearedRecord = threadGoalClearedRecord(threadId);
    setSessions((current) => current.map((item) => item.threadId === threadId
      ? { ...item, records: mergeRecord(item.records, clearedRecord) }
      : item));
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/goal`, { method: "DELETE" });
    if (response.ok) return;
    const text = await response.text();
    setSessions((current) => current.map((item) => item.threadId === threadId
      ? { ...item, records: [...item.records, errorRecord("goal clear failed", text)] }
      : item));
  };

  const saveGoalDialog = async () => {
    if (!goalDialog) return;
    const objective = goalDialog.objective.trim();
    if (!objective) {
      setGoalDialog((current) => current ? { ...current, error: "目标不能为空" } : current);
      return;
    }
    setGoalDialog((current) => current ? { ...current, saving: true, error: "" } : current);
    const saved = await updateThreadGoal(goalDialog.threadId, { objective, status: "active" }, { dialog: true });
    if (saved) setGoalDialog(null);
  };

  const updateSessionInput = (threadId: string, input: string) => {
    setSessions((current) => current.map((session) => session.threadId === threadId ? { ...session, input } : session));
  };

  const resetComposerHistory = (threadId: string) => {
    if (composerHistoryRef.current?.threadId === threadId) composerHistoryRef.current = null;
  };

  const setComposerHistoryInput = (threadId: string, textarea: HTMLTextAreaElement, input: string) => {
    updateSessionInput(threadId, input);
    window.requestAnimationFrame(() => {
      resizeComposerTextarea(textarea);
      textarea.focus();
      textarea.setSelectionRange(input.length, input.length);
    });
  };

  const navigateComposerHistory = (
    threadId: string,
    textarea: HTMLTextAreaElement,
    history: string[],
    direction: "previous" | "next"
  ) => {
    const current = composerHistoryRef.current?.threadId === threadId
      ? composerHistoryRef.current
      : { threadId, draft: textarea.value, offsetFromEnd: 0 };
    const offsetFromEnd = Math.min(current.offsetFromEnd, history.length);
    const nextOffset = direction === "previous"
      ? Math.min(history.length, offsetFromEnd + 1)
      : Math.max(0, offsetFromEnd - 1);
    if (nextOffset === offsetFromEnd) return;

    const input = nextOffset === 0
      ? current.draft
      : history[history.length - nextOffset] ?? current.draft;
    composerHistoryRef.current = { ...current, offsetFromEnd: nextOffset };
    setComposerHistoryInput(threadId, textarea, input);
  };

  const handleComposerKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    threadId: string,
    history: string[]
  ) => {
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown")
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
      && !event.nativeEvent.isComposing
      && event.currentTarget.selectionStart === event.currentTarget.selectionEnd
    ) {
      const textarea = event.currentTarget;
      if (event.key === "ArrowUp" && history.length && composerCursorOnFirstLine(textarea)) {
        event.preventDefault();
        navigateComposerHistory(threadId, textarea, history, "previous");
        return;
      }
      if (
        event.key === "ArrowDown"
        && composerHistoryRef.current?.threadId === threadId
        && composerHistoryRef.current.offsetFromEnd > 0
        && composerCursorOnLastLine(textarea)
      ) {
        event.preventDefault();
        navigateComposerHistory(threadId, textarea, history, "next");
        return;
      }
    }

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (activeCanSend) void send(threadId);
  };

  const addSessionTextAttachment = (threadId: string, text: string) => {
    const normalizedText = normalizeSelectedText(text);
    if (!normalizedText) return;
    setSessions((current) => current.map((session) => session.threadId === threadId
      ? { ...session, textAttachments: [...session.textAttachments, { id: browserId(), text: normalizedText }] }
      : session));
  };

  const addSessionImageFiles = (threadId: string, files: File[]) => {
    if (!files.length) return;
    const images = files
      .filter((file) => file.type.startsWith("image/"))
      .map((file) => ({
        id: browserId(),
        file,
        name: file.name,
        previewUrl: URL.createObjectURL(file)
      }));
    if (!images.length) return;
    setSessions((current) => current.map((session) => session.threadId === threadId
      ? { ...session, imageAttachments: [...session.imageAttachments, ...images] }
      : session));
  };

  const addSessionImages = (threadId: string, files: FileList | null) => {
    if (!files?.length) return;
    addSessionImageFiles(threadId, [...files]);
  };

  const pasteSessionImages = (threadId: string, clipboardData: DataTransfer) => {
    const images = clipboardImageFiles(clipboardData);
    if (!images.length) return false;
    addSessionImageFiles(threadId, images);
    return true;
  };

  const updateMessageRenderMode = (messageId: string, mode: MessageRenderMode) => {
    setMessageRenderModes((current) => current[messageId] === mode ? current : { ...current, [messageId]: mode });
  };

  const removeSessionImage = (threadId: string, imageId: string) => {
    setSessions((current) => current.map((session) => {
      if (session.threadId !== threadId) return session;
      const image = session.imageAttachments.find((item) => item.id === imageId);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return { ...session, imageAttachments: session.imageAttachments.filter((item) => item.id !== imageId) };
    }));
  };

  const removeSessionTextAttachment = (threadId: string, textId: string) => {
    setSessions((current) => current.map((session) => session.threadId === threadId
      ? { ...session, textAttachments: session.textAttachments.filter((item) => item.id !== textId) }
      : session));
  };

  const openMessageContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    threadId: string,
    message: WebRecordView,
    canInspect: boolean
  ) => {
    const selectedText = selectedTextWithin(event.currentTarget);
    if (!canInspect && !selectedText) return;
    event.preventDefault();
    event.stopPropagation();
    setComposerMenuOpen(false);
    setRuntimeMenuOpen(false);
    setMessageContextMenu({
      ...contextMenuPosition(event.clientX, event.clientY),
      threadId,
      message,
      selectedText,
      canInspect
    });
  };

  const inspectContextMessage = () => {
    if (!messageContextMenu?.canInspect) return;
    setInspectMessage(messageContextMenu.message);
    setMessageContextMenu(null);
  };

  const addContextSelectionToConversation = () => {
    if (!messageContextMenu?.selectedText) return;
    addSessionTextAttachment(messageContextMenu.threadId, messageContextMenu.selectedText);
    setMessageContextMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  const copyContextSelection = async () => {
    if (!messageContextMenu?.selectedText) return;
    await writeTextToClipboard(messageContextMenu.selectedText);
    setMessageContextMenu(null);
  };

  const selectRuntimeSession = async (session: RuntimeSession) => {
    setActiveSessionId(session.sessionId);
    setActiveWorkspacePath(session.workingDirectory);
    const project = projectList.find((item) => item.runtime?.sessionId === session.sessionId)
      ?? projectList.find((item) => item.machineId === session.machineId && item.path === session.workingDirectory);
    if (project) {
      setSelectedProjectKey(projectKeyForProject(project));
      focusTaskDraftProject(project);
    }
    const activeTabThreadIdForRuntimeSession = activeTabThreadBySession[session.sessionId];
    const sessionThreadIds = new Set(session.threads?.map((thread) => thread.threadId) ?? []);
    const targetThreadId = activeTabThreadIdForRuntimeSession && sessionThreadIds.has(activeTabThreadIdForRuntimeSession)
      ? activeTabThreadIdForRuntimeSession
      : preferredThreadIdForRuntimeSession(session, project);
    if (targetThreadId) {
      await openThread(targetThreadId).catch(() => clearActiveThreadIfLatest(targetThreadId));
    } else {
      setActiveTabThreadId("");
    }
  };

  const selectProject = async (project: ProjectSummary) => {
    setSelectedProjectKey(projectKeyForProject(project));
    focusTaskDraftProject(project);
    setTaskError("");
    setProjectOpenError("");
    setActiveWorkspacePath(project.path);
    if (project.runtime?.online) {
      await selectRuntimeSession(project.runtime);
      return;
    }
    setActiveSessionId("");
    setActiveTabThreadId("");
    latestRequestedThreadId.current = "";
    await openProject(project.path, project.machineId);
  };

  const loadProjectPickerDirectory = async (machineId: string, targetPath?: string) => {
    const trimmedPath = targetPath?.trim();
    setProjectPicker((current) => current && current.machineId === machineId ? {
      ...current,
      path: trimmedPath ?? current.path,
      loading: true,
      error: ""
    } : current);
    try {
      const query = trimmedPath ? `?path=${encodeURIComponent(trimmedPath)}` : "";
      const listing = await apiJson<MachineDirectoryListing>(
        `/api/machines/${encodeURIComponent(machineId)}/directories${query}`
      );
      setProjectPicker((current) => current && current.machineId === machineId ? {
        ...current,
        path: listing.cwd,
        parent: listing.parent,
        home: listing.home,
        entries: listing.entries,
        loading: false,
        error: ""
      } : current);
    } catch (error) {
      setProjectPicker((current) => current && current.machineId === machineId ? {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const openProjectPicker = (machine: ProjectMachineGroup) => {
    const summary = machines.find((item) => item.machineId === machine.key);
    const initialPath = summary?.cwd ?? machine.projects[0]?.path ?? "";
    setProjectPicker({
      machineId: machine.key,
      path: initialPath,
      entries: [],
      loading: true,
      error: ""
    });
    void loadProjectPickerDirectory(machine.key, initialPath);
  };

  const changeProjectPickerMachine = (machineId: string) => {
    const summary = machines.find((machine) => machine.machineId === machineId);
    const initialPath = summary?.cwd ?? "";
    setProjectPicker({
      machineId,
      path: initialPath,
      entries: [],
      loading: true,
      error: ""
    });
    void loadProjectPickerDirectory(machineId, initialPath);
  };

  const submitProjectPickerPath = (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectPicker) return;
    void loadProjectPickerDirectory(projectPicker.machineId, projectPicker.path);
  };

  const confirmProjectPicker = async () => {
    if (!projectPicker) return;
    const opened = await openProject(projectPicker.path, projectPicker.machineId);
    if (opened) setProjectPicker(null);
  };

  const loadThreadPickerCandidates = async (sessionId: string) => {
    setThreadPicker((current) => current && current.sessionId === sessionId ? {
      ...current,
      loading: true,
      error: ""
    } : current);
    try {
      const payload = await apiJson<{ threads?: CodexThreadCandidate[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/thread-candidates?limit=20`
      );
      setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        loading: false,
        candidates: Array.isArray(payload.threads) ? payload.threads : [],
        error: ""
      } : current);
    } catch (error) {
      setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const openThreadPicker = (session: RuntimeSession) => {
    setActiveSessionId(session.sessionId);
    setActiveWorkspacePath(session.workingDirectory);
    setThreadPicker({
      sessionId: session.sessionId,
      loading: true,
      error: "",
      candidates: [],
      acting: null
    });
    void loadThreadPickerCandidates(session.sessionId);
  };

  const activateRuntimeSessionThread = async (sessionId: string, threadId: string) => {
    closedThreadIds.current.delete(threadId);
    const session = runtimeSessions.find((item) => item.sessionId === sessionId);
    if (session) {
      setActiveSessionId(session.sessionId);
      setActiveWorkspacePath(session.workingDirectory);
    }
    setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: threadId }));
    setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, threadId));
    if (sessions.some((session) => session.threadId === threadId)) {
      latestRequestedThreadId.current = threadId;
      subscribeThread(threadId, threadLastSeqs.current.get(threadId) ?? 0);
      setActiveTabThreadId(threadId);
      return;
    }
    await openThread(threadId);
  };

  const threadIsOpenForSession = (sessionId: string, threadId: string) => {
    const session = runtimeSessions.find((item) => item.sessionId === sessionId);
    return Boolean(
      session?.threads?.some((thread) => thread.threadId === threadId)
      || (threadOrderBySession[sessionId] ?? []).includes(threadId)
      || sessions.some((session) => session.threadId === threadId)
    );
  };

  const createRuntimeSessionThread = async () => {
    if (!threadPicker) return;
    const sessionId = threadPicker.sessionId;
    setThreadPicker((current) => current && current.sessionId === sessionId ? { ...current, acting: "new", error: "" } : current);
    try {
      const thread = await apiJson<ThreadDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "new" })
      });
      setThreadPicker(null);
      await activateRuntimeSessionThread(sessionId, thread.threadId);
    } catch (error) {
      setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        acting: null,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const chooseThreadCandidate = async (candidate: CodexThreadCandidate) => {
    if (!threadPicker) return;
    const sessionId = threadPicker.sessionId;
    if (threadIsOpenForSession(sessionId, candidate.threadId)) {
      setThreadPicker(null);
      await activateRuntimeSessionThread(sessionId, candidate.threadId);
      return;
    }
    setThreadPicker((current) => current && current.sessionId === sessionId ? {
      ...current,
      acting: candidate.threadId,
      error: ""
    } : current);
    try {
      const thread = await apiJson<ThreadDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", threadId: candidate.threadId })
      });
      setThreadPicker(null);
      await activateRuntimeSessionThread(sessionId, thread.threadId);
    } catch (error) {
      setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        acting: null,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const openProject = async (projectPath: string, machineId?: string): Promise<boolean> => {
    const trimmedPath = projectPath.trim();
    if (!trimmedPath) return false;
    const key = `${machineId ?? ""}:${trimmedPath}`;
    if (machineId) {
      setSelectedProjectKey(projectKeyFor(machineId, trimmedPath));
      focusTaskDraftProject({ machineId, path: trimmedPath });
    }
    setProjectOpenError("");
    setActiveWorkspacePath(trimmedPath);
    setActiveSessionId("");
    setActiveTabThreadId("");
    latestRequestedThreadId.current = "";
    setProjectPicker((current) => current && current.machineId === machineId ? { ...current, error: "" } : current);
    setOpeningProjectKey(key);
    try {
      const payload = await apiJson<ProjectsPayload & {
        result?: { sessionId: string; threadId: string; cwd: string };
      }>("/api/projects/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: trimmedPath, machineId: machineId || undefined, reuse: true })
      });
      setMachines(normalizeMachines(payload.machines));
      const freshProjects = normalizeProjects(payload.projects);
      setProjects(freshProjects);
      setProjectOpenError("");
      setActiveWorkspacePath(payload.result?.cwd ?? trimmedPath);
      const freshRuntimeSessions = await apiJson<{ sessions?: RuntimeSession[] }>("/api/sessions")
        .then((data) => normalizeRuntimeSessions(data.sessions))
        .catch(() => runtimeSessions);
      setRuntimeSessions(freshRuntimeSessions);
      setThreadOrderBySession((current) => mergeThreadOrderByRuntimeSession(current, freshRuntimeSessions));
      const sessionId = payload.result?.sessionId;
      const project = freshProjects.find((item) => item.path === (payload.result?.cwd ?? trimmedPath));
      const session = sessionId
        ? project?.runtime?.sessionId === sessionId
          ? project.runtime
          : freshRuntimeSessions.find((item) => item.sessionId === sessionId)
        : undefined;
      if (session && payload.result?.threadId) await activateRuntimeSessionThread(session.sessionId, payload.result.threadId);
      else if (session) await selectRuntimeSession(session);
      else if (payload.result?.threadId) await openThread(payload.result.threadId).catch(() => clearActiveThreadIfLatest(payload.result!.threadId));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProjectOpenError(message);
      setProjectPicker((current) => current && current.machineId === machineId ? { ...current, error: message } : current);
      return false;
    } finally {
      setOpeningProjectKey((current) => current === key ? "" : current);
    }
  };

  const deleteProject = async (project: ProjectSummary) => {
    if (!window.confirm(`Remove ${project.name} from CodexHub projects?\n\nThis does not delete files. Active runtime sessions for this project will be stopped.`)) return;
    setDeletingProjectId(project.projectId);
    try {
      const payload = await apiJson<ProjectsPayload>(`/api/projects/${encodeURIComponent(project.projectId)}`, {
        method: "DELETE"
      });
      setMachines(normalizeMachines(payload.machines));
      setProjects(normalizeProjects(payload.projects));
      if (selectedProjectKey === projectKeyForProject(project)) setSelectedProjectKey("");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingProjectId((current) => current === project.projectId ? "" : current);
    }
  };

  const toggleProjectMachineGroup = (machineKey: string) => {
    setCollapsedProjectMachineKeys((current) =>
      current.includes(machineKey)
        ? current.filter((key) => key !== machineKey)
        : [...current, machineKey]
    );
  };

  const switchRuntimeSessionThread = async (threadId: string) => {
    if (!activeRuntimeSession || threadId === activeTabThreadId) return;
    setActiveTabThreadBySession((current) => ({ ...current, [activeRuntimeSession.sessionId]: threadId }));
    await openThread(threadId).catch(() => clearActiveThreadIfLatest(threadId));
  };

  const projectPickerMachine = projectPicker
    ? machines.find((machine) => machine.machineId === projectPicker.machineId)
    : undefined;
  const projectPickerOpening = projectPicker
    ? openingProjectKey === `${projectPicker.machineId}:${projectPicker.path.trim()}`
    : false;
  const threadPickerRuntimeSession = threadPicker
    ? runtimeSessions.find((session) => session.sessionId === threadPicker.sessionId)
    : undefined;
  const threadPickerOpenThreadIds = new Set<string>([
    ...(threadPickerRuntimeSession?.threads?.map((thread) => thread.threadId) ?? []),
    ...(threadPicker ? threadOrderBySession[threadPicker.sessionId] ?? [] : []),
    ...sessions.map((session) => session.threadId)
  ]);
  const onlineProjectGroups = projectGroups.filter((machine) => machine.online);
  const offlineProjectGroups = projectGroups.filter((machine) => !machine.online);
  const projectAddMachine = onlineProjectGroups.find((machine) => machine.projectLauncher);
  const visibleTasks = selectedProject
    ? tasks.filter((task) => taskBelongsToProject(task, selectedProject))
    : tasks;
  const taskPanelContextLabel = selectedProject?.name ?? "All projects";
  const taskPanelContextTitle = selectedProject ? `${selectedProject.name}\n${selectedProject.path}` : "All projects";
  const taskFormProjectLocked = Boolean(selectedProject);
  const taskMachineOptions = uniqueMachines(machines).filter(machineProjectLauncher);
  const taskProjectOptions = projectList.filter((project) => !taskDraft.machineId || project.machineId === taskDraft.machineId);
  const selectedTaskProject = taskProjectOptions.find((project) => project.path === taskDraft.projectPath);
  const taskThreadOptions = taskThreadOptionsFor(selectedTaskProject);
  const workspaceRuntime = selectedProject?.runtime ?? activeRuntimeSession ?? null;
  const workspacePath = selectedProject?.path ?? workspaceRuntime?.workingDirectory ?? activeWorkspacePath;
  const workspaceMachineOnline = selectedProject
    ? selectedProject.machineOnline
    : Boolean(workspaceRuntime ? machines.find((machine) => machine.machineId === workspaceRuntime.machineId)?.online : false);
  const showWorkspaceMachineOffline = Boolean(selectedProject && !workspaceMachineOnline && !workspaceRuntime?.online);
  const canCreateTask = Boolean(
    taskDraft.machineId.trim()
    && taskDraft.projectPath.trim()
    && taskDraft.schedule.trim()
    && taskDraft.input.trim()
  );
  const renderProjectMachineGroup = (machine: ProjectMachineGroup) => {
    const collapsed = collapsedProjectMachineKeys.includes(machine.key);
    return (
      <section className="projectMachineGroup" key={machine.key}>
        <button
          type="button"
          className={`projectMachineHeader ${machine.online ? "online" : "offline"}`}
          onClick={() => toggleProjectMachineGroup(machine.key)}
          aria-expanded={!collapsed}
        >
          <span className={`projectOfflineArrow ${collapsed ? "collapsed" : ""}`}>{">"}</span>
          <span title={machine.label}>{machine.label}</span>
          <strong>{machine.statusLabel}</strong>
        </button>
        {!collapsed ? (
          <div className="projectMachineRows">
            {machine.projects.length === 0 ? (
              <div className="projectEmptyRow">No projects</div>
            ) : machine.projects.map((project) => {
              const projectKey = projectKeyForProject(project);
              const active = projectKey === activeProjectKey;
              const statusLabel = projectStatusLabel(project);
              const runtimeActive = Boolean(project.runtime?.online);
              const projectReachable = runtimeActive || project.machineOnline;
              const deleting = deletingProjectId === project.projectId;
              const openDisabled = openingProjectKey === projectKey || deleting;
              return (
                <div
                  key={project.projectId}
                  className={`projectRow ${active ? "active" : ""} ${runtimeActive ? "online" : projectReachable ? "ready" : "offline"}`}
                >
                  <div className="projectRowTop">
                    <button
                      type="button"
                      className="projectOpenButton projectOpenNameButton"
                      onClick={() => void selectProject(project)}
                      disabled={openDisabled}
                    >
                      <span title={project.name}>{project.name}</span>
                    </button>
                    <div className="projectRowActions">
                      <strong>{openingProjectKey === projectKey ? "opening" : statusLabel}</strong>
                      <button
                        type="button"
                        className="projectDeleteButton"
                        onClick={() => void deleteProject(project)}
                        disabled={deleting}
                        aria-label={`Remove ${project.name}`}
                        title={`Remove ${project.name} from CodexHub`}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="projectOpenButton projectOpenPathButton"
                    onClick={() => void selectProject(project)}
                    disabled={openDisabled}
                  >
                    <code title={project.path}>{project.path}</code>
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <main className={`app ${sidebarCollapsed ? "sidebarCollapsed" : ""} ${isVscodeSurface ? "vscodeSurface" : ""}`}>
      {!isVscodeSurface && !sidebarCollapsed ? (
        <button
          type="button"
          className="sidebarScrim"
          onClick={() => setSidebarCollapsed(true)}
          aria-label="Hide menu"
        />
      ) : null}
      {!isVscodeSurface ? <aside className="sidebar">
        <div className="brand">
          <div>
            <h1>Codex Hub</h1>
            <p>Local machine workbench</p>
          </div>
        </div>

        <section className="connectionPanel">
          <div className="connectionPanelHeader">
            <h2>Connections</h2>
            <span>{onlineMachines.length} online</span>
          </div>
          <div className="connectionTabs" role="tablist" aria-label="Connection type">
            <button
              type="button"
              className={connectionMode === "local" ? "active" : ""}
              onClick={() => setConnectionMode("local")}
            >
              This Computer
            </button>
            <button
              type="button"
              className={connectionMode === "ssh" ? "active" : ""}
              onClick={() => setConnectionMode("ssh")}
            >
              SSH
            </button>
            <button
              type="button"
              className={connectionMode === "registered" ? "active" : ""}
              onClick={() => setConnectionMode("registered")}
            >
              Registered
            </button>
          </div>
          {connectionMode === "local" ? (
            <div className="connectionList">
              {localMachines.length === 0 ? (
                <div className="connectionEmpty">No machines</div>
              ) : localMachines.map((machine) => (
                <div className={`connectionRow ${machine.online ? "online" : "offline"}`} key={machine.machineId}>
                  <span title={machine.name ?? machine.hostname}>{machine.name ?? machine.hostname}</span>
                  <strong>{machine.type}</strong>
                  <code>{machine.online ? "online" : "offline"}</code>
                </div>
              ))}
            </div>
          ) : connectionMode === "ssh" ? (
            <div className="connectionList">
              <form className="sshManualForm" onSubmit={(event) => void addSshHost(event)}>
                <input
                  value={sshHostDraft}
                  onChange={(event) => setSshHostDraft(event.target.value)}
                  list="sshConfigHostOptions"
                  placeholder="SSH config alias"
                  spellCheck={false}
                />
                <datalist id="sshConfigHostOptions">
                  {sshConfigHostOptions.map((host) => (
                    <option key={host.alias} value={host.alias}>
                      {sshHostMeta(host)}
                    </option>
                  ))}
                </datalist>
                <button
                  type="submit"
                  disabled={
                    !sshHostDraft.trim()
                    || sshHostBusy === sshHostDraft.trim()
                    || sshHosts.some((host) => host.alias === sshHostDraft.trim())
                    || !sshConfigHosts.some((host) => host.alias === sshHostDraft.trim())
                  }
                >
                  {sshHostBusy === sshHostDraft.trim() ? "..." : "Add"}
                </button>
              </form>
              {sshHosts.length === 0 ? (
                <div className="connectionEmpty">No SSH hosts</div>
              ) : sshHosts.map((host) => {
                const activeConnection = activeSshConnectionForHost(sshConnections, host.alias);
                const latestConnection = latestSshConnectionForHost(sshConnections, host.alias);
                const connecting = sshConnectingHost === host.alias;
                const statusLabel = sshConnectionStatusLabel(latestConnection, connecting, host.configured !== false);
                const statusClass = sshConnectionStatusClass(statusLabel);
                const connectionDetail = sshConnectionDetail(host, latestConnection);
                return (
                  <div className={`connectionRow ssh ${statusClass}`} key={host.alias} title={sshConnectionTitle(host, latestConnection)}>
                    <button
                      type="button"
                      className="connectionHostButton"
                      title={host.configured === false ? "SSH config entry missing" : host.hostName ?? host.alias}
                      onClick={() => void connectSshHost(host.alias, host.alias)}
                      disabled={host.configured === false || Boolean(activeConnection) || connecting || sshHostBusy === host.alias}
                    >
                      <span>{host.alias}</span>
                      <code title={connectionDetail}>{connectionDetail}</code>
                    </button>
                    <strong>{statusLabel}</strong>
                    <button
                      type="button"
                      className="connectionDeleteButton"
                      onClick={() => void removeSshHost(host, activeConnection)}
                      disabled={sshHostBusy === host.alias}
                      aria-label={`Remove ${host.alias}`}
                      title={`Remove ${host.alias} from CodexHub`}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              {sshError ? <div className="projectOpenError">{sshError}</div> : null}
            </div>
          ) : (
            <div className="connectionList">
              <div className="registeredCommand">
                <code title={registeredCommand}>{registeredCommand}</code>
                <button type="button" onClick={() => void copyRegisteredCommand()}>
                  {registeredCommandCopied ? "Copied" : "Copy"}
                </button>
              </div>
              {registeredMachines.length === 0 ? (
                <div className="connectionEmpty">No registered machines</div>
              ) : registeredMachines.map((machine) => (
                <div className={`connectionRow ${machine.online ? "online" : "offline"}`} key={machine.machineId}>
                  <span title={machine.name ?? machine.hostname}>{machine.name ?? machine.hostname}</span>
                  <strong>{machine.online ? "online" : "offline"}</strong>
                  <code title={machine.machineId}>{machine.machineId}</code>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="projectPanel">
          <div className="projectPanelHeader">
            <h2>Projects</h2>
            <span>{projectGroups.length} machines</span>
          </div>
          <button
            type="button"
            className="projectAddButton"
            onClick={() => projectAddMachine ? openProjectPicker(projectAddMachine) : undefined}
            disabled={!projectAddMachine}
            title={projectAddMachine ? "Add a project" : "No online machines"}
          >
            Add Project
          </button>
          {projectGroups.length === 0 ? (
            <div className="projectEmptyRow">No machines</div>
          ) : (
            <div className="projectList">
              {onlineProjectGroups.map(renderProjectMachineGroup)}
              {offlineProjectGroups.length ? (
                <section className="projectOfflineSection">
                  <button
                    type="button"
                    className="projectOfflineHeader"
                    onClick={() => setOfflineProjectsCollapsed((collapsed) => !collapsed)}
                    aria-expanded={!offlineProjectsCollapsed}
                  >
                    <span className={`projectOfflineArrow ${offlineProjectsCollapsed ? "collapsed" : ""}`}>{">"}</span>
                    <span>Offline</span>
                    <strong>{offlineProjectGroups.length}</strong>
                  </button>
                  {!offlineProjectsCollapsed ? (
                    <div className="projectOfflineMachines">
                      {offlineProjectGroups.map(renderProjectMachineGroup)}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          )}
          {projectOpenError ? <div className="projectOpenError">{projectOpenError}</div> : null}
        </section>

        <section className="taskPanel">
          <div className="taskPanelHeader">
            <div className="taskPanelTitle">
              <h2>Tasks</h2>
              <span title={taskPanelContextTitle}>{taskPanelContextLabel}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (selectedProject) focusTaskDraftProject(selectedProject);
                setTaskFormOpen((open) => !open);
              }}
            >
              {taskFormOpen ? "Close" : "New"}
            </button>
          </div>
          {visibleTasks.length === 0 ? (
            <div className="taskEmpty">{selectedProject ? "No tasks for this project" : "No tasks"}</div>
          ) : (
            <div className="taskList">
              {visibleTasks.map((task) => {
                const busy = taskBusyId === task.taskId;
                const taskRunError = task.lastError ? `Last run failed: ${task.lastError}` : "";
                return (
                  <div className={`taskRow ${task.enabled ? "enabled" : "paused"}`} key={task.taskId}>
                    <div className="taskRowHeader">
                      <span title={task.name}>{task.name}</span>
                      <strong className={`taskStatus ${taskStatusClass(task)}`}>
                        {taskStatusLabel(task)}
                      </strong>
                    </div>
                    <code title={task.schedule}>{task.schedule}</code>
                    <em title={taskTargetTitle(task, projectList, machines)}>{taskTargetLabel(task, projectList, machines)}</em>
                    {taskRunError ? <small className="taskLastError" title={taskRunError}>{taskRunError}</small> : null}
                    <div className="taskActions">
                      <button
                        type="button"
                        className="taskRunButton"
                        onClick={() => void runTaskNow(task)}
                        disabled={busy}
                      >
                        {busy ? "..." : "Run"}
                      </button>
                      <Switch
                        size="small"
                        checked={task.enabled}
                        onChange={(checked) => void patchTask(task.taskId, { enabled: checked })}
                        disabled={busy}
                        aria-label={task.enabled ? "Disable task" : "Enable task"}
                      />
                      <button
                        type="button"
                        className="taskDeleteButton"
                        onClick={() => void deleteTask(task.taskId)}
                        disabled={busy}
                        aria-label={`Delete ${task.name}`}
                      >
                        x
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {taskFormOpen ? (
            <form className="taskForm" onSubmit={createTask}>
              <label className="taskField">
                <span>Name</span>
                <input
                  value={taskDraft.name}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="daily-summary"
                />
              </label>
              <label className="taskField">
                <span>Machine</span>
                <select
                  value={taskDraft.machineId}
                  onChange={(event) => updateTaskDraftMachine(event.target.value)}
                  disabled={taskFormProjectLocked || !taskMachineOptions.length}
                >
                  <option value="">Machine</option>
                  {taskMachineOptions.map((machine) => (
                    <option value={machine.machineId} key={machine.machineId}>
                      {machine.name ?? machine.hostname}
                    </option>
                  ))}
                </select>
              </label>
              <label className="taskField">
                <span>Project</span>
                <select
                  value={taskDraft.projectPath}
                  onChange={(event) => updateTaskDraftProject(event.target.value)}
                  disabled={taskFormProjectLocked || !taskProjectOptions.length}
                >
                  <option value="">Project</option>
                  {taskProjectOptions.map((project) => (
                    <option value={project.path} key={`${project.machineId}:${project.path}`}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="taskField">
                <span>Thread</span>
                <select
                  value={taskDraft.threadId}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, threadId: event.target.value }))}
                  disabled={!selectedTaskProject}
                >
                  <option value="">Current thread</option>
                  {taskThreadOptions.map((thread) => (
                    <option value={thread.threadId} key={thread.threadId}>
                      {threadDisplayTitle(thread)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="taskField">
                <span>Schedule</span>
                <input
                  value={taskDraft.schedule}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, schedule: event.target.value }))}
                  placeholder="0 9 * * *"
                  spellCheck={false}
                />
              </label>
              <label className="taskField">
                <span>Prompt</span>
                <textarea
                  value={taskDraft.input}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, input: event.target.value }))}
                  rows={3}
                  placeholder="检查这个项目最近的变更，给我总结风险和下一步。"
                />
              </label>
              <div className="taskFormActions">
                <label className="taskEnabledControl">
                  <Switch
                    size="small"
                    checked={taskDraft.enabled}
                    onChange={(checked) => setTaskDraft((current) => ({ ...current, enabled: checked }))}
                    aria-label={taskDraft.enabled ? "Disable new task" : "Enable new task"}
                  />
                  <span>Enabled</span>
                </label>
                <button type="submit" disabled={!canCreateTask || taskBusyId === "create"}>
                  {taskBusyId === "create" ? "Saving" : "Save"}
                </button>
              </div>
            </form>
          ) : null}
          {taskError ? <div className="projectOpenError">{taskError}</div> : null}
        </section>

      </aside> : null}

      <section className="workspace">
        <header className="topbar">
          {!isVscodeSurface ? (
            <button
              type="button"
              className="sidebarPanelToggle"
              onClick={() => setSidebarCollapsed((current) => !current)}
              aria-label={sidebarCollapsed ? "Show menu" : "Hide menu"}
              title={sidebarCollapsed ? "Show menu" : "Hide menu"}
            >
              {sidebarCollapsed ? "Menu" : "Hide"}
            </button>
          ) : null}
          <div className="workspaceTitle">
            <span className="workspacePath" title={workspacePath}>
              {workspacePath || "No connected codexhub"}
            </span>
            <div className="workspaceMeta">
              {showWorkspaceMachineOffline ? (
                <span
                  className="workspaceRuntimeSessionState offline"
                  title="Machine offline"
                >
                  machine: offline
                </span>
              ) : null}
              {selectedProject || workspaceRuntime ? (
                <span
                  className={`workspaceRuntimeSessionState ${workspaceRuntime?.online ? "online" : "offline"}`}
                  title={workspaceRuntime ? runtimeSessionStatusTitle(workspaceRuntime) : "Runtime not started"}
                >
                  runtime: {workspaceRuntime?.online ? "online" : "offline"}
                </span>
              ) : null}
              {activeDisplayThreadId ? (
                <span className="workspaceThreadId" title={`thread: ${activeDisplayThreadId}`}>thread: {activeDisplayThreadId}</span>
              ) : workspaceRuntime ? (
                <span className="workspaceThreadId" title="thread: none">thread: none</span>
              ) : null}
            </div>
          </div>
          <div className="viewbar" aria-label="View settings">

          </div>
        </header>

        {activeRuntimeSession && activeSession && activeThreadBelongsToSession ? (
          <Tabs
            className="workspaceThreadTabs"
            tabBarExtraContent={{
              right: (
                <div className="threadTabActions">
                  <label className="switchControl">
                    <span>View</span>
                    <button
                      type="button"
                      className={`switchButton ${messageDisplayMode === "compact" ? "active" : ""}`}
                      aria-pressed={messageDisplayMode === "compact"}
                      onClick={() => setMessageDisplayMode((current) => current === "compact" ? "detailed" : "compact")}
                    >
                      {messageDisplayMode === "compact" ? "Simple" : "Detailed"}
                    </button>
                  </label>
                </div>
              )
            }}
            size="small"
            type="editable-card"
            activeKey={activeSession.threadId}
            items={activeRuntimeSessionThreadTabs.map((item) => ({
              ...item,
              closable: true,
              children: item.key === activeSession.threadId ? (
                <div className="threadWorkspacePane">
                  <Virtuoso
                    key={activeSession.threadId}
                    ref={messagesRef}
                    scrollerRef={(ref) => {
                      messagesScrollerRef.current = ref instanceof HTMLElement ? ref : null;
                    }}
                    className="messages"
                    data={activeViews}
                    followOutput={() => "smooth"}
                    initialTopMostItemIndex={Math.max(activeViews.length - 1, 0)}
                    increaseViewportBy={{ top: 360, bottom: 720 }}
                    computeItemKey={(_, message) => message.id}
                    components={{ EmptyPlaceholder: EmptyMessages }}
                    itemContent={(_, message) => {
                      const markdownEnabled = canRenderMarkdown(message);
                      const renderMode = markdownEnabled ? messageRenderModes[message.id] ?? "markdown" : "raw";
                      const inspectable = message.record.rawJsonl != null || (messageDisplayMode === "compact" && message.role === "tool");
                      return (
                        <MessageCard
                          message={message}
                          showStatus={messageDisplayMode === "compact" || message.role !== "tool"}
                          showTimestamp={!(messageDisplayMode === "compact" && message.role === "tool")}
                          renderToolPreview={messageDisplayMode === "compact"}
                          renderMode={renderMode}
                          markdownEnabled={markdownEnabled}
                          onRenderModeChange={markdownEnabled ? (mode) => updateMessageRenderMode(message.id, mode) : undefined}
                          onContextMenu={(event) => openMessageContextMenu(event, activeSession.threadId, message, inspectable)}
                          onFork={canForkAtMessage(activeSession.threadId, message) ? () => void forkMessage(activeSession.threadId, message.record.id) : undefined}
                          onRollback={canForkAtMessage(activeSession.threadId, message) ? () => void rollbackMessage(activeSession.threadId, message.record.id) : undefined}
                        />
                      );
                    }}
                  />
                  {showInlineStatusPanel ? (
                    <RuntimeStatusOverlay
                      statuses={simpleStatuses}
                      expandedKeys={activeExpandedStatusKeys}
                      onMinimize={() => {
                        if (!activeSession?.threadId || !latestTurnStatusScope.key) return;
                        setHiddenStatusTurns((current) => ({
                          ...current,
                          [activeSession.threadId]: latestTurnStatusScope.key
                        }));
                      }}
                      onToggle={(key) => {
                        if (!statusScopeKey) return;
                        setExpandedStatusKeys((current) => {
                          const keys = new Set(current[statusScopeKey] ?? []);
                          if (keys.has(key)) keys.delete(key);
                          else keys.add(key);
                          return { ...current, [statusScopeKey]: [...keys] };
                        });
                      }}
                    />
                  ) : null}

                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (activeCanSend) void send(activeSession.threadId);
                    }}
                  >
                    <div className="composerLayout">
                      <div className="composerSurface">
                        {activeGoal && activeSession ? (
                          <div
                            className={`goalStrip ${goalStatusClass(activeGoal.status)}`}
                            title={`${goalStatusLabel(activeGoal.status)} · ${activeGoal.objective}`}
                            aria-label={`${goalStatusLabel(activeGoal.status)}: ${activeGoal.objective}`}
                          >
                            <div className="goalStripMain">
                              <span className="goalStripIcon" aria-hidden="true">◎</span>
                              <span className="goalStripLabel">{goalStatusLabel(activeGoal.status)}</span>
                              <span className="goalStripObjective" title={activeGoal.objective}>{activeGoal.objective}</span>
                              {activeGoal.updatedAt ? <span className="goalStripAge">{formatGoalAge(activeGoal.updatedAt)}</span> : null}
                            </div>
                            <div className="goalStripActions">
                              <button
                                type="button"
                                className="goalIconButton"
                                title="编辑目标"
                                aria-label="编辑目标"
                                onClick={() => setGoalDialog({
                                  threadId: activeSession.threadId,
                                  objective: activeGoal.objective,
                                  saving: false,
                                  error: ""
                                })}
                              >
                                ✎
                              </button>
                              {activeGoal.status !== "complete" ? (
                                <button
                                  type="button"
                                  className="goalIconButton"
                                  title={activeGoal.status === "paused" ? "继续目标" : "暂停目标"}
                                  aria-label={activeGoal.status === "paused" ? "继续目标" : "暂停目标"}
                                  onClick={() => void updateThreadGoal(activeSession.threadId, {
                                    status: activeGoal.status === "paused" ? "active" : "paused"
                                  })}
                                >
                                  {activeGoal.status === "paused" ? "▶" : "Ⅱ"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="goalIconButton danger"
                                title="清除目标"
                                aria-label="清除目标"
                                onClick={() => void clearThreadGoal(activeSession.threadId)}
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <div className="composerInput">
                          {activeSession.textAttachments.length || activeSession.imageAttachments.length ? (
                            <div className="composerAttachmentList">
                              {activeSession.textAttachments.map((item) => (
                                <div className="textAttachment" key={item.id} title={item.text}>
                                  <span className="textAttachmentLabel">文本</span>
                                  <p>{item.text}</p>
                                  <button type="button" onClick={() => removeSessionTextAttachment(activeSession.threadId, item.id)} aria-label="Remove selected text">x</button>
                                </div>
                              ))}
                              {activeSession.imageAttachments.map((image) => (
                                <div className="imageAttachment" key={image.id}>
                                  <img src={image.previewUrl} alt={image.name} />
                                  <button type="button" onClick={() => removeSessionImage(activeSession.threadId, image.id)} aria-label={`Remove ${image.name}`}>x</button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          <textarea
                            ref={composerTextareaRef}
                            value={activeSession.input}
                            onChange={(event) => {
                              resetComposerHistory(activeSession.threadId);
                              resizeComposerTextarea(event.currentTarget);
                              updateSessionInput(activeSession.threadId, event.target.value);
                            }}
                            onPaste={(event) => {
                              if (!pasteSessionImages(activeSession.threadId, event.clipboardData)) return;
                              event.preventDefault();
                            }}
                            onKeyDown={(event) => handleComposerKeyDown(event, activeSession.threadId, activeUserMessageHistory)}
                            placeholder="例如：检查这个 repo 的结构并给我下一步建议"
                            rows={2}
                          />
                        </div>
                        <div className="composerActions">
                          <div className="composerLeftActions">
                            <div className="composerMenuHost" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="composerIconButton"
                                aria-label="Open composer menu"
                                aria-expanded={composerMenuOpen}
                                onClick={() => setComposerMenuOpen((open) => !open)}
                              >
                                +
                              </button>
                              {composerMenuOpen ? (
                                <div className="composerMenu" role="menu">
                                  <button
                                    type="button"
                                    className="composerMenuItem"
                                    role="menuitem"
                                    onClick={() => {
                                      setComposerMenuOpen(false);
                                      imageFileInputRef.current?.click();
                                    }}
                                  >
                                    <span className="composerMenuIcon" aria-hidden="true">[]</span>
                                    <span>添加照片和文件</span>
                                  </button>
                                </div>
                              ) : null}
                            </div>
                            <div className="composerModeSegmented" role="radiogroup" aria-label="Composer mode">
                              {composerModeOptions.map((option) => (
                                <button
                                  key={option.value}
                                  type="button"
                                  className={`composerModeOption${composerMode === option.value ? " active" : ""}`}
                                  role="radio"
                                  aria-checked={composerMode === option.value}
                                  onClick={() => setComposerMode(option.value)}
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="composerRightActions">
                            {renderComposerRuntimeControls("inline")}
                            <div className="composerRuntimeMenuHost" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="composerMoreButton"
                                aria-label="Show runtime usage and model"
                                aria-expanded={runtimeMenuOpen}
                                onClick={() => setRuntimeMenuOpen((open) => !open)}
                              >
                                ...
                              </button>
                              {runtimeMenuOpen ? (
                                <div className="composerRuntimePopover">
                                  {renderComposerRuntimeControls("popover")}
                                </div>
                              ) : null}
                            </div>
                            <div
                              className={`composerActionButtons status-${turnUiState.kind}`}
                              title={turnUiState.title}
                              aria-label={`Turn status: ${turnUiState.label}`}
                            >
                              {showComposerSendButton ? (
                                <button
                                  type="submit"
                                  className="composerSendButton composerActionButton"
                                  disabled={!activeCanSubmit}
                                  aria-label="Send message"
                                  title={`Send message · ${turnUiState.title}`}
                                >
                                  ↑
                                </button>
                              ) : null}
                              {activeSession.running ? (
                                <button
                                  type="button"
                                  className="composerStopButton composerActionButton"
                                  disabled={!activeCanStop}
                                  aria-label="Stop current turn"
                                  title={`Stop current turn · ${turnUiState.title}`}
                                  onClick={() => void stopTurn(activeSession.threadId)}
                                >
                                  ■
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <input
                          ref={imageFileInputRef}
                          className="imageUploadInput"
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(event) => {
                            addSessionImages(activeSession.threadId, event.currentTarget.files);
                            event.currentTarget.value = "";
                          }}
                        />
                      </div>
                    </div>
                  </form>
                </div>
              ) : null
            }))}
            onChange={(threadId) => void switchRuntimeSessionThread(threadId)}
            onEdit={(targetKey, action) => {
              if (action === "add") {
                if (activeRuntimeSession.online) openThreadPicker(activeRuntimeSession);
                return;
              }
              if (action === "remove" && typeof targetKey === "string") {
                void closeThread(targetKey);
              }
            }}
          />
        ) : (
          <div className="empty">
            <span>{workspaceEmptyMessage}</span>
            {activeRuntimeSession?.online ? (
              <button type="button" className="emptyActionButton" onClick={() => openThreadPicker(activeRuntimeSession)}>
                Add Thread
              </button>
            ) : null}
          </div>
        )}
      </section>

      {runtimeDialogOpen ? (
        <div className="runtimeDialogOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRuntimeDialogOpen(false);
        }}>
          <section className="runtimeDialog" role="dialog" aria-modal="true" aria-labelledby="runtimeDialogTitle">
            <header className="runtimeDialogHeader">
              <h2 id="runtimeDialogTitle">Runtime</h2>
              <button type="button" className="iconButton" onClick={() => setRuntimeDialogOpen(false)} aria-label="Close">x</button>
            </header>
            <label className="runtimeDialogField">
              <span>Model</span>
              <select value={effectiveModelSelection} onChange={(event) => setSelectedModel(event.target.value as ModelSelection)}>
                {runtimeModelOptions.map((option) => <option value={option.value} key={option.value}>{modelOptionLabel(option)}</option>)}
              </select>
            </label>
            <label className="runtimeDialogField">
              <span>Thinking</span>
              <select value={effectiveReasoningSelection} onChange={(event) => setSelectedReasoning(event.target.value as ReasoningSelection)}>
                {reasoningOptions.map((option) => <option value={option.value} key={option.value}>{reasoningOptionLabel(option)}</option>)}
              </select>
            </label>
          </section>
        </div>
      ) : null}

      {goalDialog ? (
        <div className="modalOverlay goalDialogOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !goalDialog.saving) setGoalDialog(null);
        }}>
          <section className="goalDialog" role="dialog" aria-modal="true" aria-labelledby="goalDialogTitle">
            <header className="goalDialogHeader">
              <div className="goalDialogMark" aria-hidden="true">◎</div>
              <button
                type="button"
                className="goalDialogClose"
                onClick={() => setGoalDialog(null)}
                disabled={goalDialog.saving}
                aria-label="关闭"
              >
                ×
              </button>
            </header>
            <h2 id="goalDialogTitle">编辑目标</h2>
            <textarea
              value={goalDialog.objective}
              onChange={(event) => setGoalDialog((current) => current
                ? { ...current, objective: event.target.value, error: "" }
                : current)}
              rows={7}
              autoFocus
            />
            {goalDialog.error ? <div className="goalDialogError">{goalDialog.error}</div> : null}
            <footer className="goalDialogActions">
              <button type="button" onClick={() => setGoalDialog(null)} disabled={goalDialog.saving}>取消</button>
              <button
                type="button"
                className="primary"
                onClick={() => void saveGoalDialog()}
                disabled={goalDialog.saving || !goalDialog.objective.trim()}
              >
                {goalDialog.saving ? "保存中" : "保存"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {threadPicker ? (
        <div className="modalOverlay threadPickerOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setThreadPicker(null);
        }}>
          <section className="threadPickerModal" role="dialog" aria-modal="true" aria-labelledby="threadPickerTitle">
            <header className="threadPickerHeader">
              <div>
                <h2 id="threadPickerTitle">Add Thread</h2>
                <p>{threadPickerRuntimeSession?.name ?? shortId(threadPicker.sessionId)}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setThreadPicker(null)} aria-label="Close">x</button>
            </header>
            <div className="threadPickerList" role="listbox" aria-label="Thread candidates">
              <button
                type="button"
                className="threadPickerRow newThread"
                onClick={() => void createRuntimeSessionThread()}
                disabled={threadPicker.acting !== null}
              >
                <span className="threadPickerRowTitle">New thread</span>
                <span className="threadPickerRowMeta">{threadPicker.acting === "new" ? "creating" : "Start a new Codex thread"}</span>
              </button>
              {threadPicker.loading ? (
                <div className="threadPickerEmpty">Loading threads</div>
              ) : threadPicker.candidates.length === 0 ? (
                <div className="threadPickerEmpty">No local threads</div>
              ) : threadPicker.candidates.map((candidate) => {
                const isOpen = threadPickerOpenThreadIds.has(candidate.threadId);
                const acting = threadPicker.acting === candidate.threadId;
                return (
                  <button
                    type="button"
                    className={`threadPickerRow ${isOpen ? "open" : ""}`}
                    key={candidate.threadId}
                    onClick={() => void chooseThreadCandidate(candidate)}
                    disabled={threadPicker.acting !== null}
                    title={candidate.threadId}
                  >
                    <span className="threadPickerRowTitle">{threadCandidateTitle(candidate)}</span>
                    <span className="threadPickerRowMeta">
                      <code>{shortId(candidate.threadId)}</code>
                      <span>{formatThreadCandidateTime(candidate.updatedAt)}</span>
                      {isOpen ? <strong>open</strong> : null}
                      {acting ? <strong>restoring</strong> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {threadPicker.error ? <div className="projectOpenError">{threadPicker.error}</div> : null}
          </section>
        </div>
      ) : null}

      {projectPicker ? (
        <div className="modalOverlay projectPickerOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setProjectPicker(null);
        }}>
          <section className="projectPickerModal" role="dialog" aria-modal="true" aria-labelledby="projectPickerTitle">
            <header className="projectPickerHeader">
              <div>
                <h2 id="projectPickerTitle">Add Project</h2>
                <p>{projectPickerMachine?.name ?? projectPickerMachine?.hostname ?? projectPicker.machineId}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setProjectPicker(null)} aria-label="Close">x</button>
            </header>
            <div className="projectPickerBody">
              <label className="projectPickerField">
                <span>Machine</span>
                <select
                  value={projectPicker.machineId}
                  onChange={(event) => changeProjectPickerMachine(event.target.value)}
                  disabled={projectPicker.loading || onlineMachines.length <= 1}
                >
                  {onlineMachines.map((machine) => (
                    <option value={machine.machineId} key={machine.machineId}>
                      {machine.name ?? machine.hostname}
                    </option>
                  ))}
                </select>
              </label>
              <div className="projectPickerField">
                <span>Folder path</span>
                <form className="projectPickerPathForm" onSubmit={submitProjectPickerPath}>
                  <button
                    type="button"
                    className="projectPickerPathButton"
                    onClick={() => projectPicker.parent ? void loadProjectPickerDirectory(projectPicker.machineId, projectPicker.parent) : undefined}
                    disabled={projectPicker.loading || !projectPicker.parent}
                    aria-label="Go to parent folder"
                  >
                    ..
                  </button>
                  <button
                    type="button"
                    className="projectPickerPathButton"
                    onClick={() => projectPicker.home ? void loadProjectPickerDirectory(projectPicker.machineId, projectPicker.home) : undefined}
                    disabled={projectPicker.loading || !projectPicker.home}
                    aria-label="Go to home folder"
                  >
                    ~
                  </button>
                  <input
                    value={projectPicker.path}
                    onChange={(event) => setProjectPicker((current) => current ? { ...current, path: event.target.value } : current)}
                    spellCheck={false}
                    aria-label="Folder path"
                  />
                  <button type="submit" className="projectPickerGoButton" disabled={projectPicker.loading || !projectPicker.path.trim()}>
                    Go
                  </button>
                </form>
              </div>
              <div className="projectPickerList" role="listbox" aria-label="Folders">
                {projectPicker.loading ? (
                  <div className="projectPickerEmpty">Loading folders</div>
                ) : projectPicker.entries.length === 0 ? (
                  <div className="projectPickerEmpty">No folders</div>
                ) : projectPicker.entries.map((entry) => (
                  <button
                    type="button"
                    className="projectPickerRow"
                    key={entry.path}
                    onClick={() => void loadProjectPickerDirectory(projectPicker.machineId, entry.path)}
                    title={entry.path}
                  >
                    <span className="projectFolderIcon" aria-hidden="true" />
                    <span>{entry.name}</span>
                  </button>
                ))}
              </div>
              {projectPicker.error ? <div className="projectOpenError">{projectPicker.error}</div> : null}
            </div>
            <footer className="projectPickerFooter">
              <button type="button" className="secondaryButton" onClick={() => setProjectPicker(null)}>Cancel</button>
              <button
                type="button"
                className="projectPickerPrimaryButton"
                onClick={() => void confirmProjectPicker()}
                disabled={projectPicker.loading || projectPickerOpening || !projectPicker.path.trim()}
              >
                {projectPickerOpening ? "Opening" : "Add Project"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {messageContextMenu ? (
        <div
          className="messageContextMenuLayer"
          role="presentation"
          onMouseDown={() => setMessageContextMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMessageContextMenu(null);
          }}
        >
          <div
            className="messageContextMenu"
            role="menu"
            style={{ left: messageContextMenu.x, top: messageContextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {messageContextMenu.selectedText ? (
              <>
                <button type="button" role="menuitem" onClick={() => void copyContextSelection()}>
                  复制
                </button>
                <button type="button" role="menuitem" onClick={addContextSelectionToConversation}>
                  添加到对话
                </button>
              </>
            ) : null}
            {messageContextMenu.canInspect ? (
              <button type="button" role="menuitem" onClick={inspectContextMessage}>
                查看详细
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {inspectMessage ? (
        <div className="modalOverlay" role="dialog" aria-modal="true" onClick={() => setInspectMessage(null)}>
          <section className="modal detailModal" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <div>
                <h2>{formatInspectTitle(inspectMessage)}</h2>
                <p>{inspectMessage.status ? statusLabel(inspectMessage.status) : "Details"}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setInspectMessage(null)} aria-label="Close">x</button>
            </header>
            <ToolInspectBody message={inspectMessage} />
          </section>
        </div>
      ) : null}

    </main>
  );
};

const MessageCard = ({
  message,
  showStatus = true,
  showTimestamp = true,
  renderToolPreview = true,
  renderMode,
  markdownEnabled,
  onRenderModeChange,
  onContextMenu,
  onFork,
  onRollback
}: {
  message: WebRecordView;
  showStatus?: boolean;
  showTimestamp?: boolean;
  renderToolPreview?: boolean;
  renderMode: MessageRenderMode;
  markdownEnabled: boolean;
  onRenderModeChange?: (mode: MessageRenderMode) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  onFork?: () => void;
  onRollback?: () => void;
}) => {
  const isThinkingMessage = message.role === "thinking";
  const toolBody = renderToolPreview ? renderToolMessageBody(message, showStatus ? message.status : undefined) : null;
  const hasToolBody = toolBody !== null;
  const memoryCitation = useMemo(() => {
    if (isThinkingMessage) return emptyMemoryCitation("");
    return shouldExtractMemoryCitation(message) ? parseMemoryCitationText(message.text) : emptyMemoryCitation(message.text);
  }, [message, isThinkingMessage]);
  const messageText = memoryCitation.text;
  const hasMessageMeta = !isThinkingMessage && ((showTimestamp && message.at) || message.usage || markdownEnabled || onFork || onRollback);
  return (
    <article
      className={`message ${message.role} ${hasToolBody ? "richTool" : ""} ${onContextMenu ? "hasContextMenu" : ""} ${renderMode === "markdown" ? "markdownMode" : "rawMode"}`}
      onContextMenu={onContextMenu}
    >
      {hasToolBody ? null : (
        <span className="messageHeader">
          <b>{message.label ?? message.role}</b>
          {showStatus && message.status ? <em className={`messageStatus ${message.status}`}>{statusLabel(message.status)}</em> : null}
        </span>
      )}
      {hasToolBody ? (
        toolBody
      ) : messageText ? (
        <MessageText text={messageText} mode={renderMode} markdownEnabled={markdownEnabled} />
      ) : null}
      {!isThinkingMessage && (memoryCitation.entries.length || memoryCitation.rolloutIds.length) ? (
        <MemoryCitationPanel citation={memoryCitation} />
      ) : null}
      {!isThinkingMessage && message.attachments?.length ? (
        <div className="messageAttachments">
          {message.attachments.map((attachment) => attachment.type === "image" ? (
            <a
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              className="messageImage"
              key={attachment.url}
              onClick={(event) => event.stopPropagation()}
            >
              <img src={attachment.url} alt="attachment" />
            </a>
          ) : null)}
        </div>
      ) : null}
      {hasMessageMeta ? (
        <footer className="messageMeta" title={formatMessageMetaTitle(message, { showTimestamp })} onClick={(event) => event.stopPropagation()}>
          <span>{formatMessageMeta(message, { showTimestamp })}</span>
          {markdownEnabled && onRenderModeChange ? (
            <Switch
              size="small"
              checked={renderMode === "markdown"}
              checkedChildren="MD"
              unCheckedChildren="Raw"
              onChange={(checked) => onRenderModeChange(checked ? "markdown" : "raw")}
              aria-label="Toggle Markdown rendering"
            />
          ) : null}
          {onFork ? (
            <a href="#" onClick={(event) => {
              event.preventDefault();
              onFork();
            }}>Fork</a>
          ) : null}
          {onRollback ? (
            <a href="#" onClick={(event) => {
              event.preventDefault();
              onRollback();
            }}>Rollback</a>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
};

const MemoryCitationPanel = ({ citation }: { citation: MemoryCitationView }) => (
  <details className="memoryCitation" open>
    <summary>
      <span>{formatMemoryCitationCount(citation.entries.length)}</span>
    </summary>
    <div className="memoryCitationBody">
      {citation.entries.map((entry, index) => (
        <div className="memoryCitationEntry" key={`${entry.raw}:${index}`}>
          <div className="memoryCitationSource">
            <strong>{entry.source}</strong>
            {entry.lineStart ? <span>{formatMemoryCitationLines(entry)}</span> : null}
          </div>
          {entry.note ? <p>{entry.note}</p> : null}
        </div>
      ))}
      {citation.rolloutIds.length ? (
        <div className="memoryCitationEntry">
          <div className="memoryCitationSource">
            <strong>rollout_ids</strong>
          </div>
          <p>{citation.rolloutIds.join(", ")}</p>
        </div>
      ) : null}
    </div>
  </details>
);

const memoryCitationBlockPattern = /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g;

const emptyMemoryCitation = (text: string): MemoryCitationView => ({ text, entries: [], rolloutIds: [] });

const shouldExtractMemoryCitation = (message: WebRecordView) =>
  message.role === "codex" && message.label === "final_answer";

const parseMemoryCitationText = (text: string): MemoryCitationView => {
  const blocks = text.match(memoryCitationBlockPattern) ?? [];
  if (!blocks.length) return { text, entries: [], rolloutIds: [] };
  const entries = blocks.flatMap(parseMemoryCitationEntries);
  const rolloutIds = [...new Set(blocks.flatMap(parseMemoryCitationRolloutIds))];
  return {
    text: text.replace(memoryCitationBlockPattern, "").trimEnd(),
    entries,
    rolloutIds
  };
};

const parseMemoryCitationEntries = (block: string): MemoryCitationEntry[] =>
  xmlSectionLines(block, "citation_entries").flatMap((line) => {
    const parsed = parseMemoryCitationEntry(line);
    return parsed ? [parsed] : [];
  });

const parseMemoryCitationRolloutIds = (block: string) =>
  xmlSectionLines(block, "rollout_ids").filter((line) => line.trim().length > 0);

const parseMemoryCitationEntry = (line: string): MemoryCitationEntry | null => {
  const raw = line.trim();
  if (!raw) return null;
  const [location, notePart] = splitMemoryCitationNote(raw);
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(location.trim());
  if (!match) return { source: location.trim() || raw, note: notePart, raw };
  const source = match[1]?.trim() || raw;
  const lineStart = match[2] ? Number(match[2]) : undefined;
  const lineEnd = match[3] ? Number(match[3]) : lineStart;
  return {
    source,
    lineStart,
    lineEnd,
    note: notePart,
    raw
  };
};

const splitMemoryCitationNote = (line: string): [string, string | undefined] => {
  const marker = "|note=";
  const index = line.indexOf(marker);
  if (index === -1) return [line, undefined];
  const note = line.slice(index + marker.length).trim();
  return [
    line.slice(0, index),
    note.startsWith("[") && note.endsWith("]") ? note.slice(1, -1) : note
  ];
};

const xmlSectionLines = (block: string, tag: string) => {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(block);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => decodeXmlText(line.trim()))
    .filter(Boolean);
};

const decodeXmlText = (text: string) => text
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'");

const formatMemoryCitationCount = (count: number) => `${count} 条记忆引用`;

const formatMemoryCitationLines = (entry: MemoryCitationEntry) => {
  if (!entry.lineStart) return "";
  if (!entry.lineEnd || entry.lineEnd === entry.lineStart) return `${entry.lineStart} 行`;
  return `${entry.lineStart}-${entry.lineEnd} 行`;
};

const UpdatePlanPreview = ({
  plan,
  status
}: {
  plan: UpdatePlanViewModel;
  status?: CodexRecordView["status"];
}) => (
  <ToolPreview title="Updated Plan" status={status} className="updatePlanPreview">
    {plan.explanation ? <p className="updatePlanExplanation">{plan.explanation}</p> : null}
    {plan.steps.length ? (
      <ol className="updatePlanSteps">
        {plan.steps.map((step, index) => {
          const normalizedStatus = normalizeUpdatePlanStatus(step.status);
          return (
            <li className={`updatePlanStep ${normalizedStatus}`} key={`${index}:${step.step}`} title={updatePlanStatusLabel(step.status)}>
              <span className="updatePlanStepIcon" aria-hidden="true">{updatePlanStatusIcon(step.status)}</span>
              <span className="updatePlanStepText">{step.step}</span>
            </li>
          );
        })}
      </ol>
    ) : null}
  </ToolPreview>
);

const CommandToolPreview = ({
  args,
  status
}: {
  args: Record<string, unknown>;
  status?: CodexRecordView["status"];
}) => {
  const command = typeof args.cmd === "string" ? formatCommandBlock(args.cmd) : "<missing>";
  return (
    <ToolPreview title="tool: exec_command" status={status} meta={toolPreviewMeta(args)}>
      <pre className="toolCommandLine">{command.includes("\n") ? command : `$ ${command}`}</pre>
    </ToolPreview>
  );
};

const WriteStdinToolPreview = ({
  args,
  status
}: {
  args: Record<string, unknown>;
  status?: CodexRecordView["status"];
}) => (
  <ToolPreview title="tool: write_stdin" status={status} meta={toolPreviewMeta(args)}>
    <p className="toolPreviewBody">{formatWriteStdinSummary(args)}</p>
  </ToolPreview>
);

const ToolPreview = ({
  title,
  status,
  className = "",
  meta,
  children
}: {
  title: string;
  status?: CodexRecordView["status"];
  className?: string;
  meta?: string[];
  children: React.ReactNode;
}) => (
  <div className={`toolPreview ${className}`.trim()}>
    <div className="toolPreviewTitle">
      <span className="toolPreviewTitleMark" aria-hidden="true">•</span>
      <strong>{title}</strong>
      {status ? <em className={`messageStatus ${status}`}>{statusLabel(status)}</em> : null}
    </div>
    {meta?.length ? (
      <div className="toolPreviewMeta">
        {meta.map((item) => <span className="toolPreviewMetaItem" key={item} title={item}>{item}</span>)}
      </div>
    ) : null}
    {children}
  </div>
);

const FileChangePreview = ({
  payload,
  status
}: {
  payload: Record<string, unknown>;
  status?: CodexRecordView["status"];
}) => {
  const files = fileChangePreviewFiles(payload);
  const visibleFiles = files.slice(0, 5);
  const hiddenCount = files.length - visibleFiles.length;
  const title = status === "failed" ? "Patch failed" : "Files changed";
  return (
    <ToolPreview title={title} status={status} meta={appServerToolMeta(payload)} className="fileChangePreview">
      {visibleFiles.length ? (
        <div className="fileChangeList">
          {visibleFiles.map((file, index) => (
            <div className="fileChangeRow" key={`${file.path}:${index}`} title={file.path}>
              <span className="fileChangePath">{file.path}</span>
              <span className="fileChangeStat added">+{file.added ?? "?"}</span>
              <span className="fileChangeStat removed">-{file.removed ?? "?"}</span>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <div className="fileChangeMore">+ {hiddenCount} more file{hiddenCount === 1 ? "" : "s"}</div>
          ) : null}
        </div>
      ) : (
        <p className="toolPreviewBody">No file changes</p>
      )}
    </ToolPreview>
  );
};

const ApplyPatchPreview = ({
  args,
  status
}: {
  args: Record<string, unknown>;
  status?: CodexRecordView["status"];
}) => {
  const patch = applyPatchInput(args);
  const files = parseApplyPatchFiles(patch);
  const visibleFiles = files.slice(0, 5);
  const hiddenCount = files.length - visibleFiles.length;
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  return (
    <ToolPreview
      title="tool: apply_patch"
      status={status}
      meta={[
        files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : null,
        added ? `+${added}` : null,
        removed ? `-${removed}` : null
      ].filter((item): item is string => Boolean(item))}
      className="fileChangePreview applyPatchPreview"
    >
      {visibleFiles.length ? (
        <div className="fileChangeList">
          {visibleFiles.map((file, index) => (
            <div className="fileChangeRow applyPatchRow" key={`${file.path}:${index}`} title={file.path}>
              <span className={`patchKind ${file.kind}`}>{file.kind}</span>
              <span className="fileChangePath">{file.path}</span>
              <span className="fileChangeStat added">+{file.added}</span>
              <span className="fileChangeStat removed">-{file.removed}</span>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <div className="fileChangeMore">+ {hiddenCount} more file{hiddenCount === 1 ? "" : "s"}</div>
          ) : null}
        </div>
      ) : (
        <p className="toolPreviewBody">{patch ? "Patch" : "Empty patch"}</p>
      )}
    </ToolPreview>
  );
};

const webToolPresenters: Record<string, WebToolPresenter> = {
  exec_command: {
    render: (args, status) => <CommandToolPreview args={args} status={status} />,
    inspect: (args, output) => ({
      ...formatToolInput("exec_command", args),
      ...formatRawToolOutput(output)
    })
  },
  update_plan: {
    render: (args, status) => {
      const plan = parseUpdatePlanArguments(args);
      return plan ? <UpdatePlanPreview plan={plan} status={status} /> : null;
    },
    inspect: (args, output) => {
      const plan = parseUpdatePlanArguments(args);
      return plan ? {
        inputMeta: formatUpdatePlanInspectInput(plan),
        outputMeta: output.trimEnd() || undefined
      } : null;
    }
  },
  write_stdin: {
    render: (args, status) => <WriteStdinToolPreview args={args} status={status} />,
    inspect: (args, output) => ({
      ...formatToolInput("write_stdin", args),
      ...formatRawToolOutput(output)
    })
  },
  apply_patch: {
    render: (args, status) => <ApplyPatchPreview args={args} status={status} />,
    inspect: (args, output) => ({
      ...formatApplyPatchInspect(args),
      ...formatRawToolOutput(output)
    })
  }
};

const MessageText = ({
  text,
  mode,
  markdownEnabled
}: {
  text: string;
  mode: MessageRenderMode;
  markdownEnabled: boolean;
}) => {
  if (!markdownEnabled || mode === "raw") return <pre>{text}</pre>;
  return (
    <div className="messageMarkdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
};

const markdownComponents: Components = {
  a: ({ children, href, ...props }) => (
    <a href={href} target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <div className="markdownCodeBlock">
      {children}
    </div>
  ),
  code: ({ children, className, ...props }) => {
    const language = markdownCodeLanguage(className);
    if (!language) return <code className={className} {...props}>{children}</code>;
    const code = String(children).replace(/\n$/, "");
    return (
      <Suspense fallback={<code className="markdownHighlightedCode">{code}</code>}>
        <SyntaxCodeBlock language={language}>{code}</SyntaxCodeBlock>
      </Suspense>
    );
  },
  table: ({ children }) => (
    <div className="markdownTableScroll">
      <table>{children}</table>
    </div>
  )
};

const EmptyMessages = () => (
  <div className="empty">输入一个任务，让本地 Codex 代理开始工作。</div>
);

const RuntimeStatusOverlay = ({
  statuses,
  expandedKeys,
  onMinimize,
  onToggle
}: {
  statuses: RuntimeStatusView[];
  expandedKeys: Set<string>;
  onMinimize: () => void;
  onToggle: (key: string) => void;
}) => (
  <div className={`runtimeStatusOverlay ${runtimeStatusOverlayClass(statuses)}`} aria-live="polite" title={runtimeStatusTitle(statuses)}>
    <RuntimeStatusRows statuses={statuses} expandedKeys={expandedKeys} onToggle={onToggle} />
    <button type="button" className="runtimeStatusMinimize" onClick={onMinimize} aria-label="Minimize status" title="Minimize status">−</button>
  </div>
);

const RuntimeStatusRows = ({
  statuses,
  expandedKeys,
  onToggle
}: {
  statuses: RuntimeStatusView[];
  expandedKeys?: Set<string>;
  onToggle?: (key: string) => void;
}) => (
  <div className={`runtimeStatusRows${expandedKeys?.size ? " expanded" : ""}`}>
    {statuses.map((status) => {
      const expandable = Boolean(status.files?.length && onToggle);
      const expanded = Boolean(expandedKeys?.has(status.key));
      const content = (
        <>
          <span className="runtimeStatusLabel">{status.label}</span>
          <span className="runtimeStatusViewport">
            <span className="runtimeStatusTrack">{status.text}</span>
          </span>
          {expanded && status.files?.length ? <RuntimeStatusFiles files={status.files} /> : null}
        </>
      );
      return expandable ? (
        <button
          type="button"
          className={`runtimeStatusItem hasFiles${expanded ? " expanded" : ""}`}
          key={status.key}
          onClick={() => onToggle?.(status.key)}
          aria-expanded={expanded}
        >
          {content}
        </button>
      ) : (
        <div className="runtimeStatusItem" key={status.key}>
          {content}
        </div>
      );
    })}
  </div>
);

const RuntimeStatusFiles = ({ files }: { files: RuntimeStatusFile[] }) => (
  <div className="runtimeStatusFiles">
    {files.map((file, index) => (
      <div className="fileChangeRow" key={`${file.path}:${index}`} title={file.path}>
        <span className="fileChangePath">{file.path}</span>
        <span className="fileChangeStat added">+{file.added ?? "?"}</span>
        <span className="fileChangeStat removed">-{file.removed ?? "?"}</span>
      </div>
    ))}
  </div>
);

const ToolInspectBody = ({ message }: { message: WebRecordView }) => {
  const detail = formatInspectDetail(message);
  return (
    <div className="detailBody">
      <section className="detailSection">
        <h3>Input</h3>
        <pre>{detail.inputMeta || "(empty)"}</pre>
        {detail.inputBlock ? (
          <div className="detailCodeBlock">
            <h4>{detail.inputBlockLabel ?? "Content"}</h4>
            <pre>{detail.inputBlock}</pre>
          </div>
        ) : null}
      </section>
      {detail.memoryCitation?.entries.length || detail.memoryCitation?.rolloutIds.length ? (
        <section className="detailSection">
          <h3>Memory</h3>
          <MemoryCitationPanel citation={detail.memoryCitation} />
        </section>
      ) : null}
      {detail.outputMeta || detail.outputBlock ? (
        <section className="detailSection">
          <h3>Output</h3>
          {detail.outputMeta ? <pre>{detail.outputMeta}</pre> : null}
          {detail.outputBlock ? (
            <div className="detailCodeBlock">
              <h4>{detail.outputBlockLabel ?? "Text"}</h4>
              <pre>{detail.outputBlock}</pre>
            </div>
          ) : null}
        </section>
      ) : null}
      {detail.rawBlock ? (
        <section className="detailSection">
          <h3>Raw</h3>
          <div className="detailCodeBlock">
            <h4>{detail.rawBlockLabel ?? "JSONL"}</h4>
            <pre>{detail.rawBlock}</pre>
          </div>
        </section>
      ) : null}
    </div>
  );
};

const apiJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};

const realtimeMessageTypes = new Set([
  "sessions",
  "projects",
  "tasks",
  "connections",
  "thread",
  "record",
  "done",
  "jsonl_snapshot",
  "jsonl_append",
  "ready",
  "thread_subscribed",
  "thread_unsubscribed",
  "error"
]);

const parseRealtimeMessage = (data: unknown): RealtimeMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const type = typeof record?.type === "string"
    ? record.type
    : typeof record?.kind === "string" ? record.kind : "";
  if (!realtimeMessageTypes.has(type)) return null;
  return { ...record, type } as RealtimeMessage;
};

const fileToDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
  reader.readAsDataURL(file);
});

const shortId = (id: string) => id.slice(0, 8);

const canRenderMarkdown = (message: WebRecordView) => {
  if (message.role !== "codex") return false;
  const label = message.label.toLowerCase();
  return label === "commentary" || label === "final_answer" || label === "assistant";
};

const markdownCodeLanguage = (className: string | undefined) => {
  const language = className?.match(/language-([\w-]+)/)?.[1].toLowerCase();
  if (!language) return null;
  const normalized = languageAliases[language] ?? language;
  return highlightedLanguages.has(normalized) ? normalized : null;
};

const canForkAtMessage = (threadId: string, message: WebRecordView) =>
  Boolean(message.canFork && turnIdFromAppRecordId(threadId, message.record.id));

const turnIdFromAppRecordId = (threadId: string, recordId: string) => {
  const prefix = `app:${threadId}:`;
  if (!recordId.startsWith(prefix)) return null;
  const rest = recordId.slice(prefix.length);
  const [turnId, kind] = rest.split(":");
  if (!turnId || !kind) return null;
  return turnId;
};

const normalizeRuntimeSessions = (sessions: RuntimeSessionSummary[] | undefined): RuntimeSession[] =>
  Array.isArray(sessions)
    ? sessions
      .filter((session) => typeof session.sessionId === "string" && Boolean(session.sessionId))
      .map((session) => ({
        ...session,
        sessionId: session.sessionId,
        threads: Array.isArray(session.threads) ? session.threads : []
      }))
    : [];

const normalizeMachines = (machines: MachineSummary[] | undefined) =>
  Array.isArray(machines)
    ? machines
    : [];

const normalizeProjects = (projects: ProjectSummary[] | undefined) =>
  Array.isArray(projects)
    ? projects.map((project) => ({
      ...project,
      machineOnline: Boolean(project.machineOnline ?? (project.machine && "online" in project.machine && project.machine.online)),
      runtime: project.runtime ? normalizeRuntimeSessions([project.runtime])[0] ?? null : null,
      sessions: normalizeRuntimeSessions(project.sessions),
      threads: Array.isArray(project.threads) ? project.threads : [],
      storedThreads: Array.isArray(project.storedThreads) ? project.storedThreads : []
    }))
    : [];

const normalizePlugins = (plugins: PluginSummary[] | undefined) =>
  Array.isArray(plugins)
    ? plugins.map((plugin) => ({
      ...plugin,
      contributions: {
        web: {
          styles: Array.isArray(plugin.contributions?.web?.styles) ? plugin.contributions.web.styles : []
        },
        integrations: Array.isArray(plugin.contributions?.integrations) ? plugin.contributions.integrations : []
      }
    }))
    : [];

const normalizeTasks = (tasks: LocalTask[] | undefined) =>
  Array.isArray(tasks)
    ? [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    : [];

const defaultTaskDraft = (): TaskDraft => ({
  name: "daily-summary",
  enabled: true,
  schedule: "0 9 * * *",
  machineId: "",
  projectPath: "",
  threadId: "",
  input: "检查这个项目最近的变更，给我总结风险和下一步。"
});

const taskThreadOptionsFor = (project: ProjectSummary | undefined) => {
  const threads = new Map<string, Pick<ThreadSummary, "threadId" | "title" | "updatedAt">>();
  const pushThread = (thread: Pick<ThreadSummary, "threadId" | "title" | "updatedAt"> | StoredProjectThread) => {
    if (!thread.threadId) return;
    const existing = threads.get(thread.threadId);
    if (existing && existing.updatedAt >= thread.updatedAt) return;
    threads.set(thread.threadId, {
      threadId: thread.threadId,
      title: thread.title,
      updatedAt: thread.updatedAt
    });
  };
  for (const thread of project?.threads ?? []) pushThread(thread);
  for (const thread of project?.storedThreads ?? []) pushThread(thread);
  return [...threads.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

const taskStatusLabel = (task: LocalTask) => {
  if (!task.enabled) return "paused";
  if (task.lastStatus === "queued") return "queued";
  if (task.lastStatus === "completed") return "done";
  if (task.lastStatus === "failed") return "failed";
  if (task.lastStatus === "skipped") return "skipped";
  return "scheduled";
};

const taskStatusClass = (task: LocalTask) => task.enabled ? task.lastStatus ?? "idle" : "paused";

const taskBelongsToProject = (task: LocalTask, project: ProjectSummary) =>
  task.machineId === project.machineId
  && (task.projectPath === project.path || Boolean(task.projectId && task.projectId === project.projectId));

const taskTargetLabel = (task: LocalTask, projects: ProjectSummary[], machines: MachineSummary[]) => {
  const project = projects.find((item) => item.machineId === task.machineId && item.path === task.projectPath);
  const machine = machines.find((item) => item.machineId === task.machineId);
  const projectName = project?.name ?? basename(task.projectPath);
  const machineName = machine?.name ?? machine?.hostname ?? task.machineId;
  const thread = task.threadId ? shortId(task.threadId) : "project thread";
  return `${projectName} · ${machineName} · ${thread}`;
};

const taskTargetTitle = (task: LocalTask, projects: ProjectSummary[], machines: MachineSummary[]) => {
  const project = projects.find((item) => item.machineId === task.machineId && item.path === task.projectPath);
  const machine = machines.find((item) => item.machineId === task.machineId);
  return [
    `machine: ${machine?.name ?? machine?.hostname ?? task.machineId}`,
    `project: ${project?.path ?? task.projectPath}`,
    `thread: ${task.threadId ?? "project default"}`,
    task.lastRunAt ? `last run: ${formatDate(task.lastRunAt)}` : null
  ].filter(Boolean).join("\n");
};

const uniqueMachines = (machines: MachineSummary[]) => {
  const byId = new Map<string, MachineSummary>();
  for (const machine of machines) {
    const key = `${machine.type ?? "registered"}:${machine.name ?? machine.hostname ?? machine.machineId}`;
    const existing = byId.get(key);
    if (!existing || (!existing.online && machine.online)) byId.set(key, machine);
  }
  return [...byId.values()];
};

const groupProjectsByMachine = (projects: ProjectSummary[], machines: MachineSummary[]): ProjectMachineGroup[] => {
  const machinesById = new Map(machines.map((machine) => [machine.machineId, machine]));
  const groups = new Map<string, ProjectMachineGroup>();
  for (const machine of machines) {
    if (!machine.online) continue;
    groups.set(machine.machineId, {
      key: machine.machineId,
      label: machine.name ?? machine.hostname,
      online: machine.online,
      projectLauncher: machineProjectLauncher(machine),
      statusLabel: machine.online ? "ready" : "offline",
      projects: []
    });
  }
  for (const project of projects) {
    const machine = machinesById.get(project.machineId) ?? project.machine;
    const label = machine
      ? machine.name ?? machine.hostname
      : project.machineId;
    const online = Boolean(machine && "online" in machine ? machine.online : project.machineOnline);
    let group = groups.get(project.machineId);
    if (!group) {
      group = {
        key: project.machineId,
        label,
        online,
        projectLauncher: machineProjectLauncher(machine),
        statusLabel: online ? "online" : "offline",
        projects: []
      };
      groups.set(project.machineId, group);
    }
    group.online = group.online || online;
    group.projectLauncher = group.projectLauncher || machineProjectLauncher(machine);
    if (group.label === project.machineId && label !== project.machineId) group.label = label;
    group.projects.push(project);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      statusLabel: projectMachineStatus(group),
      projects: [...group.projects].sort((left, right) => {
        return compareProjectRows(left, right);
      })
    }))
    .sort((left, right) => Number(right.online) - Number(left.online) || left.label.localeCompare(right.label));
};

const projectMachineStatus = (group: Pick<ProjectMachineGroup, "online" | "projectLauncher" | "projects">) => {
  const onlineProjects = group.projects.filter((project) => project.runtime?.online).length;
  if (!group.online) return "offline";
  if (!group.projectLauncher) return "session";
  if (onlineProjects) return `${onlineProjects}/${group.projects.length} active`;
  return "ready";
};

const machineProjectLauncher = (machine: MachineSummary | StoredMachineLike | undefined) =>
  machine?.capabilities?.projectLauncher !== false;

type StoredMachineLike = {
  capabilities?: {
    projectLauncher?: boolean;
  };
};

const compareProjectRows = (left: ProjectSummary, right: ProjectSummary) => {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  const createdCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdCompare) return createdCompare;
  const nameCompare = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  if (nameCompare) return nameCompare;
  return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
};

const projectKeyFor = (machineId: string, projectPath: string) => `${machineId}:${projectPath}`;

const projectKeyForProject = (project: Pick<ProjectSummary, "machineId" | "path">) =>
  projectKeyFor(project.machineId, project.path);

const basename = (projectPath: string) => projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath;

const projectStatusLabel = (project: ProjectSummary) => {
  if (project.running) return "running";
  if (project.runtime?.online) return "runtime";
  if (project.machineOnline || (project.machine && "online" in project.machine && project.machine.online)) return "ready";
  return "offline";
};

const sshHostMeta = (host: SshHost) => [
  host.user,
  host.hostName,
  host.port ? `:${host.port}` : null,
  host.proxyJump ? `via ${host.proxyJump}` : null
].filter(Boolean).join(" ") || host.alias;

type SshConnectionStatusLabel = "ready" | "starting" | "connected" | "failed" | "stopped" | "missing";

const latestSshConnectionForHost = (connections: SshConnection[], host: string) =>
  connections
    .filter((connection) => connection.host === host)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

const activeSshConnectionForHost = (connections: SshConnection[], host: string) =>
  latestSshConnectionForHost(connections.filter((connection) => connection.status !== "exited"), host);

const sshConnectionStatusLabel = (
  connection: SshConnection | undefined,
  connecting: boolean,
  configured: boolean
): SshConnectionStatusLabel => {
  if (connecting) return "starting";
  if (connection?.status === "starting") return "starting";
  if (connection?.status === "running") return "connected";
  if (connection?.status === "exited") return sshConnectionStoppedCleanly(connection) ? "stopped" : "failed";
  return configured ? "ready" : "missing";
};

const sshConnectionStatusClass = (status: SshConnectionStatusLabel) =>
  status === "connected" ? "online connected" : status;

const sshConnectionStoppedCleanly = (connection: SshConnection) =>
  connection.status === "exited"
  && (connection.exitCode === 0 || connection.signal === "SIGTERM" || connection.signal === "SIGKILL");

const sshConnectionDetail = (host: SshHost, connection: SshConnection | undefined) => {
  const lastLine = compactSshOutput(connection?.lastOutput);
  if (connection?.status === "exited" && lastLine) return lastLine;
  if (host.configured === false) return "not found in SSH config";
  return sshHostMeta(host);
};

const sshConnectionTitle = (host: SshHost, connection: SshConnection | undefined) => {
  if (!connection) return host.configured === false ? "SSH config entry missing" : "Ready to connect";
  const status = sshConnectionStatusLabel(connection, false, host.configured !== false);
  const lastLine = compactSshOutput(connection.lastOutput);
  const updated = connection.updatedAt ? `updated ${relativeTime(connection.updatedAt)}` : "";
  return [status, updated, lastLine ? `last output: ${lastLine}` : ""].filter(Boolean).join("; ");
};

const compactSshOutput = (value: string | undefined) =>
  value?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 180) ?? "";

const runtimeSessionStatusTitle = (session: RuntimeSession) => {
  if (session.online) return "Runtime session online";
  const reason = session.offlineReason === "heartbeat_timeout"
    ? "heartbeat timeout"
    : session.offlineReason === "transport_disconnected"
      ? "connection lost"
      : "recently disconnected";
  const lastSeen = session.lastSeenAt ? `, last seen ${relativeTime(session.lastSeenAt)}` : "";
  return `Session disconnected: ${reason}${lastSeen}`;
};

const relativeTime = (iso: string | undefined) => {
  if (!iso) return "unknown";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const formatGoalAge = (iso: string) => {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

const goalStatusLabel = (status: string) => {
  if (status === "paused") return "暂停的目标";
  if (status === "complete") return "完成的目标";
  if (status === "blocked") return "阻塞的目标";
  if (status === "usageLimited") return "受限的目标";
  if (status === "budgetLimited") return "预算受限的目标";
  return "进行中的目标";
};

const goalStatusClass = (status: string) => {
  if (status === "paused") return "paused";
  if (status === "complete") return "complete";
  if (status === "blocked" || status === "usageLimited" || status === "budgetLimited") return "blocked";
  return "active";
};

const threadCandidateTitle = (candidate: CodexThreadCandidate) =>
  compactLine(candidate.firstUserMessage || candidate.lastAssistantMessage || shortId(candidate.threadId));

const formatThreadCandidateTime = (value: string) => relativeTime(value);

const compactLine = (value: string) => value.replace(/\s+/g, " ").trim();

const threadDisplayTitle = (thread: Pick<ThreadSummary, "threadId" | "title">) => {
  const title = compactLine(thread.title);
  const threadShortId = shortId(thread.threadId);
  return title && title !== thread.threadId && title !== threadShortId ? title : "new";
};

const appendThreadOrder = (current: Record<string, string[]>, sessionId: string, threadId: string) => {
  const existing = current[sessionId] ?? [];
  if (existing.includes(threadId)) return current;
  return { ...current, [sessionId]: [...existing, threadId] };
};

const removeThreadOrder = (current: Record<string, string[]>, threadId: string) => {
  const next: Record<string, string[]> = {};
  for (const [sessionId, threadIds] of Object.entries(current)) {
    const filtered = threadIds.filter((item) => item !== threadId);
    if (filtered.length) next[sessionId] = filtered;
  }
  return next;
};

const mergeThreadOrderByRuntimeSession = (current: Record<string, string[]>, runtimeSessions: RuntimeSession[]) => {
  const next: Record<string, string[]> = {};
  for (const session of runtimeSessions) {
    const threadIds = sessionThreadIds(session);
    const liveThreadIds = new Set(threadIds);
    const existing = (current[session.sessionId] ?? []).filter((threadId) => liveThreadIds.has(threadId));
    const appended = threadIds.filter((threadId) => !existing.includes(threadId));
    next[session.sessionId] = [...existing, ...appended];
  }
  return next;
};

const sessionThreadIds = (session: RuntimeSession) => {
  const threadIds: string[] = [];
  const pushThreadId = (threadId?: string) => {
    if (threadId && !threadIds.includes(threadId)) threadIds.push(threadId);
  };
  for (const thread of session.threads ?? []) pushThreadId(thread.threadId);
  return threadIds;
};

const preferredThreadIdForRuntimeSession = (session: RuntimeSession, project?: ProjectSummary) => {
  const sessionThreadIds = new Set((session.threads ?? []).map((thread) => thread.threadId));
  if (project?.lastThreadId && sessionThreadIds.has(project.lastThreadId)) return project.lastThreadId;
  return session.threads?.[0]?.threadId
    ?? project?.lastThreadId
    ?? project?.threads?.[0]?.threadId
    ?? project?.storedThreads?.[0]?.threadId
    ?? "";
};

const adjacentThreadId = (threadIds: string[], threadId: string) => {
  const index = threadIds.indexOf(threadId);
  if (index === -1) return threadIds.find((item) => item !== threadId) ?? "";
  return threadIds[index + 1] ?? threadIds[index - 1] ?? "";
};

const patchRuntimeSessionsThread = (runtimeSessions: RuntimeSession[], thread: ThreadSummary) =>
  runtimeSessions.map((session) => {
    if (session.sessionId !== thread.runtime.sessionId) return session;
    return {
      ...session,
      threads: upsertThreadSummary(session.threads ?? [], thread)
    };
  });

const patchProjectsThread = (projects: ProjectSummary[], thread: ThreadSummary) =>
  projects.map((project) => {
    const matchesSession = Boolean(thread.runtime.sessionId && project.runtime?.sessionId === thread.runtime.sessionId);
    const matchesPath = project.path === thread.workingDirectory;
    if (!matchesSession && !matchesPath) return project;
    const threads = upsertThreadSummary(project.threads ?? [], thread);
    const runtime = matchesSession && project.runtime
      ? {
        ...project.runtime,
        threads: upsertThreadSummary(project.runtime.threads ?? [], thread)
      }
      : project.runtime;
    return {
      ...project,
      lastThreadId: thread.threadId,
      running: threads.some((item) => item.running || item.status === "running"),
      runtime,
      threads
    };
  });

const removeRuntimeSessionsThread = (runtimeSessions: RuntimeSession[], threadId: string) =>
  runtimeSessions.map((session) => ({
    ...session,
    threads: (session.threads ?? []).filter((thread) => thread.threadId !== threadId)
  }));

const removeProjectsThread = (projects: ProjectSummary[], threadId: string) =>
  projects.map((project) => {
    const threads = (project.threads ?? []).filter((thread) => thread.threadId !== threadId);
    const runtime = project.runtime
      ? {
        ...project.runtime,
        threads: (project.runtime.threads ?? []).filter((thread) => thread.threadId !== threadId)
      }
      : project.runtime;
    const sessions = (project.sessions ?? []).map((session) => ({
      ...session,
      threads: (session.threads ?? []).filter((thread) => thread.threadId !== threadId)
    }));
    return {
      ...project,
      lastThreadId: project.lastThreadId === threadId ? threads[0]?.threadId : project.lastThreadId,
      running: threads.some((thread) => thread.running || thread.status === "running"),
      runtime,
      sessions,
      threads
    };
  });

const upsertThreadSummary = (threads: ThreadSummary[], thread: ThreadSummary) => {
  const byId = new Map(threads.map((item) => [item.threadId, item]));
  byId.set(thread.threadId, { ...byId.get(thread.threadId), ...thread });
  return [...byId.values()].sort((left, right) => {
    return Number(right.running) - Number(left.running)
      || right.updatedAt.localeCompare(left.updatedAt);
  });
};

const selectedThreadOptions = (
  model: ModelSelection,
  reasoning: ReasoningSelection,
  composerMode: ComposerMode
) => ({
  model: model === "auto" ? null : model,
  modelReasoningEffort: reasoning === "auto" ? null : reasoning,
  ...(composerMode === "plan" ? { collaborationMode: "plan" as const } : {}),
  ...(composerMode === "goal" ? { goalMode: true } : {})
});

const isModelCommand = (text: string) => /^\/model\s*$/i.test(text);

const rawModelLabel = (model: ModelSelection) => model === "auto" ? "Auto" : model;

const modelOptionLabel = (option: { value: ModelSelection; label: string }) =>
  option.value === "auto" ? option.label : option.value;

const reasoningOptionLabel = (option: { value: ReasoningSelection; label: string }) =>
  option.value === "auto" ? option.label : option.value;

const modelOptionsForSelection = (model: ModelSelection) => {
  if (!model || modelOptions.some((option) => option.value === model)) return modelOptions;
  return [...modelOptions, { value: model, label: model }];
};

const latestThreadUsageFromRecords = (records: CodexRecord[]): ThreadUsage | null => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const usage = threadUsageFromRecord(records[index]);
    if (usage) return usage;
  }
  return null;
};

const mergeThreadUsage = (latest: ThreadUsage | null, fallback: ThreadUsage | null): ThreadUsage | null => {
  if (!latest) return fallback;
  if (!fallback) return latest;
  return {
    context: latest.context ?? fallback.context,
    primaryRateLimit: latest.primaryRateLimit ?? fallback.primaryRateLimit,
    secondaryRateLimit: latest.secondaryRateLimit ?? fallback.secondaryRateLimit,
    observedAt: latest.observedAt ?? fallback.observedAt
  };
};

const latestRuntimeConfigFromRecords = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const config = runtimeConfigFromRecord(records[index]);
    if (config.model || config.reasoning) return config;
  }
  return null;
};

const latestThreadGoalFromRecords = (records: CodexRecord[], threadId?: string): ThreadGoalView | null => {
  const clearedAt = latestThreadGoalClearedAt(records, threadId);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = asRecord(records[index].payload);
    const type = typeof payload?.type === "string" ? payload.type : "";
    if (type === "thread_goal_cleared") {
      if (goalRecordMatchesThread(payload, null, threadId)) return null;
      continue;
    }
    if (type !== "thread_goal_updated") continue;
    if (!payload) return null;
    const goal = asRecord(payload.goal);
    if (!goalRecordMatchesThread(payload, goal, threadId)) continue;
    if (clearedAt !== null) {
      const goalCreatedAt = goalTimeMs(goal?.createdAt) ?? goalTimeMs(goal?.created_at);
      const recordTime = recordTimestampMs(records[index]);
      const isOldGoal = goalCreatedAt !== null ? goalCreatedAt <= clearedAt : recordTime !== null && recordTime <= clearedAt;
      if (isOldGoal) continue;
    }
    const objective = typeof goal?.objective === "string" ? compactLine(goal.objective) : "";
    if (!objective) return null;
    const status = typeof goal?.status === "string" ? goal.status : "active";
    if (status === "complete") return null;
    const tokenBudget = typeof goal?.tokenBudget === "number"
      ? goal.tokenBudget
      : typeof goal?.token_budget === "number"
        ? goal.token_budget
        : undefined;
    const updatedAt = records[index].timestamp
      ?? (typeof goal?.updatedAt === "number" ? new Date(goal.updatedAt * 1000).toISOString() : undefined)
      ?? (typeof goal?.updated_at === "number" ? new Date(goal.updated_at * 1000).toISOString() : undefined);
    return { objective, status, tokenBudget, updatedAt };
  }
  return null;
};

const latestThreadGoalClearedAt = (records: CodexRecord[], threadId?: string) => {
  let latest: number | null = null;
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (payload?.type !== "thread_goal_cleared" || !goalRecordMatchesThread(payload, null, threadId)) continue;
    const time = recordTimestampMs(record);
    if (time !== null && (latest === null || time > latest)) latest = time;
  }
  return latest;
};

const goalRecordMatchesThread = (
  payload: Record<string, unknown> | null,
  goal: Record<string, unknown> | null,
  threadId: string | undefined
) => {
  if (!threadId) return true;
  const payloadThreadId = stringField(payload, "threadId") ?? stringField(payload, "thread_id");
  const goalThreadId = stringField(goal, "threadId") ?? stringField(goal, "thread_id");
  return payloadThreadId === threadId || goalThreadId === threadId || (!payloadThreadId && !goalThreadId);
};

const recordTimestampMs = (record: CodexRecord) => {
  const timestamp = Date.parse(record.timestamp ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
};

const goalTimeMs = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const runtimeConfigFromRecord = (record: CodexRecord): { model?: string; reasoning?: ReasoningEffort } => {
  const raw = asRecord(record.rawJsonl);
  const payload = asRecord(raw?.payload) ?? asRecord(record.payload);
  const settings = asRecord(asRecord(payload?.collaboration_mode)?.settings);
  return {
    model: stringField(payload, "model")
      ?? stringField(settings, "model")
      ?? stringField(raw, "model"),
    reasoning: normalizeReasoningEffort(
      stringField(payload, "effort")
      ?? stringField(payload, "reasoning_effort")
      ?? stringField(payload, "model_reasoning_effort")
      ?? stringField(settings, "reasoning_effort")
      ?? stringField(settings, "model_reasoning_effort")
    )
  };
};

const normalizeReasoningEffort = (value: unknown): ReasoningEffort | undefined => {
  if (typeof value !== "string") return undefined;
  return reasoningOptions.some((option) => option.value === value && option.value !== "auto")
    ? value as ReasoningEffort
    : undefined;
};

const formatComposerModelTitle = (
  selectedModel: ModelSelection,
  selectedReasoning: ReasoningSelection,
  runtimeModel: string | null,
  runtimeReasoning: ReasoningEffort | null
) => [
  `selected model ${rawModelLabel(selectedModel)}`,
  runtimeModel ? `runtime model ${rawModelLabel(runtimeModel)}` : null,
  `selected thinking ${selectedReasoning === "auto" ? "Auto" : selectedReasoning}`,
  runtimeReasoning ? `runtime thinking ${runtimeReasoning}` : null
].filter(Boolean).join(" · ");

const formatComposerModelButtonLabel = (
  selectedModel: ModelSelection,
  selectedReasoning: ReasoningSelection,
  runtimeModel: string | null,
  runtimeReasoning: ReasoningEffort | null
) => {
  const model = selectedModel === "auto" && runtimeModel ? runtimeModel : selectedModel;
  const reasoning = runtimeReasoning ?? (selectedReasoning === "auto" ? null : selectedReasoning);
  const label = rawModelLabel(model);
  return reasoning ? `${label}:${reasoning}` : label;
};

const formatContextUsage = (threadUsage: ThreadUsage | null) => {
  const context = threadUsage?.context;
  if (!context) return "--";
  return `${Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))}%`;
};

const formatContextTitle = (threadUsage: ThreadUsage | null) => {
  const context = threadUsage?.context;
  if (!context) return undefined;
  return [
    `${formatCompactNumber(context.usedTokens)} / ${formatCompactNumber(context.windowTokens)} input tokens`,
    threadUsage.observedAt ? `observed ${formatDate(threadUsage.observedAt)}` : null
  ].filter(Boolean).join(" · ");
};

const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

const formatMessageMeta = (message: CodexRecordView, options: { showTimestamp?: boolean } = {}) => [
  options.showTimestamp === false ? null : message.at ? formatMessageTime(message.at) : null,
  message.usage ? `${formatCompactNumber(usageTotal(message.usage))} tokens` : null
].filter(Boolean).join(" · ");

const formatMessageMetaTitle = (message: CodexRecordView, options: { showTimestamp?: boolean } = {}) => {
  const timestamp = options.showTimestamp === false ? null : message.at;
  if (!message.usage) return timestamp ? formatDate(timestamp) : undefined;
  return [
    timestamp ? formatDate(timestamp) : null,
    `input ${formatCompactNumber(message.usage.input_tokens)}`,
    `cached ${formatCompactNumber(message.usage.cached_input_tokens)}`,
    `output ${formatCompactNumber(message.usage.output_tokens)}`,
    `reasoning ${formatCompactNumber(message.usage.reasoning_output_tokens)}`
  ].filter(Boolean).join(" · ");
};

const formatMessageTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const usageTotal = (usage: Usage) =>
  usage.total_tokens ?? usage.input_tokens + usage.output_tokens + usage.reasoning_output_tokens;

const formatRateLimitRemaining = (window: RateLimitWindow | null | undefined) => {
  if (!window) return "--";
  return `${formatPercent(100 - window.usedPercent)}`;
};

const formatPercent = (value: number) => {
  if (!Number.isFinite(value)) return "--";
  const normalized = Math.max(0, Math.min(100, value));
  return `${Number.isInteger(normalized) ? normalized : normalized.toFixed(1)}%`;
};

const formatResetTitle = (window: RateLimitWindow | null | undefined) => {
  if (!window) return undefined;
  const resetAt = new Date(window.resetsAt * 1000);
  if (Number.isNaN(resetAt.getTime())) return undefined;
  return [
    `${formatPercent(100 - window.usedPercent)} remaining`,
    `${formatPercent(window.usedPercent)} used`,
    `${window.windowMinutes}m window`,
    `resets ${resetAt.toLocaleString()}`
  ].join(", ");
};

const mergeRecord = (records: CodexRecord[], incoming: CodexRecord) => {
  const existingIndex = records.findIndex((record) => record.id === incoming.id);
  if (existingIndex === -1) {
    return [
      ...records.filter((record) => !isMatchingOptimisticUserRecord(record, incoming) && !isMatchingAppServerTranscriptRecord(record, incoming)),
      incoming
    ];
  }
  return records.map((record, index) => index === existingIndex ? incoming : record);
};

const combineRecordSources = (left: CodexRecord[], right: CodexRecord[]) => {
  if (!left.length) return right;
  if (!right.length) return left;
  const byId = new Map<string, CodexRecord>();
  for (const record of left) byId.set(record.id, record);
  for (const record of right) byId.set(record.id, record);
  return [...byId.values()].sort((a, b) => recordSortValue(a) - recordSortValue(b));
};

const recordSortValue = (record: CodexRecord) => {
  const timestamp = Date.parse(record.timestamp ?? "");
  if (Number.isFinite(timestamp)) return timestamp;
  if (typeof record.order === "number") return record.order;
  if (typeof record.line === "number") return record.line;
  return 0;
};

const mergeThreadJsonl = (current: ThreadJsonl | undefined, event: StreamEvent): ThreadJsonl | undefined => {
  if (event.kind === "jsonl_snapshot") return normalizeThreadJsonl(event.jsonl);
  if (event.kind !== "jsonl_append" || !event.jsonl) return current;
  const append = normalizeThreadJsonl(event.jsonl);
  if (!append) return current;
  const byLine = new Map<number, JsonlLine>();
  for (const line of current?.lines ?? []) byLine.set(line.line, line);
  for (const line of append.lines) byLine.set(line.line, line);
  return {
    path: append.path ?? current?.path,
    lastLine: append.lastLine,
    lines: [...byLine.values()].sort((left, right) => left.line - right.line)
  };
};

const normalizeThreadJsonl = (jsonl: ThreadJsonl | undefined): ThreadJsonl | undefined => {
  if (!jsonl) return undefined;
  const lines = new Map<number, JsonlLine>();
  for (const line of jsonl.lines ?? []) {
    if (!Number.isInteger(line.line) || line.line < 1 || typeof line.text !== "string") continue;
    lines.set(line.line, { line: line.line, text: line.text });
  }
  return {
    path: jsonl.path,
    lastLine: Number.isInteger(jsonl.lastLine) ? jsonl.lastLine : [...lines.keys()].at(-1) ?? 0,
    lines: [...lines.values()].sort((left, right) => left.line - right.line)
  };
};

const threadRecordsForNotifications = (threadId: string, thread: ThreadDetail) =>
  thread.jsonl?.lines.length ? jsonlLinesToRecords(threadId, thread.jsonl) : thread.records;

const streamEventRecords = (event: StreamEvent): CodexRecord[] => {
  if (event.record) return [event.record];
  if (!event.jsonl || (event.kind !== "jsonl_append" && event.kind !== "jsonl_snapshot")) return [];
  return jsonlLinesToRecords(event.thread.threadId, event.jsonl);
};

const mergeNotificationRecords = (
  current: CodexRecord[],
  event: StreamEvent,
  incomingRecords: CodexRecord[]
) => {
  if (event.kind === "jsonl_snapshot") return incomingRecords;
  return incomingRecords.reduce((records, record) => mergeRecord(records, record), current);
};

const isTaskCompleteRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return record.type === "event_msg" && payload?.type === "task_complete";
};

const taskCompletionNotificationKey = (threadId: string, record: CodexRecord) => {
  const payload = asRecord(record.payload);
  const turnId = stringField(payload, "turn_id") ?? stringField(payload, "turnId");
  return turnId ? `${threadId}:${turnId}` : `${threadId}:${record.id}`;
};

const taskCompleteNotification = (
  thread: ThreadSummary,
  record: CodexRecord,
  records: CodexRecord[]
): TaskCompleteNotification => {
  const payload = asRecord(record.payload);
  const durationMs = typeof payload?.duration_ms === "number" ? payload.duration_ms : undefined;
  const duration = typeof durationMs === "number" ? formatStatusDuration(durationMs) : undefined;
  const message = usefulTaskCompleteMessage(payload)
    ?? latestFinalAnswerText(records, record)
    ?? "Task completed.";
  return {
    title: duration ? `Codex task complete · 运行时间 ${duration}` : "Codex task complete",
    body: notificationText(message),
    threadId: thread.threadId,
    duration
  };
};

const usefulTaskCompleteMessage = (payload: Record<string, unknown> | null | undefined) => {
  const lastAgentMessage = stringField(payload, "last_agent_message") ?? stringField(payload, "lastAgentMessage");
  if (lastAgentMessage) return lastAgentMessage;
  const message = stringField(payload, "message");
  if (!message || /^(task|turn)?\s*completed\.?$/i.test(message.trim())) return null;
  return message;
};

const latestFinalAnswerText = (records: CodexRecord[], taskRecord: CodexRecord) => {
  const taskPayload = asRecord(taskRecord.payload);
  const taskTurnId = stringField(taskPayload, "turn_id") ?? stringField(taskPayload, "turnId");
  const taskOrder = recordSortValue(taskRecord);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const recordTurnId = turnIdFromRecord(record);
    if (recordSortValue(record) > taskOrder) continue;
    if (taskTurnId && recordTurnId && recordTurnId !== taskTurnId) continue;
    const text = finalAnswerTextFromRecord(record);
    if (text) return text;
  }
  return null;
};

const finalAnswerTextFromRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return null;
  if (
    record.type === "event_msg"
    && payload.type === "agent_message"
    && payload.phase === "final_answer"
  ) {
    return stringField(payload, "message") ?? null;
  }
  if (
    record.type === "response_item"
    && payload.type === "message"
    && payload.role === "assistant"
    && payload.phase === "final_answer"
  ) {
    return messageTextFromPayload(payload);
  }
  return null;
};

const messageTextFromPayload = (payload: Record<string, unknown>) => {
  const direct = stringField(payload, "message") ?? stringField(payload, "text");
  if (direct) return direct;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts = content.flatMap((item) => {
    const record = asRecord(item);
    return stringField(record, "text")
      ?? stringField(record, "input_text")
      ?? stringField(record, "output_text")
      ?? [];
  });
  return parts.length ? parts.join("\n") : null;
};

const turnIdFromRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return stringField(payload, "turn_id")
    ?? stringField(payload, "turnId")
    ?? (typeof record.id === "string" ? record.id.match(/^app:[^:]+:([^:]+):/)?.[1] : undefined);
};

const notificationText = (value: string) => {
  const text = compactLine(value);
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
};

const primeTaskCompletionSound = (audioContextRef: React.MutableRefObject<AudioContext | null>) => {
  const context = ensureNotificationAudioContext(audioContextRef);
  if (!context || context.state === "closed") return;
  if (context.state === "suspended") void context.resume().catch(() => undefined);
};

const playTaskCompletionSound = (audioContextRef: React.MutableRefObject<AudioContext | null>) => {
  const context = ensureNotificationAudioContext(audioContextRef);
  if (!context || context.state === "closed") return;
  const play = () => {
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);

    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.setValueAtTime(1174.66, now + 0.13);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.36);
  };

  if (context.state === "suspended") {
    void context.resume().then(play).catch(() => undefined);
    return;
  }
  play();
};

const ensureNotificationAudioContext = (audioContextRef: React.MutableRefObject<AudioContext | null>) => {
  if (audioContextRef.current && audioContextRef.current.state !== "closed") return audioContextRef.current;
  const AudioContextConstructor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  audioContextRef.current = new AudioContextConstructor();
  return audioContextRef.current;
};

const primeTaskNotificationPermission = () => {
  if (isVscodeSurface) return;
  const NotificationApi = window.Notification;
  if (!NotificationApi || NotificationApi.permission !== "default") return;
  void NotificationApi.requestPermission().catch(() => undefined);
};

const isSimpleRecord = (record: CodexRecord) => {
  if (record.type === "response_item") return true;
  const payload = asRecord(record.payload);
  return record.type === "event_msg" && payload?.type === "token_count";
};

const isSimpleMainView = (view: CodexRecordView) => {
  const payload = asRecord(view.record.payload);
  if (view.record.type !== "response_item") return false;
  if (payload?.type === "file_change") return false;
  if (payload?.type !== "message") return true;
  return payload.role === "user" || payload.role === "assistant";
};

const latestUserTurnStatusScope = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!isUserInputRecord(records[index])) continue;
    const record = records[index];
    return {
      key: record.id,
      label: `after ${formatStatusScopeTime(record.timestamp)}`,
      records: records.slice(index + 1)
    };
  }
  return {
    key: "thread",
    label: "thread status",
    records
  };
};

const isUserInputRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return false;
  if (record.type === "event_msg") return payload.type === "user_message";
  return record.type === "response_item" && payload.type === "message" && payload.role === "user";
};

const formatStatusScopeTime = (timestamp: string | undefined) =>
  timestamp ? `user message at ${formatDate(timestamp)}` : "latest user message";

const runtimeStatusesFromRecords = (records: CodexRecord[]): RuntimeStatusView[] => {
  const statuses = new Map<string, RuntimeStatusView>();
  let fileStatus: RuntimeStatusView | null = null;
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type === "response_item" && payload?.type === "file_change") {
      fileStatus = mergeFileChangeStatus(fileStatus, fileChangeRuntimeStatus(record, payload));
      continue;
    }
    const status = runtimeStatusFromRecord(record);
    if (status) statuses.set(status.key, status);
  }
  if (fileStatus) statuses.set(fileStatus.key, fileStatus);
  return [...statuses.values()].sort((left, right) => runtimeStatusPriority(left.key) - runtimeStatusPriority(right.key));
};

const latestTurnStatusFromRecords = (records: CodexRecord[]): RuntimeStatusView | null => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const status = runtimeStatusFromRecord(records[index]);
    if (status?.key === "turn") return status;
  }
  return null;
};

const runtimeStatusFromRecord = (record: CodexRecord): RuntimeStatusView | null => {
  const payload = asRecord(record.payload);
  const type = typeof payload?.type === "string" ? payload.type : "";
  if (record.type !== "event_msg") return null;
  if (!payload || type === "user_message" || type === "agent_message" || type === "patch_apply_end") return null;
  if (type === "session_meta" || type === "turn_context") return null;

  if (type === "task_started") {
    return {
      key: "turn",
      label: "Running",
      status: "pending",
      at: record.timestamp,
      text: [
        stringField(payload, "turn_id") ? `turn ${shortId(stringField(payload, "turn_id") ?? "")}` : null,
        typeof payload.collaboration_mode_kind === "string" ? payload.collaboration_mode_kind : null,
        typeof payload.model_context_window === "number" ? `context ${formatCompactNumber(payload.model_context_window)}` : null
      ].filter(Boolean).join(" · ") || "Codex is running"
    };
  }

  if (type === "task_complete") {
    return {
      key: "turn",
      label: "Done",
      status: "completed",
      at: record.timestamp,
      text: [
        typeof payload.duration_ms === "number" ? `duration ${formatStatusDuration(payload.duration_ms)}` : null,
        typeof payload.time_to_first_token_ms === "number" ? `first token ${formatStatusDuration(payload.time_to_first_token_ms)}` : null
      ].filter(Boolean).join(" · ") || "Turn completed"
    };
  }

  if (type === "turn_aborted") {
    return {
      key: "turn",
      label: "Aborted",
      status: "failed",
      at: record.timestamp,
      text: [
        typeof payload.reason === "string" ? payload.reason : null,
        typeof payload.duration_ms === "number" ? `duration ${formatStatusDuration(payload.duration_ms)}` : null
      ].filter(Boolean).join(" · ") || "Turn aborted"
    };
  }

  if (type === "token_count") {
    return {
      key: "usage",
      label: "Usage",
      status: "completed",
      at: record.timestamp,
      text: formatTokenStatus(payload)
    };
  }

  if (type === "thread_goal_updated") {
    const goal = asRecord(payload.goal);
    return {
      key: "goal",
      label: "Goal",
      status: goal?.status === "complete" ? "completed" : "pending",
      at: record.timestamp,
      text: [
        typeof goal?.status === "string" ? goal.status : "active",
        typeof goal?.objective === "string" ? goal.objective : null
      ].filter(Boolean).join(" · ") || "Goal updated"
    };
  }

  if (type === "thread_goal_cleared") {
    return { key: "goal", label: "Goal", status: "completed", at: record.timestamp, text: "Goal cleared" };
  }

  if (type === "context_compaction" || type === "context_compacted" || type === "compacted") {
    return { key: "context", label: "Context", status: "completed", at: record.timestamp, text: "Context compacted" };
  }

  if (type === "thread_rolled_back") {
    const turns = typeof payload.num_turns === "number" ? payload.num_turns : undefined;
    return {
      key: "rollback",
      label: "Rollback",
      status: "completed",
      at: record.timestamp,
      text: turns ? `Rolled back ${turns} turn${turns === 1 ? "" : "s"}` : "Thread rolled back"
    };
  }

  if (type === "item_completed") {
    const item = asRecord(payload.item);
    return {
      key: "item",
      label: "Item",
      status: "completed",
      at: record.timestamp,
      text: `Completed ${typeof item?.type === "string" ? item.type : "item"}`
    };
  }

  return {
    key: `event:${type || "unknown"}`,
    label: type || "Event",
    at: record.timestamp,
    text: typeof payload.message === "string" ? payload.message : stringifyInspectJson(payload)
  };
};

const fileChangeRuntimeStatus = (record: CodexRecord, payload: Record<string, unknown>): RuntimeStatusView => {
  const files = fileChangePreviewFiles(payload);
  const changed = files.length;
  const added = files.reduce((total, file) => total + (file.added ?? 0), 0);
  const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0);
  return {
    key: "files",
    label: "Files",
    status: payload.status === "failed" ? "failed" : "completed",
    at: record.timestamp,
    text: [
      typeof payload.status === "string" ? payload.status : "completed",
      changed ? `${changed} file${changed === 1 ? "" : "s"}` : "files changed",
      fileChangeTotalsText(added, removed)
    ].filter(Boolean).join(" · "),
    files
  };
};

const mergeFileChangeStatus = (
  current: RuntimeStatusView | null,
  incoming: RuntimeStatusView
): RuntimeStatusView => {
  if (!current) return incoming;
  const filesByPath = new Map<string, RuntimeStatusFile>();
  for (const file of [...current.files ?? [], ...incoming.files ?? []]) {
    const existing = filesByPath.get(file.path);
    filesByPath.set(file.path, {
      path: file.path,
      added: (existing?.added ?? 0) + (file.added ?? 0),
      removed: (existing?.removed ?? 0) + (file.removed ?? 0)
    });
  }
  const files = [...filesByPath.values()];
  const added = files.reduce((total, file) => total + (file.added ?? 0), 0);
  const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0);
  const failed = current.status === "failed" || incoming.status === "failed";
  return {
    ...incoming,
    status: failed ? "failed" : "completed",
    text: [
      failed ? "failed" : "completed",
      files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "files changed",
      fileChangeTotalsText(added, removed)
    ].filter(Boolean).join(" · "),
    files
  };
};

const fileChangeTotalsText = (added: number, removed: number) => [
  `+${added}`,
  `-${removed}`
].filter(Boolean).join(" ");

const runtimeStatusPriority = (key: string) => {
  const order: Record<string, number> = {
    turn: 0,
    goal: 1,
    usage: 2,
    files: 3,
    context: 4,
    rollback: 5,
    item: 6
  };
  return order[key] ?? 10;
};

const runtimeStatusOverlayClass = (statuses: RuntimeStatusView[]) => {
  if (statuses.some((status) => status.status === "failed")) return "failed";
  if (statuses.some((status) => status.status === "pending")) return "pending";
  if (statuses.some((status) => status.status === "completed")) return "completed";
  return "idle";
};

const runtimeStatusTitle = (statuses: RuntimeStatusView[]) =>
  statuses.map((status) => `${status.label}: ${status.text}`).join("\n");

const turnUiStateFromStatus = (
  turnStatus: RuntimeStatusView | null,
  running: boolean
): TurnUiState => {
  if (running) {
    return {
      kind: "running",
      label: "Running",
      title: turnStatus
        ? `Running · ${turnStatus.text}`
        : "Running current turn"
    };
  }

  if (turnStatus) {
    if (turnStatus.label.toLowerCase().includes("abort")) {
      return {
        kind: "aborted",
        label: "Aborted",
        title: `${turnStatus.label} · ${turnStatus.text}`
      };
    }
    if (turnStatus.status === "failed") {
      return {
        kind: "failed",
        label: turnStatus.label || "Failed",
        title: `${turnStatus.label || "Failed"} · ${turnStatus.text}`
      };
    }
    if (turnStatus.status === "pending") {
      return {
        kind: "running",
        label: turnStatus.label || "Running",
        title: `${turnStatus.label || "Running"} · ${turnStatus.text}`
      };
    }
    if (turnStatus.status === "completed") {
      return {
        kind: "completed",
        label: turnStatus.label || "Done",
        title: `${turnStatus.label || "Done"} · ${turnStatus.text}`
      };
    }
  }

  return {
    kind: "idle",
    label: "Idle",
    title: "Idle"
  };
};

const formatTokenStatus = (payload: Record<string, unknown>) => {
  const info = asRecord(payload.info);
  const usage = asRecord(info?.last_token_usage);
  if (!usage) return "Token usage updated";
  const total = typeof usage.total_tokens === "number" ? `total ${formatCompactNumber(usage.total_tokens)}` : null;
  const input = typeof usage.input_tokens === "number" ? `input ${formatCompactNumber(usage.input_tokens)}` : null;
  const output = typeof usage.output_tokens === "number" ? `output ${formatCompactNumber(usage.output_tokens)}` : null;
  const context = typeof info?.model_context_window === "number" ? `window ${formatCompactNumber(info.model_context_window)}` : null;
  return [total, input, output, context].filter(Boolean).join(" · ") || "Token usage updated";
};

const formatStatusDuration = (value: number) => {
  if (value >= 60_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
};

const stringField = (record: Record<string, unknown> | null | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
};

const isMatchingOptimisticUserRecord = (record: CodexRecord, incoming: CodexRecord) => {
  if (!record.id.startsWith("proxy:user:")) return false;
  const recordPayload = asRecord(record.payload);
  const incomingPayload = asRecord(incoming.payload);
  return record.type === "event_msg"
    && incoming.type === "event_msg"
    && recordPayload?.type === "user_message"
    && incomingPayload?.type === "user_message"
    && recordPayload.message === incomingPayload.message;
};

const isMatchingAppServerTranscriptRecord = (record: CodexRecord, incoming: CodexRecord) => {
  if (
    incoming.type !== "event_msg"
    || record.type !== "event_msg"
    || !incoming.id.startsWith("app:")
    || !record.id.startsWith("app:")
  ) return false;
  const recordPayload = asRecord(record.payload);
  const incomingPayload = asRecord(incoming.payload);
  if (!incomingPayload) return false;
  const incomingType = incomingPayload?.type;
  if (incomingType !== "user_message" && incomingType !== "agent_message") return false;
  if (recordPayload?.type !== incomingType) return false;
  const threadId = String(incoming.sourceThreadId ?? record.sourceThreadId ?? "");
  const incomingTurnId = turnIdFromAppRecordId(threadId, incoming.id);
  const recordTurnId = turnIdFromAppRecordId(threadId, record.id);
  if (incomingTurnId || recordTurnId) return incomingTurnId === recordTurnId && recordTurnId !== null;
  if (recordPayload.message !== incomingPayload.message) return false;
  if (incomingType === "agent_message") return recordPayload.phase === incomingPayload.phase;
  return JSON.stringify(recordPayload.images ?? []) === JSON.stringify(incomingPayload.images ?? []);
};

const formatInspectDetail = (message: WebRecordView): InspectDetail => {
  const inspectRecord = message.inspectRecord ?? message.record;
  const payload = asRecord(inspectRecord.payload);
  const output = normalizeWebToolOutput(message.inspectText ?? (typeof payload?.output === "string" ? payload.output.trimEnd() : ""));
  const toolCall = parseToolCallMessage(message);
  const presenterInspect = toolCall
    ? webToolPresenters[toolCall.name]?.inspect?.(toolCall.args, output)
    : null;
  const raw = formatRawJsonlInspect(inspectRecord);
  if (presenterInspect) return { ...presenterInspect, ...raw };

  const parsedMessageText = shouldExtractMemoryCitation(message)
    ? parseMemoryCitationText(message.inspectCallText ?? message.text)
    : emptyMemoryCitation(message.inspectCallText ?? message.text);
  const callText = parsedMessageText.text;
  return {
    ...formatInspectInput(message.record, callText.trimEnd()),
    memoryCitation: parsedMessageText.entries.length || parsedMessageText.rolloutIds.length ? parsedMessageText : undefined,
    ...formatInspectOutput(message.record, output),
    ...raw
  };
};

const formatInspectTitle = (message: WebRecordView) => {
  const toolCall = parseToolCallMessage(message);
  return toolCall ? `tool: ${toolCall.name}` : message.label;
};

const renderToolMessageBody = (message: WebRecordView, status?: CodexRecordView["status"]) => {
  const toolCall = parseToolCallMessage(message);
  if (toolCall) return webToolPresenters[toolCall.name]?.render?.(toolCall.args, status) ?? null;
  return renderAppServerToolPreview(message, status);
};

const parseToolCallMessage = (message: WebRecordView): ParsedToolCall | null => {
  if (message.role !== "tool") return null;
  const payload = asRecord(message.record.payload);
  if (payload?.type !== "function_call") return null;
  const name = typeof payload.name === "string" ? payload.name : "tool";
  const args = parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "");
  return { name, args: args ?? {} };
};

const renderAppServerToolPreview = (message: WebRecordView, status?: CodexRecordView["status"]) => {
  if (message.role !== "tool") return null;
  const payload = asRecord(message.record.payload);
  if (!payload) return null;

  if (payload.type === "local_shell_call") {
    return (
      <ToolPreview title="tool: shell" status={status} meta={appServerToolMeta(payload)}>
        <pre className="toolCommandLine">{message.text || "$ <empty>"}</pre>
      </ToolPreview>
    );
  }

  if (payload.type === "file_change") {
    return (
      <FileChangePreview payload={payload} status={status} />
    );
  }

  if (payload.type === "web_search_call") {
    return (
      <ToolPreview title="tool: web_search" status={status} meta={appServerToolMeta(payload)}>
        <p className="toolPreviewBody">{typeof payload.query === "string" && payload.query ? payload.query : message.text}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "mcp_tool_call") {
    return (
      <ToolPreview title={`tool: ${mcpToolPreviewName(payload)}`} status={status} meta={appServerToolMeta(payload)}>
        <p className="toolPreviewBody">{message.text || "MCP tool call"}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "image_generation_call") {
    return (
      <ToolPreview title="tool: image_generation" status={status} meta={appServerToolMeta(payload)}>
        <p className="toolPreviewBody">{message.text || "Image generation"}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "function_call_output") {
    return (
      <ToolPreview title="tool result" status={status} meta={appServerToolMeta(payload)}>
        <p className="toolPreviewBody">{message.text || "Completed"}</p>
      </ToolPreview>
    );
  }

  return null;
};

const normalizeWebToolOutput = (output: string) => {
  const parsed = parseJsonObject(output);
  const preview = textPreview(parsed);
  return preview ?? output;
};

const textPreview = (value: unknown) => {
  const record = asRecord(value);
  if (!record || record.text_omitted !== true || typeof record.text_preview !== "string") return null;
  const suffix = typeof record.text_length === "number" ? `\n[output truncated: ${record.text_length} chars]` : "";
  return `${record.text_preview}${suffix}`;
};

const formatInspectOutput = (record: CodexRecord, output: string): Pick<InspectDetail, "outputMeta" | "outputBlockLabel" | "outputBlock"> => {
  const text = output.trimEnd();
  if (!text) return {};
  if (shouldShowRawToolOutput(record)) return formatStructuredToolOutput(text);
  return { outputMeta: formatToolOutputFields(text) ?? text };
};

const formatRawJsonlInspect = (record: CodexRecord): Pick<InspectDetail, "rawBlockLabel" | "rawBlock"> => {
  if (record.rawJsonl == null) return {};
  return {
    rawBlockLabel: record.line ? `JSONL line ${record.line}` : "JSONL",
    rawBlock: stringifyInspectJson(record.rawJsonl)
  };
};

const formatToolOutputFields = (output: string) => {
  const fields = parseJsonObject(output);
  if (!fields) return null;
  return Object.entries(fields).map(([key, value]) => `${key}: ${formatArgumentValue(value)}`).join("\n");
};

const shouldShowRawToolOutput = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return payload?.type === "function_call"
    && (payload.name === "exec_command" || payload.name === "write_stdin");
};

const formatStructuredToolOutput = (output: string): Pick<InspectDetail, "outputMeta" | "outputBlockLabel" | "outputBlock"> => {
  const marker = "\nOutput:\n";
  const index = output.indexOf(marker);
  if (index === -1) return { outputBlockLabel: "Text", outputBlock: output };
  const meta = output.slice(0, index).trimEnd();
  const body = output.slice(index + marker.length).trimEnd();
  return {
    outputMeta: meta,
    outputBlockLabel: "Stdout",
    outputBlock: cleanTerminalOutput(body) || "<empty>"
  };
};

const formatRawToolOutput = (output: string): Pick<InspectDetail, "outputMeta" | "outputBlockLabel" | "outputBlock"> => {
  const text = output.trimEnd();
  return text ? formatStructuredToolOutput(text) : {};
};

const cleanTerminalOutput = (text: string) => text
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[@-Z\\-_]/g, "")
  .replace(/\r\n/g, "\n")
  .replace(/\r/g, "\n");

const formatInspectInput = (record: CodexRecord, fallback: string): Omit<InspectDetail, "output"> => {
  const payload = asRecord(record.payload);
  if (payload?.type !== "function_call") return { inputMeta: fallback };
  const name = typeof payload.name === "string" ? payload.name : "tool";
  const args = parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "");
  if (!args) return { inputMeta: fallback };
  return formatToolInput(name, args);
};

const formatToolInput = (name: string, args: Record<string, unknown>): Omit<InspectDetail, "output"> => {
  if (name === "write_stdin") {
    return {
      inputMeta: [
        `tool: write_stdin`,
        `action: ${describeWriteStdinAction(args)}`,
        typeof args.session_id === "number" || typeof args.session_id === "string" ? `session_id: ${args.session_id}` : null,
        typeof args.yield_time_ms === "number" ? `wait: ${formatMilliseconds(args.yield_time_ms)}` : null,
        typeof args.max_output_tokens === "number" ? `max_output: ${formatCompactNumber(args.max_output_tokens)} tokens` : null
      ].filter((line): line is string => Boolean(line)).join("\n"),
      inputBlockLabel: "Stdin",
      inputBlock: formatWriteStdinBlock(args)
    };
  }
  if (name === "exec_command") {
    return {
      inputMeta: [
        `tool: exec_command`,
        typeof args.workdir === "string" ? `workdir: ${args.workdir}` : null,
        typeof args.yield_time_ms === "number" ? `wait: ${formatMilliseconds(args.yield_time_ms)}` : null,
        typeof args.max_output_tokens === "number" ? `max_output: ${formatCompactNumber(args.max_output_tokens)} tokens` : null
      ].filter((line): line is string => Boolean(line)).join("\n"),
      inputBlockLabel: "Command",
      inputBlock: typeof args.cmd === "string" ? formatCommandBlock(args.cmd) : "<missing>"
    };
  }
  return {
    inputMeta: [
      `tool: ${name}`,
      ...Object.entries(args).map(([key, value]) => `${key}: ${formatArgumentValue(value)}`)
    ].join("\n")
  };
};

const toolPreviewMeta = (args: Record<string, unknown>) => [
  typeof args.workdir === "string" ? args.workdir : null,
  typeof args.yield_time_ms === "number" ? `wait ${formatMilliseconds(args.yield_time_ms)}` : null,
  typeof args.max_output_tokens === "number" ? `max ${formatCompactNumber(args.max_output_tokens)} tokens` : null
].filter((item): item is string => Boolean(item));

const appServerToolMeta = (payload: Record<string, unknown>) => [
  typeof payload.status === "string" ? payload.status : null,
  typeof payload.exit_code === "number" ? `exit ${payload.exit_code}` : null,
  typeof payload.call_id === "string" ? payload.call_id : null,
  Array.isArray(payload.changes) ? `${payload.changes.length} files` : null
].filter((item): item is string => Boolean(item));

type ApplyPatchFile = {
  path: string;
  kind: "add" | "update" | "delete" | "move";
  added: number;
  removed: number;
};

const applyPatchInput = (args: Record<string, unknown>) =>
  typeof args.input === "string"
    ? args.input
    : typeof args.patch === "string"
      ? args.patch
      : "";

const parseApplyPatchFiles = (patch: string): ApplyPatchFile[] => {
  const files: ApplyPatchFile[] = [];
  let current: ApplyPatchFile | null = null;
  const flush = () => {
    if (current) files.push(current);
    current = null;
  };

  for (const line of patch.split(/\r?\n/)) {
    const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (fileMatch) {
      flush();
      current = {
        path: fileMatch[2] ?? "<unknown>",
        kind: applyPatchKind(fileMatch[1]),
        added: 0,
        removed: 0
      };
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (moveMatch && current) {
      current = {
        ...current,
        path: `${current.path} -> ${moveMatch[1]}`,
        kind: "move"
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
  }

  flush();
  return files;
};

const applyPatchKind = (kind: string | undefined): ApplyPatchFile["kind"] => {
  if (kind === "Add") return "add";
  if (kind === "Delete") return "delete";
  return "update";
};

const formatApplyPatchInspect = (args: Record<string, unknown>): InspectDetail => {
  const patch = applyPatchInput(args);
  const files = parseApplyPatchFiles(patch);
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  return {
    inputMeta: [
      "tool: apply_patch",
      files.length ? `files: ${files.length}` : null,
      added ? `added: ${added}` : null,
      removed ? `removed: ${removed}` : null,
      ...files.slice(0, 12).map((file) => `${file.kind}: ${file.path} +${file.added} -${file.removed}`),
      files.length > 12 ? `... ${files.length - 12} more files` : null
    ].filter((line): line is string => Boolean(line)).join("\n"),
    inputBlockLabel: "Patch",
    inputBlock: patch || "<empty>"
  };
};

const fileChangePreviewFiles = (payload: Record<string, unknown>) => {
  if (!Array.isArray(payload.changes)) return [];
  return payload.changes.map((change) => {
    const record = asRecord(change);
    const filePath = typeof record?.path === "string" ? record.path : "<unknown>";
    const stats = diffStats(typeof record?.diff === "string"
      ? record.diff
      : typeof record?.unified_diff === "string" ? record.unified_diff : "");
    return {
      path: filePath,
      ...stats
    };
  });
};

const diffStats = (diffText: string): { added?: number; removed?: number } => {
  if (!diffText) return {};
  let added = 0;
  let removed = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
};

const mcpToolPreviewName = (payload: Record<string, unknown>) => [
  typeof payload.server === "string" ? payload.server : null,
  typeof payload.tool === "string" ? payload.tool : null
].filter(Boolean).join(".") || "mcp";

const formatUpdatePlanInspectInput = (plan: UpdatePlanViewModel) => [
  "tool: update_plan",
  plan.explanation ? `explanation: ${plan.explanation}` : null,
  ...plan.steps.map((step) => `${updatePlanStatusIcon(step.status)} ${step.step} [${updatePlanStatusLabel(step.status)}]`)
].filter((line): line is string => Boolean(line)).join("\n");

const formatWriteStdinSummary = (args: Record<string, unknown>) => {
  const session = typeof args.session_id === "number" || typeof args.session_id === "string" ? `session ${args.session_id}` : "session";
  return `stdin: ${formatWriteStdinChars(args)} -> ${session}`;
};

const describeWriteStdinAction = (args: Record<string, unknown>) => {
  const chars = typeof args.chars === "string" ? args.chars : "";
  if (!chars) return "poll";
  if (chars === "\u0003") return "send Ctrl-C";
  if (chars === "\n") return "send Enter";
  if (chars.length <= 48) return `send ${JSON.stringify(chars)}`;
  return `send ${chars.length} chars`;
};

const formatWriteStdinChars = (args: Record<string, unknown>) => {
  if (typeof args.chars !== "string") return "<missing>";
  if (!args.chars) return "<empty> (poll only; no stdin was written)";
  if (args.chars === "\u0003") return "Ctrl-C (\\u0003)";
  if (args.chars === "\n") return "Enter (\\n)";
  return JSON.stringify(args.chars);
};

const formatWriteStdinBlock = (args: Record<string, unknown>) => {
  if (typeof args.chars !== "string") return "<missing>";
  if (!args.chars) return "<empty> (poll only; no stdin was written)";
  if (args.chars === "\u0003") return "Ctrl-C (\\u0003)";
  if (args.chars === "\n") return "Enter (\\n)";
  return args.chars.trimEnd();
};

const formatCommandBlock = (value: string) => value.trimEnd();

const formatMilliseconds = (value: number) => {
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}s`;
  return `${value}ms`;
};

const formatArgumentValue = (value: unknown) => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "null";
  return JSON.stringify(value);
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

const stringifyInspectJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const clipboardImageFiles = (clipboardData: DataTransfer) => {
  const itemFiles = [...clipboardData.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (itemFiles.length) return itemFiles;
  return [...clipboardData.files].filter((file) => file.type.startsWith("image/"));
};

const composeUserInputText = (typedText: string, textAttachments: TextAttachment[]) => [
  typedText.trim(),
  ...textAttachments.map((item) => normalizeSelectedText(item.text))
].filter(Boolean).join("\n\n");

const normalizeSelectedText = (value: string) =>
  value.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();

const userMessageHistoryFromRecords = (records: CodexRecord[]) => {
  const history: string[] = [];
  for (const view of recordsToViews(records)) {
    if (view.role !== "user") continue;
    const text = normalizeHistoryMessageText(view);
    if (!text || history.at(-1) === text) continue;
    history.push(text);
  }
  return history;
};

const normalizeHistoryMessageText = (view: CodexRecordView) => {
  const text = normalizeSelectedText(view.text);
  if (text === "[image]" && view.attachments?.length) return "";
  return text;
};

const composerCursorOnFirstLine = (textarea: HTMLTextAreaElement) =>
  !textarea.value.slice(0, textarea.selectionStart).includes("\n");

const composerCursorOnLastLine = (textarea: HTMLTextAreaElement) =>
  !textarea.value.slice(textarea.selectionEnd).includes("\n");

const selectedTextWithin = (element: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const selectedText = normalizeSelectedText(selection.toString());
  if (!selectedText) return "";
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (rangeIntersectsElement(selection.getRangeAt(index), element)) return selectedText;
  }
  return "";
};

const rangeIntersectsElement = (range: Range, element: HTMLElement) => {
  try {
    return range.intersectsNode(element);
  } catch {
    const container = range.commonAncestorContainer;
    return element.contains(container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement);
  }
};

const writeTextToClipboard = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy textarea copy path.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
};

const contextMenuPosition = (clientX: number, clientY: number) => {
  const padding = 8;
  const estimatedWidth = 190;
  const estimatedHeight = 128;
  return {
    x: Math.max(padding, Math.min(clientX, window.innerWidth - estimatedWidth - padding)),
    y: Math.max(padding, Math.min(clientY, window.innerHeight - estimatedHeight - padding))
  };
};

const errorRecord = (label: string, error: unknown): CodexRecord => ({
  id: `web:${browserId()}`,
  timestamp: new Date().toISOString(),
  type: "error",
  payload: {
    type: label,
    message: error instanceof Error ? error.message : String(error)
  }
});

const threadGoalClearedRecord = (threadId: string): CodexRecord => ({
  id: `web:goal-cleared:${threadId}:${browserId()}`,
  timestamp: new Date().toISOString(),
  type: "event_msg",
  sourceThreadId: threadId,
  payload: {
    type: "thread_goal_cleared",
    threadId,
    message: "Goal cleared"
  }
});

function browserId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const statusLabel = (status: NonNullable<CodexRecordView["status"]>) => {
  if (status === "pending") return "Waiting";
  if (status === "failed") return "Failed";
  return "Done";
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const isModelSelection = (value: unknown): value is ModelSelection =>
  typeof value === "string" && value.trim().length > 0;

const isReasoningSelection = (value: unknown): value is ReasoningSelection =>
  typeof value === "string" && reasoningOptions.some((option) => option.value === value);

const isMessageDisplayMode = (value: unknown): value is MessageDisplayMode =>
  value === "compact" || value === "detailed";

const readStoredUiState = (): {
  activeWorkspacePath?: string;
  activeSessionId?: string;
  selectedProjectKey?: string;
  selectedModel?: ModelSelection;
  selectedReasoning?: ReasoningSelection;
  messageDisplayMode?: MessageDisplayMode;
  sidebarCollapsed?: boolean;
  collapsedProjectMachineKeys?: string[];
} | null => {
  try {
    const fallback = isVscodeSurface ? null : localStorage.getItem(legacyStorageKey);
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? fallback ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    return {
      activeWorkspacePath: typeof parsed.activeWorkspacePath === "string" ? parsed.activeWorkspacePath : undefined,
      activeSessionId: typeof parsed.activeSessionId === "string"
        ? parsed.activeSessionId
        : typeof parsed.activeWorkerId === "string" ? parsed.activeWorkerId : undefined,
      selectedProjectKey: typeof parsed.selectedProjectKey === "string" ? parsed.selectedProjectKey : undefined,
      selectedModel: isModelSelection(parsed.selectedModel) ? parsed.selectedModel : undefined,
      selectedReasoning: isReasoningSelection(parsed.selectedReasoning) ? parsed.selectedReasoning : undefined,
      messageDisplayMode: isMessageDisplayMode(parsed.messageDisplayMode)
        ? parsed.messageDisplayMode
        : isMessageDisplayMode(parsed.toolDisplayMode) ? parsed.toolDisplayMode : undefined,
      sidebarCollapsed: typeof parsed.sidebarCollapsed === "boolean" ? parsed.sidebarCollapsed : undefined,
      collapsedProjectMachineKeys: Array.isArray(parsed.collapsedProjectMachineKeys)
        ? parsed.collapsedProjectMachineKeys.filter((key: unknown): key is string => typeof key === "string" && key.trim().length > 0)
        : undefined
    };
  } catch {
    return null;
  }
};

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
  <ConfigProvider theme={{ zeroRuntime: true }}>
    <App />
  </ConfigProvider>
);
