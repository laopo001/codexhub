import type React from "react";
import type { RealtimeOutgoingMessage } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import type { CodexRecord } from "../../shared/recordTypes.js";
import { CodexHubRealtimeClient, codexHubRealtimeUrl } from "../../shared/realtimeClient.js";
import { defaultAppSettings, initialWorkspacePath, isEmbeddedHostSurface } from "../appConfig.js";
import {
  apiRouteJson,
  authToken,
  appendThreadOrder,
  formatDuration,
  isTaskCompleteRecord,
  mergeNotificationRecords,
  mergeThreadOrderByMachine,
  normalizeMachines,
  normalizePlugins,
  normalizeProjects,
  normalizeRuntimes,
  normalizeTasks,
  patchProjectsThread,
  patchRuntimesThread,
  playTaskCompletionSound,
  preferredThreadIdForRuntime,
  projectKeyForProject,
  readStoredUiState,
  runtimeForProject,
  showBrowserTaskCompleteNotification,
  createRegisteredMachineConnectionTracker,
  type SidebarDraftStore,
  streamEventRecords,
  taskCompleteNotification,
  taskCompletionNotificationKey
} from "../appHelpers.js";
import type {
  AppSettings,
  LocalTask,
  MachineSummary,
  MessageDisplayMode,
  ParentRegistrationStatus,
  PluginSummary,
  ProjectSummary,
  RealtimeMessage,
  RuntimeSummary,
  SshConnection,
  SshHost,
  StreamEvent,
  SystemStatus,
  TaskCompleteNotification,
  LocalTaskRun
} from "../types.js";
import type { OpenThreadAction } from "../openThreadReducer.js";
import { restorePersistedThreadTabs } from "../helpers/threadRestore.js";

type RealtimeActionsContext = {
  appSettingsRef: React.MutableRefObject<AppSettings>;
  closedThreadIds: React.MutableRefObject<Set<string>>;
  connectionsLastSeq: React.MutableRefObject<number>;
  notificationAudioContext: React.MutableRefObject<AudioContext | null>;
  notificationRecordsByThread: React.MutableRefObject<Map<string, CodexRecord[]>>;
  notifiedTaskCompletions: React.MutableRefObject<Set<string>>;
  projectsLastSeq: React.MutableRefObject<number>;
  realtimeClient: React.MutableRefObject<CodexHubRealtimeClient | null>;
  realtimeThreadSubscriptions: React.MutableRefObject<Set<string>>;
  sidebarDraftStore: SidebarDraftStore;
  runtimesLastSeq: React.MutableRefObject<number>;
  tasksLastSeq: React.MutableRefObject<number>;
  threadLastSeqs: React.MutableRefObject<Map<string, number>>;
  latestRequestedThreadId: React.MutableRefObject<string>;
  setActiveMachineId: React.Dispatch<React.SetStateAction<string>>;
  setActiveTabThreadByMachine: React.Dispatch<React.SetStateAction<Record<string, string>>>;
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
  setRuntimeList: React.Dispatch<React.SetStateAction<RuntimeSummary[]>>;
  dispatchOpenThreads: React.Dispatch<OpenThreadAction>;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setSshConfigHosts: React.Dispatch<React.SetStateAction<SshHost[]>>;
  setSshConnections: React.Dispatch<React.SetStateAction<SshConnection[]>>;
  setSshHosts: React.Dispatch<React.SetStateAction<SshHost[]>>;
  setSystemStatus: React.Dispatch<React.SetStateAction<SystemStatus>>;
  setTasks: React.Dispatch<React.SetStateAction<LocalTask[]>>;
  setThreadOrderByMachine: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};

export type RealtimeActionsDependencies = {
  clearActiveThreadIfLatest: (threadId: string) => void;
  notifyRegisteredMachineConnected: (machine: MachineSummary) => void;
  notifyRegisteredMachineDisconnected: (machine: MachineSummary) => void;
  onThreadCompleted: (completionKey: string) => void;
  openThread: (threadId: string) => Promise<void>;
};

