import type React from "react";
import type { MachineActivityStatus } from "../../shared/machineTypes.js";
import type { RealtimeOutgoingMessage } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import type { CodexRecord } from "../../shared/recordTypes.js";
import {
  CodexHubRealtimeClient,
  codexHubRealtimeUrl,
  threadCursorAfterEvent
} from "../../shared/realtimeClient.js";
import {
  defaultAppSettings,
  embeddedWorkspacePaths,
  embeddedSurfaceId,
  initialWorkspacePath,
  isElectronSurface,
  isEmbeddedHostSurface,
  isVscodeSurface
} from "../appConfig.js";
import {
  apiRouteJson,
  authToken,
  appendThreadOrder,
  collectRegisteredMachineActivityCompletions,
  findProjectByMachinePath,
  findProjectByWorkspacePath,
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
  machineNotificationLabel,
  readStoredUiState,
  runtimeForProject,
  setAuthToken,
  sendElectronTaskCompleteNotification,
  showBrowserTaskCompleteNotification,
  createRegisteredMachineConnectionTracker,
  type SidebarDraftStore,
  streamEventRecords,
  taskCompleteNotification,
  taskRunCompleteNotification,
  taskCompleteNotificationFromActivity,
  taskCompleteNotificationShouldPersist,
  taskCompletionNotificationKey,
  taskCompleteRecordIsForLatestUserInput
} from "../appHelpers.js";
import type { ProjectTarget } from "../../shared/petActivityRouting.js";
import type {
  AppSettings,
  LocalTask,
  MachineSummary,
  ParentRegistrationStatus,
  PluginSummary,
  ProjectSummary,
  RealtimeMessage,
  RuntimeSummary,
  SshConnection,
  SshHost,
  StreamEvent,
  SystemStatus,
  TaskCompleteNotification
} from "../types.js";
import type { ConversationThreadAction, OpenThreadAction } from "../openThreadReducer.js";
import { authorityInstanceRecovery } from "../helpers/authorityInstanceRecovery.js";
import { restorePersistedThreadTabs } from "../helpers/threadRestore.js";
import {
  workspaceIncludesProjectTarget,
  type SurfaceProjectTarget,
  type SurfaceThreadTarget
} from "../helpers/surfaceThreadScope.js";
import {
  mergeThreadRestoreTarget,
  selectPendingThreadRestoreTargets,
  type PendingThreadRestoreTargets
} from "../helpers/pendingThreadRestore.js";
import { workspaceTargetForProjectTarget } from "../pets/petStatus.js";
import {
  recordRendererRealtimeEvent,
  updateRendererDiagnosticContext
} from "../helpers/rendererDiagnostics.js";

