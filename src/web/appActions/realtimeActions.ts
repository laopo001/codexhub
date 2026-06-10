// @ts-nocheck
import { isVscodeSurface } from "../appConfig.js";
import {
  apiJson,
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

export const createRealtimeActions = (ctx, actions) => {
  const initialize = async () => {
    const [health, sessionData, projectData, sshHostData, sshConfigHostData, sshConnectionData, pluginData, taskData] = await Promise.all([
      apiJson("/api/health"),
      apiJson("/api/sessions"),
      apiJson("/api/projects"),
      isVscodeSurface ? Promise.resolve({ hosts: [] }) : apiJson("/api/ssh/hosts").catch(() => ({ hosts: [] })),
      isVscodeSurface ? Promise.resolve({ hosts: [] }) : apiJson("/api/ssh/config-hosts").catch(() => ({ hosts: [] })),
      isVscodeSurface ? Promise.resolve({ connections: [] }) : apiJson("/api/ssh/connections").catch(() => ({ connections: [] })),
      isVscodeSurface ? Promise.resolve({ plugins: [] }) : apiJson("/api/plugins").catch(() => ({ plugins: [] })),
      isVscodeSurface ? Promise.resolve({ tasks: [] }) : apiJson("/api/tasks").catch(() => ({ tasks: [] }))
    ]);
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
      model: health.model,
      modelReasoningEffort: health.modelReasoningEffort,
      contextWindowTokens: health.contextWindowTokens
    });
    ctx.setActiveWorkspacePath(saved?.activeWorkspacePath ?? defaultDirectory);
    ctx.setSelectedModel(saved?.selectedModel ?? "auto");
    ctx.setSelectedReasoning(saved?.selectedReasoning ?? "auto");
    ctx.setComposerMode("chat");
    ctx.setMessageDisplayMode(saved?.messageDisplayMode ?? "compact");
    ctx.setSidebarCollapsed(isVscodeSurface ? true : window.matchMedia("(max-width: 860px)").matches ? true : saved?.sidebarCollapsed ?? false);
    ctx.setSelectedProjectKey(saved?.selectedProjectKey ?? "");
    ctx.setCollapsedProjectMachineKeys(saved?.collapsedProjectMachineKeys ?? []);
    ctx.setMachines(loadedMachines);
    ctx.setProjects(loadedProjects);
    ctx.setSshHosts(Array.isArray(sshHostData.hosts) ? sshHostData.hosts : []);
    ctx.setSshConfigHosts(Array.isArray(sshConfigHostData.hosts) ? sshConfigHostData.hosts : []);
    ctx.setSshConnections(Array.isArray(sshConnectionData.connections) ? sshConnectionData.connections : []);
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
        await actions.openThread(initialThreadId).catch(() => actions.clearActiveThreadIfLatest(initialThreadId));
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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/events/ws`;
  }

  function sendRealtime(message) {
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

  function handleRealtimeMessage(message) {
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

  function applyThreadStreamEvent(payload) {
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
    if (payload.thread.session.sessionId) {
      ctx.setThreadOrderBySession((current) => appendThreadOrder(current, payload.thread.session.sessionId, payload.thread.threadId));
    }
    ctx.setSessionList((current) => patchSessionsThread(current, payload.thread));
    ctx.setProjects((current) => patchProjectsThread(current, payload.thread));
  }

  function notifyTaskCompletionsFromStreamEvent(event) {
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

  function dispatchTaskCompleteNotification(notification) {
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