export type RealtimeActions = {
  initialize: () => Promise<void>;
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
  const registeredMachineConnections = createRegisteredMachineConnectionTracker();
  const loadInitialPayloads = async () => Promise.all([
    apiRouteJson(apiRoutes.runtimes),
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
      runtimeData,
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
    const loadedRuntimes = normalizeRuntimes(runtimeData.runtimes);
    const loadedMachines = normalizeMachines(projectData.machines);
    const loadedProjects = normalizeProjects(projectData.projects);
    registeredMachineConnections.seed(loadedMachines);
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
    const savedRuntime = saved?.activeMachineId
      ? loadedRuntimes.find((runtime) => runtime.machineId === saved.activeMachineId)
      : undefined;
    const initialRuntime = runtimeForProject(initialProjectFromUrl, loadedRuntimes) ?? savedRuntime ?? loadedRuntimes[0];
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
    ctx.setRuntimeList(loadedRuntimes);
    ctx.setActiveTabThreadByMachine(saved?.activeTabThreadByMachine ?? {});
    ctx.setThreadOrderByMachine(() => mergeThreadOrderByMachine(saved?.threadOrderByMachine ?? {}, loadedRuntimes));
    connectRealtimeEvents();
    const initialProject = initialRuntime
      ? initialProjectFromUrl
        ?? loadedProjects.find((project) => project.machineId === initialRuntime.machineId && project.path === initialWorkspace)
        ?? loadedProjects.find((project) => project.machineId === initialRuntime.machineId && project.path === initialRuntime.workingDirectory)
      : undefined;
    const initialThreadId = initialRuntime ? preferredThreadIdForRuntime(initialRuntime, initialProject) : "";
    if (initialRuntime) {
      ctx.setActiveMachineId(initialRuntime.machineId);
      ctx.setActiveWorkspacePath(initialProject?.path ?? (initialWorkspace || initialRuntime.workingDirectory));
    }
    if (restoredThreadIds) {
      const restored = await restorePersistedThreadTabs({
        threadIds: restoredThreadIds,
        activeThreadId: restoredActiveThreadId,
        openThread: deps.openThread,
        clearActiveThreadIfLatest: deps.clearActiveThreadIfLatest
      });
      const restoredSet = new Set(restored.threadIds);
      ctx.dispatchOpenThreads({ type: "reorder", threadIds: restored.threadIds });
      ctx.setActiveTabThreadByMachine((current) => Object.fromEntries(
        Object.entries(current).filter(([, threadId]) => restoredSet.has(threadId))
      ));
      ctx.latestRequestedThreadId.current = restored.activeThreadId;
      ctx.setActiveTabThreadId(restored.activeThreadId);
      // 全部 persisted tabs 失败时保持空状态；initialized 后的默认 thread effect 会重试 initialThreadId。
    } else if (initialThreadId) {
      await deps.openThread(initialThreadId).catch(() => deps.clearActiveThreadIfLatest(initialThreadId));
    }
    ctx.setInitialized(true);
  };

  function sendRealtime(message: RealtimeOutgoingMessage) {
    return ctx.realtimeClient.current?.send(message) ?? false;
  }

  function connectRealtimeEvents() {
    ctx.realtimeClient.current?.disconnect();
    const client = new CodexHubRealtimeClient({
      url: () => codexHubRealtimeUrl(window.location.href, authToken()),
      cursors: {
        runtimesAfter: ctx.runtimesLastSeq.current,
        projectsAfter: ctx.projectsLastSeq.current,
        tasksAfter: ctx.tasksLastSeq.current,
        connectionsAfter: ctx.connectionsLastSeq.current
      },
      onMessage: handleRealtimeMessage
    });
    for (const threadId of ctx.realtimeThreadSubscriptions.current) {
      client.subscribeThread(threadId, ctx.threadLastSeqs.current.get(threadId) ?? 0);
    }
    ctx.realtimeClient.current = client;
    client.connect();
  }

  function handleRealtimeMessage(message: RealtimeMessage) {
    if (message.type === "runtimes") {
      const payload = message;
      ctx.runtimesLastSeq.current = Math.max(ctx.runtimesLastSeq.current, payload.seq);
      const nextRuntimes = normalizeRuntimes(payload.runtimes);
      ctx.setRuntimeList(nextRuntimes);
      ctx.setThreadOrderByMachine((current) => mergeThreadOrderByMachine(current, nextRuntimes));
      return;
    }
    if (message.type === "projects") {
      const payload = message;
      if (typeof payload.seq === "number") ctx.projectsLastSeq.current = Math.max(ctx.projectsLastSeq.current, payload.seq);
      const nextMachines = normalizeMachines(payload.machines);
      const registeredMachineChanges = registeredMachineConnections.update(nextMachines);
      for (const machine of registeredMachineChanges.connected) {
        deps.notifyRegisteredMachineConnected(machine);
      }
      for (const machine of registeredMachineChanges.disconnected) {
        deps.notifyRegisteredMachineDisconnected(machine);
      }
      ctx.setMachines(nextMachines);
      ctx.setProjects(normalizeProjects(payload.projects));
      return;
    }
    if (message.type === "tasks") {
      const payload = message;
      ctx.tasksLastSeq.current = Math.max(ctx.tasksLastSeq.current, payload.seq);
      const nextTasks = normalizeTasks(payload.tasks);
      ctx.setTasks(nextTasks);
      notifyTaskCompletionsFromTasksEvent(nextTasks);
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
    ctx.dispatchOpenThreads({ type: "merge-stream", thread: payload.thread, record: payload.record });
    const machineId = payload.thread.runtime.machineId;
    if (machineId) {
      ctx.setThreadOrderByMachine((current) => appendThreadOrder(current, machineId, payload.thread.threadId));
    }
    ctx.setRuntimeList((current) => patchRuntimesThread(current, payload.thread));
    ctx.setProjects((current) => patchProjectsThread(current, payload.thread));
    if (!payload.historical && payload.kind === "record" && payload.record && isTaskCompleteRecord(payload.record)) {
      deps.onThreadCompleted(taskCompletionNotificationKey(payload.thread.threadId, payload.record));
    }
    notifyTaskCompletionsFromStreamEvent(payload);
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
    try {
      playTaskCompletionSound(ctx.notificationAudioContext);
    } catch {
      // Completion feedback must never interrupt realtime state processing.
    }
    if (!ctx.appSettingsRef.current.taskCompleteSystemNotifications) return;
    if (isEmbeddedHostSurface) {
      try {
        window.parent?.postMessage({
          type: "codexhub.taskCompleteNotification",
          notification
        }, "*");
      } catch {
        // Embedded host notification failures are isolated from the event stream.
      }
      return;
    }
    void showBrowserTaskCompleteNotification(notification);
  }

  return {
    initialize,
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
