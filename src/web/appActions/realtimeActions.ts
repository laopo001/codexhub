import type React from "react";
import type { CodexRecord } from "../../core/codexRecord.js";
import { isVscodeSurface } from "../appConfig.js";
import {
  apiJson,
  authToken,
  authWebSocketUrl,
  appendThreadOrder,
  isTaskCompleteRecord,
  mergeNotificationRecords,
  mergeRecord,
  mergeThreadJsonl,
  mergeThreadOrderBySession,
  normalizeMachines,
  normalizePlugins,
  normalizeProjects,
  normalizeSessions,
  normalizeTasks,
  parseRealtimeMessage,
  patchProjectsThread,
  patchSessionsThread,
  playTaskCompletionSound,
  preferredThreadIdForSession,
  readStoredUiState,
  streamEventRecords,
  taskCompleteNotification,
  taskCompletionNotificationKey,
  threadRecordsForNotifications
} from "../appHelpers.js";
import type {
  ChatSession,
  ComposerMode,
  ConnectionsStreamEvent,
  LocalTask,
  MachineSummary,
  MessageDisplayMode,
  ModelSelection,
  PluginSummary,
  ProjectSummary,
  ProjectsPayload,
  ReasoningSelection,
  RealtimeMessage,
  ServerConnection,
  ServerConnectionsStreamEvent,
  SessionSummary,
  SessionView,
  SshConnection,
  SshHost,
  StreamEvent,
  SystemStatus,
  TaskCompleteNotification,
  TasksStreamEvent
} from "../types.js";

type HealthPayload = Partial<SystemStatus> & {
  authRequired?: boolean;
  authenticated?: boolean;
  defaultWorkingDirectory?: string;
};

type SessionsPayload = {
  sessions?: SessionSummary[];
};

type SshHostsPayload = {
  hosts?: SshHost[];
};

type PluginsPayload = {
  plugins?: PluginSummary[];
};

type TasksPayload = {
  tasks?: LocalTask[];
};

type SshConnectionsPayload = {
  connections?: SshConnection[];
};

type ServerConnectionsPayload = {
  connections?: ServerConnection[];
};

type RealtimeOutgoingMessage =
  | {
    type: "hello";
    sessionsAfter: number;
    projectsAfter: number;
    tasksAfter: number;
    connectionsAfter: number;
    serverConnectionsAfter: number;
  }
  | { type: "subscribe_thread"; threadId: string; after: number }
  | { type: "unsubscribe_thread"; threadId: string };

