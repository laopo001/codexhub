import type React from "react";
import type { CodexRecord } from "../../core/codexRecord.js";
import { defaultAppSettings, initialWorkspacePath, isVscodeSurface } from "../appConfig.js";
import {
  apiJson,
  authToken,
  authWebSocketUrl,
  appendThreadOrder,
  isTaskCompleteRecord,
  mergeNotificationRecords,
  mergeRecord,
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
  projectKeyForProject,
  readStoredUiState,
  streamEventRecords,
  taskCompleteNotification,
  taskCompletionNotificationKey,
  threadRecordsForNotifications
} from "../appHelpers.js";
import type {
  OpenThreadState,
  AppSettings,
  ComposerMode,
  ConnectionsStreamEvent,
  LocalTask,
  MachineSummary,
  MessageDisplayMode,
  ModelSelection,
  ParentRegistrationStatus,
  PluginSummary,
  ProjectSummary,
  ProjectsPayload,
  ReasoningSelection,
  RealtimeMessage,
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

type ParentRegistrationPayload = {
  registration?: ParentRegistrationStatus;
};

type RealtimeOutgoingMessage =
  | {
    type: "hello";
    sessionsAfter: number;
    projectsAfter: number;
    tasksAfter: number;
    connectionsAfter: number;
  }
  | { type: "subscribe_thread"; threadId: string; after: number }
  | { type: "unsubscribe_thread"; threadId: string };

type RealtimeActionsContext = {
  appSettingsRef: React.MutableRefObject<AppSettings>;
  closedThreadIds: React.MutableRefObject<Set<string>>;
  connectionsLastSeq: React.MutableRefObject<number>;
  controlReconnectTimer: React.MutableRefObject<number | null>;
  notificationAudioContext: React.MutableRefObject<AudioContext | null>;
  notificationRecordsByThread: React.MutableRefObject<Map<string, CodexRecord[]>>;
  notifiedTaskCompletions: React.MutableRefObject<Set<string>>;
  projectsLastSeq: React.MutableRefObject<number>;
  realtimeSocket: React.MutableRefObject<WebSocket | null>;
  realtimeThreadSubscriptions: React.MutableRefObject<Set<string>>;
  sessionsLastSeq: React.MutableRefObject<number>;
  tasksLastSeq: React.MutableRefObject<number>;
  threadLastSeqs: React.MutableRefObject<Map<string, number>>;
  latestRequestedThreadId: React.MutableRefObject<string>;
  setActiveSessionId: React.Dispatch<React.SetStateAction<string>>;
  setActiveTabThreadBySession: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setActiveTabThreadId: React.Dispatch<React.SetStateAction<string>>;
  setActiveWorkspacePath: React.Dispatch<React.SetStateAction<string>>;
  setAppSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  setAuthError: React.Dispatch<React.SetStateAction<string>>;
  setAuthRequired: React.Dispatch<React.SetStateAction<boolean>>;
  setCollapsedProjectMachineKeys: React.Dispatch<React.SetStateAction<string[]>>;
  setComposerMode: React.Dispatch<React.SetStateAction<ComposerMode>>;
  setInitialized: React.Dispatch<React.SetStateAction<boolean>>;
  setMachines: React.Dispatch<React.SetStateAction<MachineSummary[]>>;
  setMessageDisplayMode: React.Dispatch<React.SetStateAction<MessageDisplayMode>>;
  setParentRegistration: React.Dispatch<React.SetStateAction<ParentRegistrationStatus>>;
  setPlugins: React.Dispatch<React.SetStateAction<PluginSummary[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setProjectSearch: React.Dispatch<React.SetStateAction<string>>;
  setSelectedModel: React.Dispatch<React.SetStateAction<ModelSelection>>;
  setSelectedProjectKey: React.Dispatch<React.SetStateAction<string>>;
  setSelectedReasoning: React.Dispatch<React.SetStateAction<ReasoningSelection>>;
  setServerAuthRequired: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionList: React.Dispatch<React.SetStateAction<SessionView[]>>;
  setOpenThreads: React.Dispatch<React.SetStateAction<OpenThreadState[]>>;
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
    let parentRegistrationData: ParentRegistrationPayload;
    let pluginData: PluginsPayload;
    let taskData: TasksPayload;
    try {
      [sessionData, projectData, sshHostData, sshConfigHostData, sshConnectionData, parentRegistrationData, pluginData, taskData] = await Promise.all([
        apiJson<SessionsPayload>("/api/sessions"),
        apiJson<ProjectsPayload>("/api/projects"),
        apiJson<SshHostsPayload>("/api/ssh/hosts").catch(() => ({ hosts: [] })),
        apiJson<SshHostsPayload>("/api/ssh/config-hosts").catch(() => ({ hosts: [] })),
        apiJson<SshConnectionsPayload>("/api/ssh/connections").catch(() => ({ connections: [] })),
        apiJson<ParentRegistrationPayload>("/api/registered/parent").catch(() => ({ registration: { status: "idle" as const } })),
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
    const shouldRestoreSavedTabs = !initialWorkspacePath && Array.isArray(saved?.openThreadIds);
    const restoredThreadIds = shouldRestoreSavedTabs
      ? uniqueThreadIds([
        ...(saved?.openThreadIds ?? []),
        ...(saved?.activeTabThreadId ? [saved.activeTabThreadId] : [])
      ])
      : undefined;
    const restoredActiveThreadId = restoredThreadIds?.includes(saved?.activeTabThreadId ?? "")
      ? saved?.activeTabThreadId ?? ""
      : restoredThreadIds?.[0] ?? "";
    const initialProjectFromUrl = initialWorkspacePath
      ? loadedProjects.find((project) => project.path === initialWorkspacePath)
      : undefined;
    const availableSessions = [...loadedProjectSessions, ...loadedSessions];
    const savedSession = saved?.activeSessionId
      ? availableSessions.find((session) => session.sessionId === saved.activeSessionId)
      : undefined;
    const initialSession = initialProjectFromUrl?.session ?? savedSession ?? loadedProjectSessions[0] ?? loadedSessions[0];
    const initialWorkspace = initialWorkspacePath || saved?.activeWorkspacePath || defaultDirectory;
    const initialSettings = saved?.settings ?? defaultAppSettings();

    ctx.setSystemStatus({
      model: health.model ?? null,
      modelReasoningEffort: health.modelReasoningEffort ?? null,
      contextWindowTokens: health.contextWindowTokens ?? null
    });
    ctx.appSettingsRef.current = initialSettings;
    ctx.setAppSettings(initialSettings);
    ctx.setAuthRequired(false);
    ctx.setAuthError("");
    ctx.setActiveWorkspacePath(initialWorkspace);
    ctx.setSelectedModel(saved?.selectedModel ?? "auto");
    ctx.setSelectedReasoning(saved?.selectedReasoning ?? "auto");
    ctx.setComposerMode("chat");
    ctx.setMessageDisplayMode(saved?.messageDisplayMode ?? "compact");
    ctx.setSidebarCollapsed(window.matchMedia("(max-width: 860px)").matches ? true : saved?.sidebarCollapsed ?? false);
    ctx.setSelectedProjectKey(initialProjectFromUrl ? projectKeyForProject(initialProjectFromUrl) : saved?.selectedProjectKey ?? "");
    ctx.setProjectSearch(saved?.projectSearch ?? "");
    ctx.setCollapsedProjectMachineKeys(saved?.collapsedProjectMachineKeys ?? []);
    ctx.setMachines(loadedMachines);
    ctx.setProjects(loadedProjects);
    ctx.setSshHosts(Array.isArray(sshHostData.hosts) ? sshHostData.hosts : []);
    ctx.setSshConfigHosts(Array.isArray(sshConfigHostData.hosts) ? sshConfigHostData.hosts : []);
    ctx.setSshConnections(Array.isArray(sshConnectionData.connections) ? sshConnectionData.connections : []);
    ctx.setParentRegistration(parentRegistrationData.registration ?? { status: "idle" });
    ctx.setPlugins(normalizePlugins(pluginData.plugins));
    ctx.setTasks(normalizeTasks(taskData.tasks));
    ctx.setSessionList(loadedSessions);
    ctx.setActiveTabThreadBySession(saved?.activeTabThreadBySession ?? {});
    ctx.setThreadOrderBySession(() => mergeThreadOrderBySession(saved?.threadOrderBySession ?? {}, loadedSessions));
    connectRealtimeEvents();
    const initialProject = initialSession
      ? loadedProjects.find((project) => project.session?.sessionId === initialSession.sessionId)
        ?? loadedProjects.find((project) => project.machineId === initialSession.machineId && project.path === initialSession.workingDirectory)
      : undefined;
    const initialThreadId = initialSession ? preferredThreadIdForSession(initialSession, initialProject) : "";
    if (initialSession) {
      ctx.setActiveSessionId(initialSession.sessionId);
      ctx.setActiveWorkspacePath(initialSession.workingDirectory);
    }
    if (restoredThreadIds) {
      let restoredCount = 0;
      const openOrder = restoredActiveThreadId
        ? [...restoredThreadIds.filter((threadId) => threadId !== restoredActiveThreadId), restoredActiveThreadId]
        : restoredThreadIds;
      for (const threadId of openOrder) {
        try {
          await deps.openThread(threadId);
          restoredCount += 1;
        } catch {
          deps.clearActiveThreadIfLatest(threadId);
        }
      }
      if (restoredThreadIds.length) {
        ctx.setOpenThreads((current) => orderOpenThreads(current, restoredThreadIds));
        if (restoredActiveThreadId) {
          ctx.latestRequestedThreadId.current = restoredActiveThreadId;
          ctx.setActiveTabThreadId(restoredActiveThreadId);
        }
      }
      if (restoredThreadIds.length && restoredCount === 0 && initialThreadId) {
        await deps.openThread(initialThreadId).catch(() => deps.clearActiveThreadIfLatest(initialThreadId));
      }
    } else if (initialThreadId) {
      await deps.openThread(initialThreadId).catch(() => deps.clearActiveThreadIfLatest(initialThreadId));
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
      connectionsAfter: ctx.connectionsLastSeq.current
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
      if (payload.registration) ctx.setParentRegistration(payload.registration);
      return;
    }
    if (
      message.type === "thread"
      || message.type === "record"
      || message.type === "done"
    ) {
      applyThreadStreamEvent(message);
    }
  }

  function applyThreadStreamEvent(payload: StreamEvent) {
    if (ctx.closedThreadIds.current.has(payload.thread.threadId)) return;
    ctx.threadLastSeqs.current.set(
      payload.thread.threadId,
      Math.max(ctx.threadLastSeqs.current.get(payload.thread.threadId) ?? 0, payload.seq)
    );
    notifyTaskCompletionsFromStreamEvent(payload);
    ctx.setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== payload.thread.threadId) return thread;
      const records = payload.record ? mergeRecord(thread.records, payload.record) : thread.records;
      return { ...thread, ...payload.thread, records };
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
    if (event.historical) return;
    if (event.kind !== "record") return;

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
    if (!ctx.appSettingsRef.current.taskCompleteSystemNotifications) return;
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

const uniqueThreadIds = (threadIds: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const threadId of threadIds) {
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    result.push(threadId);
  }
  return result;
};

const orderOpenThreads = (threads: OpenThreadState[], threadIds: string[]) => {
  const order = new Map(threadIds.map((threadId, index) => [threadId, index]));
  return [...threads].sort((left, right) => {
    const leftIndex = order.get(left.threadId);
    const rightIndex = order.get(right.threadId);
    if (leftIndex == null && rightIndex == null) return 0;
    if (leftIndex == null) return 1;
    if (rightIndex == null) return -1;
    return leftIndex - rightIndex;
  });
};
