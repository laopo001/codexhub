import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { type Components } from "react-markdown";
import { ConfigProvider, Switch, Tabs } from "antd";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";
import remarkGfm from "remark-gfm";
import { asRecord, type CodexRecord } from "../core/codexRecord.js";
import { recordsToViews, type CodexRecordView } from "../core/codexRecordView.js";
import { compactToolViews, type CompactRecordView } from "../shared/compactRecordViews.js";
import { recordsToDetailedViews } from "./detailedRecordViews.js";
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
  lastSeq: number;
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
};

type ImageAttachment = {
  id: string;
  file: File;
  name: string;
  previewUrl: string;
};

type StreamEvent = {
  seq: number;
  kind: "thread" | "record" | "done";
  thread: ThreadSummary;
  record?: CodexRecord;
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
  | ({ type: "thread" | "record" | "done" } & StreamEvent)
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
type MessageDisplayMode = "compact" | "detailed";
type MessageRenderMode = "markdown" | "raw";
type ConnectionMode = "local" | "ssh" | "registered";
type WebRecordView = CompactRecordView;
type InspectDetail = {
  inputMeta: string;
  inputBlockLabel?: string;
  inputBlock?: string;
  outputMeta?: string;
  outputBlockLabel?: string;
  outputBlock?: string;
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

const storageKey = "codexhub-ui-state-v5";
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

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("diff", diff);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("markup", markup);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("yaml", yaml);

const syntaxHighlighterStyle = oneLight as SyntaxHighlighterProps["style"];
const syntaxHighlighterCustomStyle: React.CSSProperties = {
  margin: 0,
  overflow: "visible",
  background: "transparent",
  padding: 0,
  fontSize: "12px",
  lineHeight: 1.55
};
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
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({
    model: null,
    modelReasoningEffort: null,
    contextWindowTokens: null
  });
  const [selectedModel, setSelectedModel] = useState<ModelSelection>("auto");
  const [selectedReasoning, setSelectedReasoning] = useState<ReasoningSelection>("auto");
  const [messageDisplayMode, setMessageDisplayMode] = useState<MessageDisplayMode>("compact");
  const [messageRenderModes, setMessageRenderModes] = useState<Record<string, MessageRenderMode>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [collapsedProjectMachineKeys, setCollapsedProjectMachineKeys] = useState<string[]>([]);
  const [offlineProjectsCollapsed, setOfflineProjectsCollapsed] = useState(true);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
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
  const messagesRef = useRef<VirtuosoHandle>(null);
  const messagesScrollerRef = useRef<HTMLElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.threadId === activeTabThreadId),
    [activeTabThreadId, sessions]
  );
  const activeRuntimeSession = useMemo(
    () => runtimeSessions.find((session) => session.sessionId === activeSessionId),
    [activeSessionId, runtimeSessions]
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
  const projectList = useMemo(() => mergeProjectsWithRuntimeSessions(projects, runtimeSessions), [projects, runtimeSessions]);
  const projectGroups = useMemo(() => groupProjectsByMachine(projectList, machines), [projectList, machines]);
  const selectedProject = useMemo(() => {
    const explicitProject = selectedProjectKey
      ? projectList.find((project) => projectKeyForProject(project) === selectedProjectKey)
      : undefined;
    if (explicitProject) return explicitProject;
    if (activeRuntimeSession) {
      return projectList.find((project) => project.sessions.some((session) => session.sessionId === activeRuntimeSession.sessionId))
        ?? projectList.find((project) => project.machineId === activeRuntimeSession.machineId && project.path === activeRuntimeSession.workingDirectory);
    }
    if (activeSessionId) {
      const sessionProject = projectList.find((project) => project.sessions.some((session) => session.sessionId === activeSessionId));
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
  const activeRuntimeSessionThreadIdsKey = activeRuntimeSessionThreadIds.join("\n");
  const activeRuntimeSessionThreadTabs = useMemo(() => activeRuntimeSessionThreads.map((thread) => {
    const title = thread.title || shortId(thread.threadId);
    return {
      key: thread.threadId,
      label: (
        <span className="workspaceThreadTabLabel" title={`${title}\n${thread.threadId}`}>
          <span>{title}</span>
          <code>{shortId(thread.threadId)}</code>
        </span>
      )
    };
  }), [activeRuntimeSessionThreads]);
  const baseViews = useMemo<CodexRecordView[]>(
    () => recordsToViews(activeSession?.records ?? []),
    [activeSession?.records]
  );
  const detailedViews = useMemo<CodexRecordView[]>(
    () => recordsToDetailedViews(activeSession?.records ?? []),
    [activeSession?.records]
  );
  const activeViews = useMemo<WebRecordView[]>(
    () => messageDisplayMode === "compact" ? compactToolViews(baseViews) : detailedViews,
    [baseViews, detailedViews, messageDisplayMode]
  );
  const latestView = activeViews.at(-1);
  const latestViewKey = latestView
    ? `${latestView.id}:${latestView.status ?? ""}:${latestView.text.length}:${latestView.usage ? usageTotal(latestView.usage) : ""}`
    : "";
  const activeDisplayThreadId = activeSession?.threadId ?? activeTabThreadId;
  const activeThreadBelongsToSession = Boolean(activeSession && activeRuntimeSessionThreads.some((thread) => thread.threadId === activeSession.threadId));
  const activeCanSend = Boolean(
    activeSession
    && activeThreadBelongsToSession
    && activeRuntimeSession?.online
    && (activeSession.input.trim() || activeSession.imageAttachments.length)
  ) && !activeSession?.running;
  const activeCanSubmit = Boolean(activeThreadBelongsToSession && (activeSession?.running || activeCanSend));
  const workspaceEmptyMessage = activeRuntimeSession
    ? activeRuntimeSession.online
      ? activeRuntimeSessionThreads.length ? "Select a thread" : "No threads"
      : "Runtime session disconnected"
    : "No runtime session";
  const runtimeModelOptions = useMemo(() => modelOptionsForSelection(selectedModel), [selectedModel]);
  const activeThreadUsage = activeSession?.threadUsage
    ?? activeRuntimeSessionThreads.find((thread) => thread.threadId === activeTabThreadId)?.threadUsage
    ?? null;
  const renderComposerRuntimeControls = (mode: "inline" | "popover") => (
    <div className={`composerRuntimeControls ${mode}`} aria-label="Runtime usage and model">
      <div className="composerUsagePills" aria-label="Runtime usage">
        <span className="usagePill" title={formatContextTitle(activeThreadUsage)}>
          Context {formatContextUsage(activeThreadUsage)}
        </span>
        <span className="usagePill" title={formatResetTitle(activeThreadUsage?.primaryRateLimit)}>5h {formatRateLimitRemaining(activeThreadUsage?.primaryRateLimit)}</span>
        <span className="usagePill" title={formatResetTitle(activeThreadUsage?.secondaryRateLimit)}>weekly {formatRateLimitRemaining(activeThreadUsage?.secondaryRateLimit)}</span>
      </div>
      <button
        type="button"
        className="composerModelButton"
        onClick={() => {
          setRuntimeMenuOpen(false);
          setRuntimeDialogOpen(true);
        }}
      >
        {modelLabel(selectedModel)}
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
    if (!runtimeSessions.length) {
      if (activeSessionId) setActiveSessionId("");
      if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }

    const selectedProjectSession = selectedProject?.sessions.find((session) => session.online)
      ?? selectedProject?.sessions[0];
    if (selectedProjectKey && selectedProject && activeRuntimeSession && !selectedProject.sessions.some((session) => session.sessionId === activeRuntimeSession.sessionId)) {
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

    const session = activeRuntimeSession ?? runtimeSessions[0];
    if (!activeRuntimeSession) {
      setActiveSessionId(session.sessionId);
      return;
    }

    setActiveWorkspacePath(session.workingDirectory);
    const threadIds = new Set((session.threads ?? []).map((thread) => thread.threadId));
    const activeTabThreadIdForRuntimeSession = activeTabThreadBySession[session.sessionId];
    const projectLastThreadId = selectedProject?.sessions.some((item) => item.sessionId === session.sessionId)
      ? selectedProject.lastThreadId
      : undefined;
    const desiredThreadId = activeTabThreadIdForRuntimeSession && threadIds.has(activeTabThreadIdForRuntimeSession)
      ? activeTabThreadIdForRuntimeSession
      : projectLastThreadId && threadIds.has(projectLastThreadId)
        ? projectLastThreadId
        : session.threads?.[0]?.threadId;

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
  }, [activeTabThreadId, activeRuntimeSession, activeSessionId, initialized, activeTabThreadBySession, runtimeSessions, selectedProject]);

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
      apiJson<{ hosts?: SshHost[] }>("/api/ssh/hosts").catch(() => ({ hosts: [] })),
      apiJson<{ hosts?: SshHost[] }>("/api/ssh/config-hosts").catch(() => ({ hosts: [] })),
      apiJson<{ connections?: SshConnection[] }>("/api/ssh/connections").catch(() => ({ connections: [] })),
      apiJson<{ plugins?: PluginSummary[] }>("/api/plugins").catch(() => ({ plugins: [] })),
      apiJson<{ tasks?: LocalTask[] }>("/api/tasks").catch(() => ({ tasks: [] }))
    ]);
    const defaultDirectory = health.defaultWorkingDirectory ?? "";
    const loadedRuntimeSessions = normalizeRuntimeSessions(sessionData.sessions);
    const loadedMachines = normalizeMachines(projectData.machines);
    const loadedProjects = normalizeProjects(projectData.projects);
    const saved = readStoredUiState();
    const savedRuntimeSession = saved?.activeSessionId
      ? loadedRuntimeSessions.find((session) => session.sessionId === saved.activeSessionId)
      : undefined;
    const initialRuntimeSession = savedRuntimeSession ?? loadedRuntimeSessions[0];

    setSystemStatus({
      model: health.model,
      modelReasoningEffort: health.modelReasoningEffort,
      contextWindowTokens: health.contextWindowTokens
    });
    setActiveWorkspacePath(saved?.activeWorkspacePath ?? defaultDirectory);
    setSelectedModel(saved?.selectedModel ?? "auto");
    setSelectedReasoning(saved?.selectedReasoning ?? "auto");
    setMessageDisplayMode(saved?.messageDisplayMode ?? "compact");
    setSidebarCollapsed(window.matchMedia("(max-width: 860px)").matches ? true : saved?.sidebarCollapsed ?? false);
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
      const initialProject = loadedProjects.find((project) => project.sessions.some((session) => session.sessionId === initialRuntimeSession.sessionId))
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
      const message = JSON.parse(event.data) as RealtimeMessage;
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
    if (message.type === "thread" || message.type === "record" || message.type === "done") {
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
    latestRequestedThreadId.current = threadId;
    setActiveTabThreadId(threadId);

    const existingSession = sessions.find((session) => session.threadId === threadId);
    if (existingSession) {
      subscribeThread(threadId, existingSession.lastSeq);
      setActiveWorkspacePath(existingSession.workingDirectory);
      return;
    }

    const existingOpen = openingThreads.current.get(threadId);
    if (existingOpen) return existingOpen;

    const open = (async () => {
      const thread = await apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`);
      const session: ChatSession = { ...thread, input: "", imageAttachments: [] };
      const sessionId = thread.runtime.sessionId;
      if (sessionId) {
        setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, thread.threadId));
      }
      setRuntimeSessions((current) => patchRuntimeSessionsThread(current, thread));
      setProjects((current) => patchProjectsThread(current, thread));
      setSessions((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextSession = existing
          ? { ...session, input: existing.input, imageAttachments: existing.imageAttachments }
          : session;
        return current.some((item) => item.threadId === thread.threadId)
          ? current.map((item) => item.threadId === thread.threadId ? nextSession : item)
          : [...current, nextSession];
      });
      if (latestRequestedThreadId.current !== thread.threadId) return;
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
    threadLastSeqs.current.set(
      payload.thread.threadId,
      Math.max(threadLastSeqs.current.get(payload.thread.threadId) ?? 0, payload.seq)
    );
    setSessions((current) => current.map((session) => {
      if (session.threadId !== payload.thread.threadId) return session;
      const records = payload.record ? mergeRecord(session.records, payload.record) : session.records;
      return { ...session, ...payload.thread, records };
    }));
    if (payload.thread.runtime.sessionId) {
      setThreadOrderBySession((current) => appendThreadOrder(current, payload.thread.runtime.sessionId!, payload.thread.threadId));
    }
    setRuntimeSessions((current) => patchRuntimeSessionsThread(current, payload.thread));
    setProjects((current) => patchProjectsThread(current, payload.thread));
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
      const session: ChatSession = { ...thread, input: "", imageAttachments: [] };
      setSessions((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextSession = existing
          ? { ...session, input: existing.input, imageAttachments: existing.imageAttachments }
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
    const session = sessions.find((item) => item.threadId === threadId);
    if (!session || session.running) return;
    const text = session.input.trim();
    const imageAttachments = session.imageAttachments;
    if (!text && !imageAttachments.length) return;
    if (!imageAttachments.length && isModelCommand(text)) {
      setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "" } : item));
      setRuntimeDialogOpen(true);
      return;
    }
    setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "", imageAttachments: [] } : item));
    let encodedImages: Array<{ url: string }>;
    try {
      encodedImages = await Promise.all(imageAttachments.map(async (image) => ({ url: await fileToDataUrl(image.file) })));
      for (const image of imageAttachments) URL.revokeObjectURL(image.previewUrl);
    } catch (error) {
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          input: text,
          imageAttachments,
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
      body: JSON.stringify({ input, source: "web", options: selectedThreadOptions(selectedModel, selectedReasoning) })
    });
    if (!response.ok) {
      const text = await response.text();
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("error", text)] }
        : item));
    }
  };

  const stopTurn = async (threadId: string) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/stop`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("stop failed", text)] }
        : item));
    }
  };

  const updateSessionInput = (threadId: string, input: string) => {
    setSessions((current) => current.map((session) => session.threadId === threadId ? { ...session, input } : session));
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

  const selectRuntimeSession = async (session: RuntimeSession) => {
    setActiveSessionId(session.sessionId);
    setActiveWorkspacePath(session.workingDirectory);
    const project = projectList.find((item) => item.sessions.some((projectSession) => projectSession.sessionId === session.sessionId))
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
    const session = project.sessions.find((item) => item.online) ?? project.sessions[0];
    if (session?.online) {
      await selectRuntimeSession(session);
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
        `/api/sessions/${encodeURIComponent(sessionId)}/thread-candidates?limit=50`
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
      setProjects(normalizeProjects(payload.projects));
      setProjectOpenError("");
      setActiveWorkspacePath(payload.result?.cwd ?? trimmedPath);
      const freshRuntimeSessions = await apiJson<{ sessions?: RuntimeSession[] }>("/api/sessions")
        .then((data) => normalizeRuntimeSessions(data.sessions))
        .catch(() => runtimeSessions);
      setRuntimeSessions(freshRuntimeSessions);
      setThreadOrderBySession((current) => mergeThreadOrderByRuntimeSession(current, freshRuntimeSessions));
      const sessionId = payload.result?.sessionId;
      const session = sessionId
        ? freshRuntimeSessions.find((item) => item.sessionId === sessionId)
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
    if (!window.confirm(`Remove ${project.name} from CodexHub projects?\n\nThis does not delete files or stop running sessions.`)) return;
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
              const deleting = deletingProjectId === project.projectId;
              const openDisabled = openingProjectKey === projectKey || deleting;
              return (
                <div
                  key={project.projectId}
                  className={`projectRow ${active ? "active" : ""} ${project.online ? "online" : "offline"}`}
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
    <main className={`app ${sidebarCollapsed ? "sidebarCollapsed" : ""}`}>
      {!sidebarCollapsed ? (
        <button
          type="button"
          className="sidebarScrim"
          onClick={() => setSidebarCollapsed(true)}
          aria-label="Hide menu"
        />
      ) : null}
      <aside className="sidebar">
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
                      {thread.title || shortId(thread.threadId)}
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

      </aside>

      <section className="workspace">
        <header className="topbar">
          <button
            type="button"
            className="sidebarPanelToggle"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? "Show menu" : "Hide menu"}
            title={sidebarCollapsed ? "Show menu" : "Hide menu"}
          >
            {sidebarCollapsed ? "Menu" : "Hide"}
          </button>
          <div className="workspaceTitle">
            <span title={activeRuntimeSession ? activeRuntimeSession.name ?? shortId(activeRuntimeSession.sessionId) : "No connected codexhub"}>
              {activeRuntimeSession ? activeRuntimeSession.name ?? shortId(activeRuntimeSession.sessionId) : "No connected codexhub"}
            </span>
            <code className="workspaceMeta">
              <span className="workspacePath" title={activeRuntimeSession?.workingDirectory ?? activeWorkspacePath}>
                {activeRuntimeSession?.workingDirectory ?? activeWorkspacePath}
              </span>
              {activeRuntimeSession ? (
                <span
                  className={`workspaceRuntimeSessionState ${activeRuntimeSession.online ? "online" : "offline"}`}
                  title={runtimeSessionStatusTitle(activeRuntimeSession)}
                >
                  {activeRuntimeSession.online ? "online" : "offline"}
                </span>
              ) : null}
              {activeDisplayThreadId ? (
                <span className="workspaceThreadId" title={`thread: ${activeDisplayThreadId}`}>thread: {activeDisplayThreadId}</span>
              ) : activeRuntimeSession ? (
                <span className="workspaceThreadId" title="thread: none">thread: none</span>
              ) : null}
            </code>
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
                  <button
                    type="button"
                    className="threadTabAddButton"
                    onClick={() => openThreadPicker(activeRuntimeSession)}
                    disabled={!activeRuntimeSession.online}
                    aria-label="Add thread tab"
                    title="Add thread tab"
                  >
                    +
                  </button>
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
            activeKey={activeSession.threadId}
            items={activeRuntimeSessionThreadTabs.map((item) => ({
              ...item,
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
                      return (
                        <MessageCard
                          message={message}
                          showStatus={messageDisplayMode === "compact" || message.role !== "tool"}
                          renderToolPreview={messageDisplayMode === "compact"}
                          renderMode={renderMode}
                          markdownEnabled={markdownEnabled}
                          onRenderModeChange={markdownEnabled ? (mode) => updateMessageRenderMode(message.id, mode) : undefined}
                          onInspect={messageDisplayMode === "compact" && message.role === "tool" ? () => setInspectMessage(message) : undefined}
                          onFork={canForkAtMessage(activeSession.threadId, message) ? () => void forkMessage(activeSession.threadId, message.record.id) : undefined}
                          onRollback={canForkAtMessage(activeSession.threadId, message) ? () => void rollbackMessage(activeSession.threadId, message.record.id) : undefined}
                        />
                      );
                    }}
                  />

                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (activeSession.running) void stopTurn(activeSession.threadId);
                      else void send(activeSession.threadId);
                    }}
                  >
                    <div className="composerLayout">
                      <div className="composerSurface">
                        <div className="composerInput">
                          {activeSession.imageAttachments.length ? (
                            <div className="imageAttachmentList">
                              {activeSession.imageAttachments.map((image) => (
                                <div className="imageAttachment" key={image.id}>
                                  <img src={image.previewUrl} alt={image.name} />
                                  <button type="button" onClick={() => removeSessionImage(activeSession.threadId, image.id)} aria-label={`Remove ${image.name}`}>x</button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          <textarea
                            value={activeSession.input}
                            onChange={(event) => updateSessionInput(activeSession.threadId, event.target.value)}
                            onPaste={(event) => {
                              if (!pasteSessionImages(activeSession.threadId, event.clipboardData)) return;
                              event.preventDefault();
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                              event.preventDefault();
                              if (activeCanSend) void send(activeSession.threadId);
                            }}
                            placeholder="例如：检查这个 repo 的结构并给我下一步建议"
                            rows={1}
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
                            <button type="submit" className="composerSendButton" disabled={!activeCanSubmit} aria-label={activeSession.running ? "Stop current turn" : "Send message"}>
                              {activeSession.running ? <span className="composerStopIcon" aria-hidden="true" /> : "↑"}
                            </button>
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
              <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value as ModelSelection)}>
                {runtimeModelOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="runtimeDialogField">
              <span>Thinking</span>
              <select value={selectedReasoning} onChange={(event) => setSelectedReasoning(event.target.value as ReasoningSelection)}>
                {reasoningOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
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
                disabled={threadPicker.loading || threadPicker.acting !== null}
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
  renderToolPreview = true,
  renderMode,
  markdownEnabled,
  onRenderModeChange,
  onInspect,
  onFork,
  onRollback
}: {
  message: WebRecordView;
  showStatus?: boolean;
  renderToolPreview?: boolean;
  renderMode: MessageRenderMode;
  markdownEnabled: boolean;
  onRenderModeChange?: (mode: MessageRenderMode) => void;
  onInspect?: () => void;
  onFork?: () => void;
  onRollback?: () => void;
}) => {
  const toolBody = renderToolPreview ? renderToolMessageBody(message, showStatus ? message.status : undefined) : null;
  const hasToolBody = toolBody !== null;
  return (
    <article
      className={`message ${message.role} ${hasToolBody ? "richTool" : ""} ${onInspect ? "inspectable" : ""} ${renderMode === "markdown" ? "markdownMode" : "rawMode"}`}
      onClick={onInspect}
      role={onInspect ? "button" : undefined}
      tabIndex={onInspect ? 0 : undefined}
      onKeyDown={onInspect ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onInspect();
        }
      } : undefined}
    >
      {hasToolBody ? null : (
        <span className="messageHeader">
          <b>{message.label ?? message.role}</b>
          {showStatus && message.status ? <em className={`messageStatus ${message.status}`}>{statusLabel(message.status)}</em> : null}
        </span>
      )}
      {hasToolBody ? (
        toolBody
      ) : message.text ? (
        <MessageText text={message.text} mode={renderMode} markdownEnabled={markdownEnabled} />
      ) : null}
      {message.attachments?.length ? (
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
      {message.at || message.usage || markdownEnabled || onFork || onRollback ? (
        <footer className="messageMeta" title={formatMessageMetaTitle(message)} onClick={(event) => event.stopPropagation()}>
          <span>{formatMessageMeta(message)}</span>
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
    return (
      <SyntaxHighlighter
        PreTag="div"
        CodeTag="code"
        language={language}
        style={syntaxHighlighterStyle}
        customStyle={syntaxHighlighterCustomStyle}
        codeTagProps={{ className: "markdownHighlightedCode" }}
        showLineNumbers={false}
        wrapLongLines={false}
      >
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
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
    </div>
  );
};

const apiJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
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
  return kind === "user" || kind === "agent" || kind === "usage" ? turnId : null;
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
    const online = Boolean(machine && "online" in machine ? machine.online : project.online);
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
  const onlineProjects = group.projects.filter((project) => project.online).length;
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

const mergeProjectsWithRuntimeSessions = (projects: ProjectSummary[], runtimeSessions: RuntimeSession[]) => {
  const projectsByKey = new Map(projects.map((project) => [projectRuntimeKey(project.machineId, project.path), {
    ...project,
    sessions: [...(project.sessions ?? [])],
    threads: [...(project.threads ?? [])],
    storedThreads: [...(project.storedThreads ?? [])]
  }]));
  for (const session of runtimeSessions) {
    const key = projectRuntimeKey(machineIdForSession(session), session.workingDirectory);
    let project = projectsByKey.get(key);
    if (!project) {
      project = {
        projectId: key,
        machineId: machineIdForSession(session),
        path: session.workingDirectory,
        name: basename(session.workingDirectory),
	        createdAt: session.lastSeenAt,
	        lastOpenedAt: session.lastSeenAt,
	        lastSessionId: session.sessionId,
	        lastThreadId: session.threads?.[0]?.threadId,
	        online: session.online,
	        running: Boolean(session.threads?.some((thread) => thread.running || thread.status === "running")),
	        sessions: [],
	        threads: [],
        storedThreads: []
      };
      projectsByKey.set(key, project);
    }
    if (!project.sessions.some((item) => item.sessionId === session.sessionId)) project.sessions.push(session);
	    for (const thread of session.threads ?? []) {
	      if (!project.threads.some((item) => item.threadId === thread.threadId)) project.threads.push(thread);
	    }
	    project.online = project.online || session.online;
	    project.running = project.running || Boolean(session.threads?.some((thread) => thread.running || thread.status === "running"));
	  }
  return [...projectsByKey.values()].sort((left, right) => {
    return compareProjectRows(left, right);
  });
};

const projectRuntimeKey = (machineId: string, projectPath: string) => `${machineId}\0${projectPath}`;

const compareProjectRows = (left: ProjectSummary, right: ProjectSummary) => {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  const createdCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdCompare) return createdCompare;
  const nameCompare = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  if (nameCompare) return nameCompare;
  return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
};

const machineIdForSession = (session: RuntimeSession) => session.machineId ?? `machine-${safeMachinePart(session.hostname ?? "local")}`;

const safeMachinePart = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";

const projectKeyFor = (machineId: string, projectPath: string) => `${machineId}:${projectPath}`;

const projectKeyForProject = (project: Pick<ProjectSummary, "machineId" | "path">) =>
  projectKeyFor(project.machineId, project.path);

const basename = (projectPath: string) => projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath;

const projectStatusLabel = (project: ProjectSummary) => {
  if (project.running) return "running";
  if (project.sessions.some((session) => session.online)) return "online";
  if (project.machine && "online" in project.machine && project.machine.online) return "ready";
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

const threadCandidateTitle = (candidate: CodexThreadCandidate) =>
  compactLine(candidate.firstUserMessage || candidate.lastAssistantMessage || shortId(candidate.threadId));

const formatThreadCandidateTime = (value: string) => relativeTime(value);

const compactLine = (value: string) => value.replace(/\s+/g, " ").trim();

const appendThreadOrder = (current: Record<string, string[]>, sessionId: string, threadId: string) => {
  const existing = current[sessionId] ?? [];
  if (existing.includes(threadId)) return current;
  return { ...current, [sessionId]: [...existing, threadId] };
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
    const matchesSession = Boolean(thread.runtime.sessionId && project.sessions.some((session) => session.sessionId === thread.runtime.sessionId));
    const matchesPath = project.path === thread.workingDirectory;
    if (!matchesSession && !matchesPath) return project;
    const threads = upsertThreadSummary(project.threads ?? [], thread);
    return {
      ...project,
      lastThreadId: thread.threadId,
      running: threads.some((item) => item.running || item.status === "running"),
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

const selectedThreadOptions = (model: ModelSelection, reasoning: ReasoningSelection) => ({
  model: model === "auto" ? null : model,
  modelReasoningEffort: reasoning === "auto" ? null : reasoning
});

const isModelCommand = (text: string) => /^\/model\s*$/i.test(text);

const modelLabel = (model: ModelSelection) =>
  model === "auto" ? "Auto" : modelOptions.find((option) => option.value === model)?.label ?? model;

const modelOptionsForSelection = (model: ModelSelection) => {
  if (!model || modelOptions.some((option) => option.value === model)) return modelOptions;
  return [...modelOptions, { value: model, label: model }];
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

const formatMessageMeta = (message: CodexRecordView) => [
  message.at ? formatMessageTime(message.at) : null,
  message.usage ? `${formatCompactNumber(usageTotal(message.usage))} tokens` : null
].filter(Boolean).join(" · ");

const formatMessageMetaTitle = (message: CodexRecordView) => {
  if (!message.usage) return message.at ? formatDate(message.at) : undefined;
  return [
    message.at ? formatDate(message.at) : null,
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
  if (hasMatchingJsonlTranscriptRecord(records, incoming)) return records;
  const existingIndex = records.findIndex((record) => record.id === incoming.id);
  if (existingIndex === -1) {
    return [
      ...records.filter((record) => !isMatchingOptimisticUserRecord(record, incoming) && !isMatchingAppServerTranscriptRecord(record, incoming)),
      incoming
    ];
  }
  return records.map((record, index) => index === existingIndex ? incoming : record);
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

const hasMatchingJsonlTranscriptRecord = (records: CodexRecord[], incoming: CodexRecord) => {
  if (incoming.line) return false;
  if (!incoming.id.startsWith("app:") || incoming.type !== "event_msg") return false;
  const incomingPayload = asRecord(incoming.payload);
  if (!incomingPayload) return false;
  const incomingType = incomingPayload?.type;
  if (incomingType !== "user_message" && incomingType !== "agent_message") return false;
  const incomingTurnId = turnIdFromAppRecordId(String(incoming.sourceThreadId ?? ""), incoming.id);
  return records.some((record) => {
    if (!record.line || record.type !== "event_msg") return false;
    const threadId = String(record.sourceThreadId ?? incoming.sourceThreadId ?? "");
    const recordTurnId = turnIdFromAppRecordId(threadId, record.id);
    if (incomingTurnId || recordTurnId) return incomingTurnId === recordTurnId && recordTurnId !== null;
    const payload = asRecord(record.payload);
    if (payload?.type !== incomingType || payload.message !== incomingPayload.message) return false;
    if (incomingType === "agent_message") return payload.phase === incomingPayload.phase;
    return JSON.stringify(payload.images ?? []) === JSON.stringify(incomingPayload.images ?? []);
  });
};

const isMatchingAppServerTranscriptRecord = (record: CodexRecord, incoming: CodexRecord) => {
  if (!incoming.line || incoming.type !== "event_msg" || !record.id.startsWith("app:") || record.line) return false;
  const recordPayload = asRecord(record.payload);
  const incomingPayload = asRecord(incoming.payload);
  if (!incomingPayload) return false;
  const incomingType = incomingPayload?.type;
  if (incomingType !== "user_message" && incomingType !== "agent_message") return false;
  const threadId = String(incoming.sourceThreadId ?? record.sourceThreadId ?? "");
  const incomingTurnId = turnIdFromAppRecordId(threadId, incoming.id);
  const recordTurnId = turnIdFromAppRecordId(threadId, record.id);
  if (incomingTurnId || recordTurnId) return incomingTurnId === recordTurnId && recordTurnId !== null;
  if (recordPayload?.type !== incomingType || recordPayload.message !== incomingPayload.message) return false;
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
  if (presenterInspect) return presenterInspect;

  const callText = message.inspectCallText ?? message.text;
  return {
    ...formatInspectInput(message.record, callText.trimEnd()),
    ...formatInspectOutput(message.record, output)
  };
};

const formatInspectTitle = (message: WebRecordView) => {
  const toolCall = parseToolCallMessage(message);
  return toolCall ? `tool: ${toolCall.name}` : message.label;
};

const renderToolMessageBody = (message: WebRecordView, status?: CodexRecordView["status"]) => {
  const toolCall = parseToolCallMessage(message);
  if (!toolCall) return null;
  return webToolPresenters[toolCall.name]?.render?.(toolCall.args, status) ?? null;
};

const parseToolCallMessage = (message: WebRecordView): ParsedToolCall | null => {
  if (message.role !== "tool") return null;
  const payload = asRecord(message.record.payload);
  if (payload?.type !== "function_call") return null;
  const name = typeof payload.name === "string" ? payload.name : "tool";
  const args = parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "");
  return { name, args: args ?? {} };
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

const clipboardImageFiles = (clipboardData: DataTransfer) => {
  const itemFiles = [...clipboardData.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (itemFiles.length) return itemFiles;
  return [...clipboardData.files].filter((file) => file.type.startsWith("image/"));
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
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey) ?? "null");
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
