import type React from "react";
import type { RealtimeOutgoingMessage } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import type { CodexRecord } from "../../shared/recordTypes.js";
import { defaultAppSettings, initialWorkspacePath, isEmbeddedHostSurface } from "../appConfig.js";
import {
  apiRouteJson,
  authToken,
  authWebSocketUrl,
  appendThreadOrder,
  formatDuration,
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
  runtimeSessionForProject,
  type SidebarDraftStore,
  streamEventRecords,
  taskCompleteNotification,
  taskCompletionNotificationKey
} from "../appHelpers.js";
import type {
  OpenThreadState,
  AppSettings,
  LocalTask,
  MachineSummary,
  MessageDisplayMode,
  ParentRegistrationStatus,
  PluginSummary,
  ProjectSummary,
  RealtimeMessage,
  SessionView,
  SshConnection,
  SshHost,
  StreamEvent,
  SystemStatus,
  TaskCompleteNotification,
  LocalTaskRun
} from "../types.js";

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
  sidebarDraftStore: SidebarDraftStore;
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
  setInitialized: React.Dispatch<React.SetStateAction<boolean>>;
  setMachines: React.Dispatch<React.SetStateAction<MachineSummary[]>>;
  setMessageDisplayMode: React.Dispatch<React.SetStateAction<MessageDisplayMode>>;
  setParentRegistration: React.Dispatch<React.SetStateAction<ParentRegistrationStatus>>;
  setPlugins: React.Dispatch<React.SetStateAction<PluginSummary[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setSelectedProjectKey: React.Dispatch<React.SetStateAction<string>>;
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

export type RealtimeActionsDependencies = {
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

const taskRunNotificationKey = (task: LocalTask, runId: string) => `task:${task.taskId}:${runId}`;

const taskRunCompleteNotification = (task: LocalTask, run: LocalTaskRun): TaskCompleteNotification => {
  const duration = formatDuration(run.durationMs) || undefined;
  return {
    title: duration ? `Codex task complete · 运行时间 ${duration}` : "Codex task complete",
    body: `${task.name || "Scheduled task"} completed.`,
    threadId: run.threadId ?? task.threadId ?? task.taskId,
    duration
  };
};

export const createRealtimeActions = (ctx: RealtimeActionsContext, deps: RealtimeActionsDependencies): RealtimeActions => {
  const loadInitialPayloads = async () => Promise.all([
    apiRouteJson(apiRoutes.sessions),
    apiRouteJson(apiRoutes.config),
    apiRouteJson(apiRoutes.projects),
    apiRouteJson(apiRoutes.sshHosts).catch(() => ({ hosts: [] })),
    apiRouteJson(apiRoutes.sshConfigHosts).catch(() => ({ hosts: [] })),
    apiRouteJson(apiRoutes.sshConnections).catch(() => ({ connections: [] })),
    apiRouteJson(apiRoutes.parentRegistration).catch(() => ({ registration: { status: "idle" as const } })),
    apiRouteJson(apiRoutes.plugins).catch(() => ({ plugins: [] })),
    apiRouteJson(apiRoutes.tasks).catch(() => ({ tasks: [] }))
  ] as const);

  const initialize = async () => {
    const health = await apiRouteJson(apiRoutes.health);
    ctx.setServerAuthRequired(Boolean(health.authRequired));
    if (health.authRequired && !health.authenticated && !authToken()) {
      ctx.setAuthRequired(true);
      ctx.setInitialized(true);
      return;
    }

    let initialPayloads: Awaited<ReturnType<typeof loadInitialPayloads>>;
    try {
      initialPayloads = await loadInitialPayloads();
    } catch (error) {
      if (String(error).includes("HTTP 401")) {
        ctx.setAuthRequired(true);
        ctx.setAuthError("Invalid or missing access token.");
        ctx.setInitialized(true);
        return;
      }
      throw error;
    }
    const [
      sessionData,
      configData,
      projectData,
      sshHostData,
      sshConfigHostData,
      sshConnectionData,
      parentRegistrationData,
      pluginData,
      taskData
    ] = initialPayloads;
    const defaultDirectory = health.defaultWorkingDirectory ?? "";
    const loadedSessions = normalizeSessions(sessionData.sessions);
    const loadedMachines = normalizeMachines(projectData.machines);
    const loadedProjects = normalizeProjects(projectData.projects);
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
    const availableSessions = loadedSessions;
    const savedSession = saved?.activeSessionId
      ? availableSessions.find((session) => session.sessionId === saved.activeSessionId)
      : undefined;
    const initialSession = runtimeSessionForProject(initialProjectFromUrl, loadedSessions) ?? savedSession ?? loadedSessions[0];
    const initialWorkspace = initialWorkspacePath || saved?.activeWorkspacePath || defaultDirectory;
    const initialSettings = {
      ...defaultAppSettings(),
      ...(configData.config.ui ?? saved?.settings ?? {})
    };
    const loadedTasks = normalizeTasks(taskData.tasks);
    rememberCompletedTaskRuns(loadedTasks);

    ctx.setSystemStatus({
      model: health.model ?? null,
      modelReasoningEffort: health.modelReasoningEffort ?? null,
      serviceTier: health.serviceTier ?? null,
      contextWindowTokens: health.contextWindowTokens ?? null
    });
    ctx.appSettingsRef.current = initialSettings;
    ctx.setAppSettings(initialSettings);
    ctx.setAuthRequired(false);
    ctx.setAuthError("");
    ctx.setActiveWorkspacePath(initialWorkspace);
    ctx.setMessageDisplayMode(saved?.messageDisplayMode ?? "compact");
    ctx.setSidebarCollapsed(window.matchMedia("(max-width: 860px)").matches ? true : saved?.sidebarCollapsed ?? false);
    ctx.setSelectedProjectKey(initialProjectFromUrl ? projectKeyForProject(initialProjectFromUrl) : saved?.selectedProjectKey ?? "");
    ctx.sidebarDraftStore.set("projectSearch", saved?.projectSearch ?? "");
    ctx.setCollapsedProjectMachineKeys(saved?.collapsedProjectMachineKeys ?? []);
    ctx.setMachines(loadedMachines);
    ctx.setProjects(loadedProjects);
    ctx.setSshHosts(Array.isArray(sshHostData.hosts) ? sshHostData.hosts : []);
    ctx.setSshConfigHosts(Array.isArray(sshConfigHostData.hosts) ? sshConfigHostData.hosts : []);
    ctx.setSshConnections(Array.isArray(sshConnectionData.connections) ? sshConnectionData.connections : []);
    ctx.setParentRegistration(parentRegistrationData.registration ?? { status: "idle" });
    ctx.setPlugins(normalizePlugins(pluginData.plugins));
    ctx.setTasks(loadedTasks);
    ctx.setSessionList(loadedSessions);
    ctx.setActiveTabThreadBySession(saved?.activeTabThreadBySession ?? {});
    ctx.setThreadOrderBySession(() => mergeThreadOrderBySession(saved?.threadOrderBySession ?? {}, loadedSessions));
    connectRealtimeEvents();
    const initialProject = initialSession
      ? initialProjectFromUrl
        ?? loadedProjects.find((project) => project.machineId === initialSession.machineId && project.path === initialWorkspace)
        ?? loadedProjects.find((project) => project.machineId === initialSession.machineId && project.path === initialSession.workingDirectory)
      : undefined;
    const initialThreadId = initialSession ? preferredThreadIdForSession(initialSession, initialProject) : "";
    if (initialSession) {
      ctx.setActiveSessionId(initialSession.sessionId);
      ctx.setActiveWorkspacePath(initialProject?.path ?? (initialWorkspace || initialSession.workingDirectory));
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
      const nextTasks = normalizeTasks(payload.tasks);
      notifyTaskCompletionsFromTasksEvent(nextTasks);
      ctx.setTasks(nextTasks);
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
    ctx.setOpenThreads((current) => {
      let matched = false;
      const next = current.map((thread) => {
        if (thread.threadId !== payload.thread.threadId) return thread;
        matched = true;
        const records = payload.record ? mergeRecord(thread.records, payload.record) : thread.records;
        return { ...thread, ...payload.thread, records };
      });
      return matched ? next : current;
    });
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

  function rememberCompletedTaskRuns(tasks: LocalTask[]) {
    for (const task of tasks) {
      for (const run of task.runs ?? []) {
        if (run.status !== "completed") continue;
        ctx.notifiedTaskCompletions.current.add(taskRunNotificationKey(task, run.runId));
      }
    }
  }

  function notifyTaskCompletionsFromTasksEvent(tasks: LocalTask[]) {
    for (const task of tasks) {
      for (const run of task.runs ?? []) {
        if (run.status !== "completed") continue;
        const key = taskRunNotificationKey(task, run.runId);
        if (ctx.notifiedTaskCompletions.current.has(key)) continue;
        ctx.notifiedTaskCompletions.current.add(key);
        if (run.threadId && ctx.realtimeThreadSubscriptions.current.has(run.threadId)) continue;
        dispatchTaskCompleteNotification(taskRunCompleteNotification(task, run));
      }
    }
  }

  function dispatchTaskCompleteNotification(notification: TaskCompleteNotification) {
    playTaskCompletionSound(ctx.notificationAudioContext);
    if (!ctx.appSettingsRef.current.taskCompleteSystemNotifications) return;
    if (isEmbeddedHostSurface) {
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