type RealtimeActionsContext = {
  closedThreadIds: React.MutableRefObject<Set<string>>;
  connectionsLastSeq: React.MutableRefObject<number>;
  controlReconnectTimer: React.MutableRefObject<number | null>;
  notificationAudioContext: React.MutableRefObject<AudioContext | null>;
  notificationRecordsByThread: React.MutableRefObject<Map<string, CodexRecord[]>>;
  notifiedTaskCompletions: React.MutableRefObject<Set<string>>;
  projectsLastSeq: React.MutableRefObject<number>;
  realtimeSocket: React.MutableRefObject<WebSocket | null>;
  realtimeThreadSubscriptions: React.MutableRefObject<Set<string>>;
  serverConnectionsLastSeq: React.MutableRefObject<number>;
  sessionsLastSeq: React.MutableRefObject<number>;
  tasksLastSeq: React.MutableRefObject<number>;
  threadLastSeqs: React.MutableRefObject<Map<string, number>>;
  setActiveSessionId: React.Dispatch<React.SetStateAction<string>>;
  setActiveWorkspacePath: React.Dispatch<React.SetStateAction<string>>;
  setAuthError: React.Dispatch<React.SetStateAction<string>>;
  setAuthRequired: React.Dispatch<React.SetStateAction<boolean>>;
  setCollapsedProjectMachineKeys: React.Dispatch<React.SetStateAction<string[]>>;
  setComposerMode: React.Dispatch<React.SetStateAction<ComposerMode>>;
  setInitialized: React.Dispatch<React.SetStateAction<boolean>>;
  setMachines: React.Dispatch<React.SetStateAction<MachineSummary[]>>;
  setMessageDisplayMode: React.Dispatch<React.SetStateAction<MessageDisplayMode>>;
  setPlugins: React.Dispatch<React.SetStateAction<PluginSummary[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setProjectSearch: React.Dispatch<React.SetStateAction<string>>;
  setSelectedModel: React.Dispatch<React.SetStateAction<ModelSelection>>;
  setSelectedProjectKey: React.Dispatch<React.SetStateAction<string>>;
  setSelectedReasoning: React.Dispatch<React.SetStateAction<ReasoningSelection>>;
  setServerConnections: React.Dispatch<React.SetStateAction<ServerConnection[]>>;
  setServerAuthRequired: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionList: React.Dispatch<React.SetStateAction<SessionView[]>>;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setSshConfigHosts: React.Dispatch<React.SetStateAction<SshHost[]>>;
  setSshConnections: React.Dispatch<React.SetStateAction<SshConnection[]>>;
  setSshHosts: React.Dispatch<React.SetStateAction<SshHost[]>>;
  setSystemStatus: React.Dispatch<React.SetStateAction<SystemStatus>>;
  setTasks: React.Dispatch<React.SetStateAction<LocalTask[]>>;
  setThreadOrderBySession: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};

type RealtimeActionsDependencies = {
  clearActiveThreadIfLatest: (threadId: string) => void;
  openThread: (threadId: string) => Promise<void>;
};

export type RealtimeActions = {
  initialize: () => Promise<void>;
  clearControlReconnectTimer: () => void;
  scheduleControlReconnect: () => void;
  sendRealtime: (message: RealtimeOutgoingMessage) => boolean;
  connectRealtimeEvents: () => void;
  handleRealtimeMessage: (message: RealtimeMessage) => void;
  applyThreadStreamEvent: (payload: StreamEvent) => void;
  notifyTaskCompletionsFromStreamEvent: (event: StreamEvent) => void;
  dispatchTaskCompleteNotification: (notification: TaskCompleteNotification) => void;
};

export const createRealtimeActions = (ctx: RealtimeActionsContext, actions: Record<string, any>): RealtimeActions => {
  const deps = actions as RealtimeActionsDependencies;

  const initialize = async () => {
    const health = await apiJson<HealthPayload>("/api/health");
    ctx.setServerAuthRequired(Boolean(health.authRequired));
    if (health.authRequired && !health.authenticated && !authToken()) {
      ctx.setAuthRequired(true);
      ctx.setInitialized(true);
      return;
    }

    let sessionData: SessionsPayload;
    let projectData: ProjectsPayload;
    let sshHostData: SshHostsPayload;
    let sshConfigHostData: SshHostsPayload;
    let sshConnectionData: SshConnectionsPayload;
    let serverConnectionData: ServerConnectionsPayload;
    let pluginData: PluginsPayload;
    let taskData: TasksPayload;
    try {
      [sessionData, projectData, sshHostData, sshConfigHostData, sshConnectionData, serverConnectionData, pluginData, taskData] = await Promise.all([
        apiJson<SessionsPayload>("/api/sessions"),
        apiJson<ProjectsPayload>("/api/projects"),
        apiJson<SshHostsPayload>("/api/ssh/hosts").catch(() => ({ hosts: [] })),
        apiJson<SshHostsPayload>("/api/ssh/config-hosts").catch(() => ({ hosts: [] })),
        apiJson<SshConnectionsPayload>("/api/ssh/connections").catch(() => ({ connections: [] })),
        apiJson<ServerConnectionsPayload>("/api/server-connections").catch(() => ({ connections: [] })),
        apiJson<PluginsPayload>("/api/plugins").catch(() => ({ plugins: [] })),
        apiJson<TasksPayload>("/api/tasks").catch(() => ({ tasks: [] }))
      ]);
    } catch (error) {
      if (String(error).includes("HTTP 401")) {
        ctx.setAuthRequired(true);
        ctx.setAuthError("Invalid or missing access token.");
        ctx.setInitialized(true);
        return;
      }
      throw error;
    }
    const defaultDirectory = health.defaultWorkingDirectory ?? "";
    const loadedSessions = normalizeSessions(sessionData.sessions);
    const loadedMachines = normalizeMachines(projectData.machines);
    const loadedProjects = normalizeProjects(projectData.projects);
    const loadedProjectSessions = loadedProjects.flatMap((project) => project.session ? [project.session] : []);
    const saved = readStoredUiState();
    const savedSession = saved?.activeSessionId
      ? loadedProjectSessions.find((session) => session.sessionId === saved.activeSessionId)
      : undefined;
    const initialSession = savedSession ?? loadedProjectSessions[0];

    ctx.setSystemStatus({
      model: health.model ?? null,
      modelReasoningEffort: health.modelReasoningEffort ?? null,
      contextWindowTokens: health.contextWindowTokens ?? null
    });
    ctx.setAuthRequired(false);
    ctx.setAuthError("");
    ctx.setActiveWorkspacePath(saved?.activeWorkspacePath ?? defaultDirectory);
    ctx.setSelectedModel(saved?.selectedModel ?? "auto");
    ctx.setSelectedReasoning(saved?.selectedReasoning ?? "auto");
    ctx.setComposerMode("chat");
    ctx.setMessageDisplayMode(saved?.messageDisplayMode ?? "compact");
    ctx.setSidebarCollapsed(window.matchMedia("(max-width: 860px)").matches ? true : saved?.sidebarCollapsed ?? false);
    ctx.setSelectedProjectKey(saved?.selectedProjectKey ?? "");
    ctx.setProjectSearch(saved?.projectSearch ?? "");
    ctx.setCollapsedProjectMachineKeys(saved?.collapsedProjectMachineKeys ?? []);
    ctx.setMachines(loadedMachines);
    ctx.setProjects(loadedProjects);
    ctx.setSshHosts(Array.isArray(sshHostData.hosts) ? sshHostData.hosts : []);
    ctx.setSshConfigHosts(Array.isArray(sshConfigHostData.hosts) ? sshConfigHostData.hosts : []);
    ctx.setSshConnections(Array.isArray(sshConnectionData.connections) ? sshConnectionData.connections : []);
    ctx.setServerConnections(Array.isArray(serverConnectionData.connections) ? serverConnectionData.connections : []);
    ctx.setPlugins(normalizePlugins(pluginData.plugins));
    ctx.setTasks(normalizeTasks(taskData.tasks));
    ctx.setSessionList(loadedSessions);
    ctx.setThreadOrderBySession((current) => mergeThreadOrderBySession(current, loadedSessions));
    connectRealtimeEvents();
    if (initialSession) {
      ctx.setActiveSessionId(initialSession.sessionId);
      ctx.setActiveWorkspacePath(initialSession.workingDirectory);
      const initialProject = loadedProjects.find((project) => project.session?.sessionId === initialSession.sessionId)
        ?? loadedProjects.find((project) => project.machineId === initialSession.machineId && project.path === initialSession.workingDirectory);
      const initialThreadId = preferredThreadIdForSession(initialSession, initialProject);
      if (initialThreadId) {
        await deps.openThread(initialThreadId).catch(() => deps.clearActiveThreadIfLatest(initialThreadId));
      }
    }
    ctx.setInitialized(true);
  };

  function clearControlReconnectTimer() {
    if (ctx.controlReconnectTimer.current === null) return;
    window.clearTimeout(ctx.controlReconnectTimer.current);
    ctx.controlReconnectTimer.current = null;
  }

  function scheduleControlReconnect() {
    clearControlReconnectTimer();
    ctx.controlReconnectTimer.current = window.setTimeout(() => {
      ctx.controlReconnectTimer.current = null;
      connectRealtimeEvents();
    }, 1000);
  }

  function realtimeUrl() {
    return authWebSocketUrl("/api/events/ws");
  }

  function sendRealtime(message: RealtimeOutgoingMessage) {
    const socket = ctx.realtimeSocket.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function sendRealtimeHello() {
    sendRealtime({
      type: "hello",
      sessionsAfter: ctx.sessionsLastSeq.current,
      projectsAfter: ctx.projectsLastSeq.current,
      tasksAfter: ctx.tasksLastSeq.current,
      connectionsAfter: ctx.connectionsLastSeq.current,
      serverConnectionsAfter: ctx.serverConnectionsLastSeq.current
    });
  }

  function resubscribeRealtimeThreads() {
    for (const threadId of ctx.realtimeThreadSubscriptions.current) {
      sendRealtime({
        type: "subscribe_thread",
        threadId,
        after: ctx.threadLastSeqs.current.get(threadId) ?? 0
      });
    }
  }

  function connectRealtimeEvents() {
    clearControlReconnectTimer();
    ctx.realtimeSocket.current?.close();
    const socket = new WebSocket(realtimeUrl());
    socket.addEventListener("open", () => {
      sendRealtimeHello();
      resubscribeRealtimeThreads();
    });
    socket.addEventListener("message", (event) => {
      const message = parseRealtimeMessage(event.data);
      if (!message) return;
      handleRealtimeMessage(message);
    });
    socket.addEventListener("error", () => {
      if (ctx.realtimeSocket.current === socket) socket.close();
    });
    socket.addEventListener("close", () => {
      if (ctx.realtimeSocket.current !== socket) return;
      ctx.realtimeSocket.current = null;
      scheduleControlReconnect();
    });
    ctx.realtimeSocket.current = socket;
  }

  function handleRealtimeMessage(message: RealtimeMessage) {
    if (message.type === "sessions") {
      const payload = message;
      ctx.sessionsLastSeq.current = Math.max(ctx.sessionsLastSeq.current, payload.seq);
      const nextSessions = normalizeSessions(payload.sessions);
      ctx.setSessionList(nextSessions);
      ctx.setThreadOrderBySession((current) => mergeThreadOrderBySession(current, nextSessions));
      return;
    }
    if (message.type === "projects") {
      const payload = message;
      if (typeof payload.seq === "number") ctx.projectsLastSeq.current = Math.max(ctx.projectsLastSeq.current, payload.seq);
      ctx.setMachines(normalizeMachines(payload.machines));
      ctx.setProjects(normalizeProjects(payload.projects));
      return;
    }
    if (message.type === "tasks") {
      const payload = message;
      ctx.tasksLastSeq.current = Math.max(ctx.tasksLastSeq.current, payload.seq);
      ctx.setTasks(normalizeTasks(payload.tasks));
      return;
    }
    if (message.type === "connections") {
      const payload = message;
      ctx.connectionsLastSeq.current = Math.max(ctx.connectionsLastSeq.current, payload.seq);
      ctx.setSshConnections(Array.isArray(payload.connections) ? payload.connections : []);
      return;
    }
    if (message.type === "server_connections") {
      const payload = message as ServerConnectionsStreamEvent;
      ctx.serverConnectionsLastSeq.current = Math.max(ctx.serverConnectionsLastSeq.current, payload.seq);
      ctx.setServerConnections(Array.isArray(payload.connections) ? payload.connections : []);
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

  function applyThreadStreamEvent(payload: StreamEvent) {
    if (ctx.closedThreadIds.current.has(payload.thread.threadId)) return;
    notifyTaskCompletionsFromStreamEvent(payload);
    ctx.threadLastSeqs.current.set(
      payload.thread.threadId,
      Math.max(ctx.threadLastSeqs.current.get(payload.thread.threadId) ?? 0, payload.seq)
    );
    ctx.setSessions((current) => current.map((session) => {
      if (session.threadId !== payload.thread.threadId) return session;
      const records = payload.record ? mergeRecord(session.records, payload.record) : session.records;
      const jsonl = mergeThreadJsonl(session.jsonl, payload);
      return { ...session, ...payload.thread, records, jsonl };
    }));
    const sessionId = payload.thread.session.sessionId;
    if (sessionId) {
      ctx.setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, payload.thread.threadId));
    }
    ctx.setSessionList((current) => patchSessionsThread(current, payload.thread));
    ctx.setProjects((current) => patchProjectsThread(current, payload.thread));
  }

  function notifyTaskCompletionsFromStreamEvent(event: StreamEvent) {
    const threadId = event.thread.threadId;
    const incomingRecords = streamEventRecords(event);
    if (!incomingRecords.length) return;

    const previousRecords = ctx.notificationRecordsByThread.current.get(threadId) ?? [];
    const nextRecords = mergeNotificationRecords(previousRecords, event, incomingRecords);
    ctx.notificationRecordsByThread.current.set(threadId, nextRecords);
    if (event.kind !== "record" && event.kind !== "jsonl_append") return;

    for (const record of incomingRecords) {
      if (!isTaskCompleteRecord(record)) continue;
      const key = taskCompletionNotificationKey(threadId, record);
      if (ctx.notifiedTaskCompletions.current.has(key)) continue;
      ctx.notifiedTaskCompletions.current.add(key);
      dispatchTaskCompleteNotification(taskCompleteNotification(event.thread, record, nextRecords));
    }
  }

  function dispatchTaskCompleteNotification(notification: TaskCompleteNotification) {
    playTaskCompletionSound(ctx.notificationAudioContext);
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

  return {
    initialize,
    clearControlReconnectTimer,
    scheduleControlReconnect,
    sendRealtime,
    connectRealtimeEvents,
    handleRealtimeMessage,
    applyThreadStreamEvent,
    notifyTaskCompletionsFromStreamEvent,
    dispatchTaskCompleteNotification
  };
};