type RealtimeActionsContext = {
  appSettingsRef: React.MutableRefObject<AppSettings>;
  closedThreadIds: React.MutableRefObject<Set<string>>;
  connectionsLastSeq: React.MutableRefObject<number>;
  notificationAudioContext: React.MutableRefObject<AudioContext | null>;
  notificationRecordsByThread: React.MutableRefObject<Map<string, CodexRecord[]>>;
  notifiedTaskCompletions: React.MutableRefObject<Set<string>>;
  openThreadIdsRef: React.MutableRefObject<Set<string>>;
  projectsLastSeq: React.MutableRefObject<number>;
  realtimeClient: React.MutableRefObject<CodexHubRealtimeClient | null>;
  realtimeThreadSubscriptions: React.MutableRefObject<Set<string>>;
  sidebarDraftStore: SidebarDraftStore;
  runtimesLastSeq: React.MutableRefObject<number>;
  tasksLastSeq: React.MutableRefObject<number>;
  threadLastSeqs: React.MutableRefObject<Map<string, number>>;
  latestRequestedThreadId: React.MutableRefObject<string>;
  machinesRef?: React.MutableRefObject<MachineSummary[]>;
  projectsRef?: React.MutableRefObject<ProjectSummary[]>;
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
  setParentRegistration: React.Dispatch<React.SetStateAction<ParentRegistrationStatus>>;
  setPendingRestoreActiveThreadId: React.Dispatch<React.SetStateAction<string>>;
  pendingRestoreAttemptCountsRef: React.MutableRefObject<Record<string, number>>;
  setPendingRestoreTargets: React.Dispatch<React.SetStateAction<PendingThreadRestoreTargets>>;
  setPendingRestoreThreadIds: React.Dispatch<React.SetStateAction<string[]>>;
  setPlugins: React.Dispatch<React.SetStateAction<PluginSummary[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setSelectedProjectKey: React.Dispatch<React.SetStateAction<string>>;
  setServerAuthRequired: React.Dispatch<React.SetStateAction<boolean>>;
  setRuntimeList: React.Dispatch<React.SetStateAction<RuntimeSummary[]>>;
  dispatchOpenThreads: React.Dispatch<OpenThreadAction>;
  dispatchConversationThread: (action: ConversationThreadAction) => void;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setSshConfigHosts: React.Dispatch<React.SetStateAction<SshHost[]>>;
  setSshConnections: React.Dispatch<React.SetStateAction<SshConnection[]>>;
  setSshHosts: React.Dispatch<React.SetStateAction<SshHost[]>>;
  setSystemStatus: React.Dispatch<React.SetStateAction<SystemStatus>>;
  setTasks: React.Dispatch<React.SetStateAction<LocalTask[]>>;
  setThreadOrderByMachine: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  threadProjectTargetsRef: React.MutableRefObject<Readonly<Record<string, SurfaceProjectTarget | undefined>>>;
  setThreadProjectTargets: React.Dispatch<React.SetStateAction<Record<string, SurfaceProjectTarget | undefined>>>;
};

export type RealtimeActionsDependencies = {
  clearActiveThreadIfLatest: (threadId: string) => void;
  notifyRegisteredMachineConnected: (machine: MachineSummary) => void;
  notifyRegisteredMachineDisconnected: (machine: MachineSummary) => void;
  onThreadCompleted: (completionKey: string) => void;
  openThread: (threadId: string, options?: {
    expectedMachineId?: string;
    preferredWorkingDirectory?: string;
    projectTarget?: SurfaceProjectTarget;
    activate?: boolean;
    deferActivationUntilLoaded?: boolean;
  }) => Promise<void>;
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
const embeddedWorkspacePathSet = new Set(embeddedWorkspacePaths);

export const createRealtimeActions = (ctx: RealtimeActionsContext, deps: RealtimeActionsDependencies): RealtimeActions => {
  const registeredMachineConnections = createRegisteredMachineConnectionTracker();
  const registeredMachineActivityStatuses = new Map<string, MachineActivityStatus>();
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
    updateRendererDiagnosticContext({
      serverInstanceId: health.serverInstanceId,
      authorityId: health.authority?.authorityId,
      surface: health.surface
    });
    authorityInstanceRecovery.accept(health.serverInstanceId);
    ctx.setServerAuthRequired(Boolean(health.authRequired));
    if (!health.authRequired && authToken()) setAuthToken("");
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
    if (ctx.machinesRef) ctx.machinesRef.current = loadedMachines;
    registeredMachineConnections.seed(loadedMachines);
    rememberRegisteredMachineActivities(loadedMachines);
    const saved = readStoredUiState();
    const shouldRestoreSavedTabs = (isVscodeSurface || !initialWorkspacePath)
      && Array.isArray(saved?.openThreadIds);
    const savedThreadIds = shouldRestoreSavedTabs
      ? uniqueThreadIds(saved?.openThreadIds ?? [])
      : undefined;
    const loadedThreadTargets: Record<string, SurfaceThreadTarget> = Object.fromEntries(
      loadedRuntimes.flatMap((runtime) => (runtime.threads ?? []).map((thread) => [thread.threadId, {
        machineId: runtime.machineId,
        workingDirectory: thread.workingDirectory
      }]))
    );
    const persistedThreadTarget = (threadId: string) => {
      const savedTarget = saved?.openThreadTargets?.[threadId];
      const loadedTarget = loadedThreadTargets[threadId];
      return mergeThreadRestoreTarget(loadedTarget, savedTarget);
    };
    const restoreThreadTargets = Object.fromEntries(
      (savedThreadIds ?? []).flatMap((threadId) => {
        const target = persistedThreadTarget(threadId);
        return target ? [[threadId, target]] : [];
      })
    );
    const restoredThreadIds = savedThreadIds;
    const persistedActiveThreadId = saved?.activeTabThreadId ?? "";
    const restoredActiveThreadId = restoredThreadIds?.includes(persistedActiveThreadId)
      ? persistedActiveThreadId
      : restoredThreadIds?.[0] ?? "";
    const restoredThreadIdSet = new Set(restoredThreadIds ?? []);
    const savedActiveTabThreadByMachine = Object.fromEntries(
      Object.entries(saved?.activeTabThreadByMachine ?? {})
        .filter(([, threadId]) => restoredThreadIdSet.has(threadId))
    );
    const savedRuntime = saved?.activeMachineId
      ? loadedRuntimes.find((runtime) => runtime.machineId === saved.activeMachineId)
      : undefined;
    const initialProjectFromUrl = initialWorkspacePath
      ? findProjectByWorkspacePath(loadedProjects, initialWorkspacePath, {
          sourceKind: isVscodeSurface ? "vscode" : isElectronSurface ? "electron" : undefined,
          sourceGroupId: embeddedSurfaceId
        })
      : undefined;
    const initialRuntime = runtimeForProject(initialProjectFromUrl, loadedRuntimes)
      ?? (initialWorkspacePath ? undefined : savedRuntime ?? loadedRuntimes[0]);
    const initialWorkspace = initialWorkspacePath || saved?.activeWorkspacePath || defaultDirectory;
    const initialProject = initialProjectFromUrl
      ?? (initialWorkspacePath || !initialRuntime
        ? undefined
        : findProjectByMachinePath(loadedProjects, initialRuntime.machineId, initialWorkspace)
          ?? undefined);
    const initialSettings = {
      ...defaultAppSettings(),
      ...(configData.config.ui ?? saved?.settings ?? {})
    };
    const loadedTasks = normalizeTasks(taskData.tasks);
    rememberCompletedTaskRuns(loadedTasks);

    ctx.setSystemStatus({
      version: health.version ?? null,
      authority: health.authority,
      authorityUpdate: health.authorityUpdate,
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
    ctx.setSidebarCollapsed(window.matchMedia("(max-width: 860px)").matches ? true : saved?.sidebarCollapsed ?? false);
    ctx.setSelectedProjectKey(
      initialProject
        ? projectKeyForProject(initialProject)
        : initialWorkspacePath
          ? ""
          : saved?.selectedProjectKey ?? ""
    );
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
    ctx.setActiveTabThreadByMachine(savedActiveTabThreadByMachine);
    ctx.setThreadOrderByMachine(() => mergeThreadOrderByMachine(saved?.threadOrderByMachine ?? {}, loadedRuntimes));
    ctx.setPendingRestoreThreadIds([]);
    ctx.setPendingRestoreActiveThreadId("");
    ctx.pendingRestoreAttemptCountsRef.current = {};
    ctx.setPendingRestoreTargets({});
    ctx.setThreadProjectTargets({});
    connectRealtimeEvents();
    const initialThreadId = initialRuntime ? preferredThreadIdForRuntime(initialRuntime, initialProject) : "";
    if (initialProject) {
      ctx.setActiveMachineId(initialProject.machineId);
      ctx.setActiveWorkspacePath(initialProject.path);
    } else if (initialRuntime) {
      ctx.setActiveMachineId(initialRuntime.machineId);
      ctx.setActiveWorkspacePath(initialWorkspace || initialRuntime.workingDirectory);
    }
    if (restoredThreadIds) {
      const restored = await restorePersistedThreadTabs({
        threadIds: restoredThreadIds,
        activeThreadId: restoredActiveThreadId,
        openThread: (threadId, options) => {
          const target = persistedThreadTarget(threadId);
          return deps.openThread(threadId, {
            ...options,
            ...(target ? {
              expectedMachineId: target.machineId,
              ...(target.workingDirectory
                ? { preferredWorkingDirectory: target.workingDirectory }
                : {}),
              ...(target.projectTarget ? { projectTarget: target.projectTarget } : {})
            } : {})
          });
        },
        clearActiveThreadIfLatest: deps.clearActiveThreadIfLatest
      });
      const restoredSet = new Set(restored.threadIds);
      const pendingTargets = selectPendingThreadRestoreTargets(
        restored.pendingThreadIds,
        restoreThreadTargets
      );
      const retainedRestoreIds = new Set([...restored.threadIds, ...restored.pendingThreadIds]);
      ctx.setThreadProjectTargets(Object.fromEntries(
        [...retainedRestoreIds].flatMap((threadId) => {
          const target = persistedThreadTarget(threadId)?.projectTarget;
          return target ? [[threadId, target]] : [];
        })
      ));
      ctx.setPendingRestoreThreadIds(restored.pendingThreadIds);
      ctx.setPendingRestoreActiveThreadId(
        restored.pendingThreadIds.includes(restoredActiveThreadId) ? restoredActiveThreadId : ""
      );
      ctx.setPendingRestoreTargets(pendingTargets);
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
      onMessage: handleRealtimeMessage,
      onOpen: () => {
        void authorityInstanceRecovery.checkAfterReconnect(
          () => apiRouteJson(apiRoutes.health),
          () => window.location.reload()
        ).catch(() => undefined);
      }
    });
    for (const threadId of ctx.realtimeThreadSubscriptions.current) {
      client.subscribeThread(threadId, ctx.threadLastSeqs.current.get(threadId) ?? 0);
    }
    ctx.realtimeClient.current = client;
    client.connect();
  }

  function handleRealtimeMessage(message: RealtimeMessage) {
    recordRendererRealtimeEvent(message);
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
      if (ctx.machinesRef) ctx.machinesRef.current = nextMachines;
      const registeredMachineChanges = registeredMachineConnections.update(nextMachines);
      for (const machine of registeredMachineChanges.connected) {
        deps.notifyRegisteredMachineConnected(machine);
      }
      for (const machine of registeredMachineChanges.disconnected) {
        deps.notifyRegisteredMachineDisconnected(machine);
      }
      notifyRegisteredMachineActivityCompletions(nextMachines);
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
      || message.type === "record_delta"
      || message.type === "done"
    ) {
      applyThreadStreamEvent(message);
    }
  }

  function applyThreadStreamEvent(payload: StreamEvent) {
    if (ctx.closedThreadIds.current.has(payload.thread.threadId)) return;
    ctx.threadLastSeqs.current.set(
      payload.thread.threadId,
      threadCursorAfterEvent(ctx.threadLastSeqs.current.get(payload.thread.threadId), payload)
    );
    ctx.dispatchConversationThread({
      type: "merge-stream",
      threadId: payload.thread.threadId,
      thread: payload.thread,
      record: payload.record,
      records: payload.records,
      delta: payload.delta,
      snapshot: payload.snapshot,
      backgroundTerminals: payload.backgroundTerminals,
      queue: payload.queue
    });
    const isWorkspaceThread = ctx.openThreadIdsRef.current.has(payload.thread.threadId);
    if (isWorkspaceThread) {
      const machineId = payload.thread.runtime.machineId;
      if (machineId) {
        ctx.setThreadOrderByMachine((current) => appendThreadOrder(current, machineId, payload.thread.threadId));
      }
    }
    ctx.setRuntimeList((current) => patchRuntimesThread(current, payload.thread));
    if (isWorkspaceThread) {
      ctx.setProjects((current) => patchProjectsThread(
        current,
        payload.thread,
        ctx.threadProjectTargetsRef.current[payload.thread.threadId]
      ));
    }
    if (!payload.historical && payload.kind === "record" && payload.record && isTaskCompleteRecord(payload.record)) {
      deps.onThreadCompleted(taskCompletionNotificationKey(payload.thread.threadId, payload.record));
    }
    notifyTaskCompletionsFromStreamEvent(payload);
  }

  function notifyTaskCompletionsFromStreamEvent(event: StreamEvent) {
    const candidateProjectTarget = ctx.threadProjectTargetsRef.current[event.thread.threadId];
    const projectTarget = candidateProjectTarget?.machineId === event.thread.runtime.machineId
      ? candidateProjectTarget
      : undefined;
    if (
      isEmbeddedHostSurface
      && embeddedWorkspacePathSet.size
      && !workspaceIncludesProjectTarget(
        embeddedWorkspacePathSet,
        projectTarget,
        event.thread.runtime.machineId
      )
    ) return;
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
      if (!taskCompleteRecordIsForLatestUserInput(record, nextRecords, event.thread)) continue;
      const key = taskCompletionNotificationKey(threadId, record);
      if (ctx.notifiedTaskCompletions.current.has(key)) continue;
      ctx.notifiedTaskCompletions.current.add(key);
      const machine = event.thread.runtime.machineId
        ? ctx.machinesRef?.current.find((candidate) => candidate.machineId === event.thread.runtime.machineId)
        : undefined;
      const matchedProject = projectTarget
        ? findProjectByMachinePath(ctx.projectsRef?.current ?? [], projectTarget.machineId, projectTarget.path)
        : undefined;
      const workspaceTarget = workspaceTargetForProjectTarget(ctx.projectsRef?.current ?? [], projectTarget);
      dispatchTaskCompleteNotification(taskCompleteNotification(
        event.thread,
        record,
        nextRecords,
        {
          source: matchedProject?.source,
          machine,
          machineHostname: machine?.hostname,
          projectPath: projectTarget?.path,
          projectTarget,
          workspaceTarget,
          machineLabel: machine ? machineNotificationLabel(machine, event.thread.workingDirectory) : undefined
        }
      ));
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
      if (
        isEmbeddedHostSurface
        && embeddedWorkspacePathSet.size
        && !embeddedWorkspacePathSet.has(task.projectPath)
      ) continue;
      for (const run of task.runs ?? []) {
        if (run.status !== "completed") continue;
        const key = taskRunNotificationKey(task, run.runId);
        if (ctx.notifiedTaskCompletions.current.has(key)) continue;
        ctx.notifiedTaskCompletions.current.add(key);
        if (run.threadId && ctx.realtimeThreadSubscriptions.current.has(run.threadId)) continue;
        const machine = ctx.machinesRef?.current.find((candidate) => candidate.machineId === task.machineId);
        const projectTarget: ProjectTarget = { machineId: task.machineId, path: task.projectPath };
        const matchedProject = findProjectByMachinePath(
          ctx.projectsRef?.current ?? [],
          projectTarget.machineId,
          projectTarget.path
        );
        const workspaceTarget = workspaceTargetForProjectTarget(
          ctx.projectsRef?.current ?? [],
          projectTarget
        );
        dispatchTaskCompleteNotification(taskRunCompleteNotification(
          task,
          run,
          {
            source: matchedProject?.source,
            machine,
            projectPath: projectTarget.path,
            projectTarget,
            workspaceTarget,
            machineLabel: machine ? machineNotificationLabel(machine, task.projectPath) : undefined
          }
        ));
      }
    }
  }

  function rememberRegisteredMachineActivities(machines: MachineSummary[]) {
    const { next } = collectRegisteredMachineActivityCompletions(
      registeredMachineActivityStatuses,
      machines
    );
    registeredMachineActivityStatuses.clear();
    for (const [key, status] of next) registeredMachineActivityStatuses.set(key, status);
  }

  function notifyRegisteredMachineActivityCompletions(machines: MachineSummary[]) {
    const { completed, next } = collectRegisteredMachineActivityCompletions(
      registeredMachineActivityStatuses,
      machines
    );
    registeredMachineActivityStatuses.clear();
    for (const [key, status] of next) registeredMachineActivityStatuses.set(key, status);

    for (const { machine, activity } of completed) {
      if (ctx.realtimeThreadSubscriptions.current.has(activity.threadId)) continue;
      const candidateProjectTarget = ctx.threadProjectTargetsRef.current[activity.threadId];
      const projectTarget = candidateProjectTarget?.machineId === machine.machineId
        ? candidateProjectTarget
        : undefined;
      if (
        isEmbeddedHostSurface
        && embeddedWorkspacePathSet.size
        && !workspaceIncludesProjectTarget(
          embeddedWorkspacePathSet,
          projectTarget,
          machine.machineId
        )
      ) continue;
      const matchedProject = projectTarget
        ? findProjectByMachinePath(ctx.projectsRef?.current ?? [], projectTarget.machineId, projectTarget.path)
        : undefined;
      const workspaceTarget = workspaceTargetForProjectTarget(ctx.projectsRef?.current ?? [], projectTarget);
      dispatchTaskCompleteNotification(taskCompleteNotificationFromActivity(
        machine,
        activity,
        matchedProject?.source,
        { projectTarget, workspaceTarget }
      ));
    }
  }

  function dispatchTaskCompleteNotification(notification: TaskCompleteNotification) {
    try {
      playTaskCompletionSound(ctx.notificationAudioContext);
    } catch {
      // Completion feedback must never interrupt realtime state processing.
    }
    if (!ctx.appSettingsRef.current.taskCompleteSystemNotifications) return;
    const persistent = taskCompleteNotificationShouldPersist(
      notification,
      ctx.appSettingsRef.current.taskCompleteNotificationPersistAfterMinutes
    );
    const notificationWithPersistence = { ...notification, persistent };
    if (isElectronSurface) {
      if (sendElectronTaskCompleteNotification(notificationWithPersistence, window.codexhubElectronPet) === "notification") return;
      void showBrowserTaskCompleteNotification(
        notificationWithPersistence,
        undefined,
        (threadId) => void deps.openThread(threadId, { activate: true })
      );
      return;
    }
    if (isEmbeddedHostSurface) {
      try {
        window.parent?.postMessage({
          type: "codexhub.taskCompleteNotification",
          notification: notificationWithPersistence
        }, "*");
      } catch {
        // Embedded host notification failures are isolated from the event stream.
      }
      return;
    }
    void showBrowserTaskCompleteNotification(
      notificationWithPersistence,
      undefined,
      (threadId) => void deps.openThread(threadId, { activate: true })
    );
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
