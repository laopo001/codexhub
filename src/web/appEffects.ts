import { useEffect } from "react";
import {
  currentWebClientId,
  embeddedSurfaceId,
  embeddedSurfaceLeaseId,
  isFixedWorkspaceSurface,
  isNativeElectronSurface,
  isVscodeSurface,
  readCurrentSurfaceUiStateRaw,
  writeCurrentSurfaceUiStateRaw
} from "./appConfig.js";
import {
  apiRouteJson,
  machineProjectLauncher,
  permissionProfileScopeKey,
  preferredThreadIdForRuntime,
  primeTaskCompletionSound,
  runtimeForProject
} from "./appHelpers.js";
import type { AppSelectors } from "./appSelectors.js";
import type { AppState } from "./appState.js";
import { apiRoutes } from "../shared/apiRoutes.js";
import { embeddedSurfaceProtocolVersion } from "../shared/surfaceTypes.js";
import {
  subagentDialogConversationThreads,
  subagentThreadSubscriptionIds
} from "./helpers/subagentThreadDialog.js";
import { resolveActiveThreadId } from "./helpers/activeThreadSelection.js";
import { createWebClientHeartbeat } from "./helpers/webClientHeartbeat.js";
import type { SurfaceThreadTarget } from "./helpers/surfaceThreadScope.js";
import {
  claimPendingThreadRestoreAttempt,
  pendingThreadRestoreOpenOptions,
  removePendingThreadRestoreTarget
} from "./helpers/pendingThreadRestore.js";

const webClientHeartbeatMs = 10_000;
const hiddenWebClientHeartbeatMs = 60_000;
const authorityHealthRefreshMs = 30_000;
const hiddenAuthorityHealthRefreshMs = 120_000;

type AppEffectsActions = {
  clearActiveThreadIfLatest: (threadId: string) => void;
  initialize: () => Promise<void>;
  openThread: (threadId: string, options?: {
    expectedMachineId?: string;
    preferredWorkingDirectory?: string;
    activate?: boolean;
    deferActivationUntilLoaded?: boolean;
  }) => Promise<void>;
  stopTurn: (threadId: string) => unknown;
  syncThreadSubscriptions: (threadIds: string[]) => void;
};

type AppEffectsInput = {
  actions: AppEffectsActions;
  selectors: AppSelectors;
  state: AppState;
};

export const useAppEffects = ({ actions, selectors, state }: AppEffectsInput) => {
  const surfaceProjectScopeKey = selectors.projectList
    .map((project) => `${project.machineId}\0${project.path}\0${project.source?.kind ?? ""}\0${project.source?.groupId ?? ""}`)
    .sort()
    .join("\n");
  useEffect(() => {
    void actions.initialize();
    return () => {
      state.realtimeClient.current?.disconnect();
      state.realtimeClient.current = null;
      state.realtimeThreadSubscriptions.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!state.initialized || !state.systemStatus.authority) return;
    const clientId = currentWebClientId();
    if (!clientId) return;
    let disposed = false;
    const requestRecovery = () => {
      if (disposed) return;
      if (isNativeElectronSurface) {
        void window.codexhubElectronPet?.recoverSurface?.();
        return;
      }
      if (isVscodeSurface && window.parent !== window) {
        window.parent.postMessage({ type: "codexhub.recoverSurface" }, "*");
      }
    };
    const heartbeat = createWebClientHeartbeat({
      send: async () => {
        const payload = await apiRouteJson(apiRoutes.heartbeatWebClient, {
          clientId,
          ...(embeddedSurfaceId && embeddedSurfaceLeaseId ? {
            embeddedSurface: {
              surfaceId: embeddedSurfaceId,
              leaseId: embeddedSurfaceLeaseId,
              protocolVersion: embeddedSurfaceProtocolVersion
            }
          } : {})
        });
        if (payload.embeddedSurfaceLeaseActive === false) {
          throw new Error("Embedded surface lease is no longer active.");
        }
      },
      requestRecovery
    });
    let timer: number | null = null;
    const clearHeartbeatTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const scheduleHeartbeat = () => {
      if (disposed) return;
      clearHeartbeatTimer();
      timer = window.setTimeout(() => {
        timer = null;
        void heartbeat.beat();
        scheduleHeartbeat();
      }, document.visibilityState === "visible" ? webClientHeartbeatMs : hiddenWebClientHeartbeatMs);
    };
    const beatWhenVisible = () => {
      if (document.visibilityState === "visible") void heartbeat.beat();
      scheduleHeartbeat();
    };
    document.addEventListener("visibilitychange", beatWhenVisible);
    window.addEventListener("pageshow", beatWhenVisible);
    void heartbeat.beat();
    scheduleHeartbeat();
    return () => {
      disposed = true;
      clearHeartbeatTimer();
      document.removeEventListener("visibilitychange", beatWhenVisible);
      window.removeEventListener("pageshow", beatWhenVisible);
    };
  }, [state.initialized, state.systemStatus.authority?.authorityId]);

  useEffect(() => {
    if (!state.initialized || !state.systemStatus.authority) return;
    let disposed = false;
    const refreshAuthorityUpdate = async () => {
      try {
        const health = await apiRouteJson(apiRoutes.health);
        if (disposed) return;
        state.setSystemStatus((current) => ({
          ...current,
          build: health.build ?? current.build,
          authorityLocalBuild: "authorityLocalBuild" in health
            ? health.authorityLocalBuild ?? null
            : current.authorityLocalBuild,
          authorityUpdate: health.authorityUpdate
        }));
      } catch {
        // Keep the last confirmed update state while the authority is temporarily unavailable.
      }
    };
    let timer: number | null = null;
    const clearRefreshTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const scheduleRefresh = () => {
      if (disposed) return;
      clearRefreshTimer();
      timer = window.setTimeout(() => {
        timer = null;
        void refreshAuthorityUpdate().finally(scheduleRefresh);
      }, document.visibilityState === "visible" ? authorityHealthRefreshMs : hiddenAuthorityHealthRefreshMs);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshAuthorityUpdate();
      scheduleRefresh();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("pageshow", refreshWhenVisible);
    void refreshAuthorityUpdate().finally(scheduleRefresh);
    return () => {
      disposed = true;
      clearRefreshTimer();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("pageshow", refreshWhenVisible);
    };
  }, [state.initialized, state.systemStatus.authority?.authorityId]);

  useEffect(() => {
    if (!state.initialized || !state.openThreads.length) return;
    const activeThreadId = resolveActiveThreadId({
      activeMachineId: state.activeMachineId,
      activeTabThreadId: state.activeTabThreadId,
      activeWorkspacePath: state.activeWorkspacePath,
      openThreads: state.openThreads,
      loadingThreadIds: new Set(state.openingThreads.current.keys()),
      selectedProjectTarget: selectors.selectedProject,
      threadProjectTargets: state.threadProjectTargets,
      restrictToWorkspacePath: isFixedWorkspaceSurface
    });
    if (!activeThreadId || activeThreadId === state.activeTabThreadId) return;
    const activeThread = state.openThreads.find((thread) => thread.threadId === activeThreadId);
    if (!activeThread || !activeThread.runtime.machineId) return;
    const machineId = activeThread.runtime.machineId;

    state.latestRequestedThreadId.current = activeThreadId;
    state.setActiveTabThreadId(activeThreadId);
    state.setActiveTabThreadByMachine((current) => ({
      ...current,
      [machineId]: activeThreadId
    }));
    if (!state.selectedProjectKey) {
      state.setActiveMachineId(machineId);
      state.setActiveWorkspacePath(activeThread.workingDirectory);
    }
  }, [
    selectors.selectedProject?.machineId,
    selectors.selectedProject?.path,
    state.activeMachineId,
    state.activeTabThreadId,
    state.activeWorkspacePath,
    state.initialized,
    state.openThreads,
    state.selectedProjectKey
  ]);

  useEffect(() => {
    const primeSound = () => primeTaskCompletionSound(state.notificationAudioContext);
    window.addEventListener("pointerdown", primeSound, { capture: true, once: true });
    window.addEventListener("keydown", primeSound, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", primeSound, true);
      window.removeEventListener("keydown", primeSound, true);
    };
  }, []);

  useEffect(() => {
    if (!state.initialized) return;
    const candidateOpenThreadIds = [...new Set(selectors.openThreadIds)];
    const currentThreadTargets = Object.fromEntries(state.openThreads.flatMap((thread) => {
      const machineId = thread.runtime.machineId;
      return machineId ? [[thread.threadId, {
        machineId,
        ...(state.threadProjectTargets[thread.threadId]
          ? { projectTarget: state.threadProjectTargets[thread.threadId] }
          : {}),
        ...(thread.workingDirectory ? { workingDirectory: thread.workingDirectory } : {})
      } satisfies SurfaceThreadTarget]] : [];
    }));
    const persistedOpenThreadIds = candidateOpenThreadIds;
    const persistedOpenThreadIdSet = new Set(persistedOpenThreadIds);
    const openThreadTargets = Object.fromEntries(persistedOpenThreadIds.flatMap((threadId) => {
      const target = currentThreadTargets[threadId];
      return target ? [[threadId, target]] : [];
    }));
    const activeTabThreadId = persistedOpenThreadIdSet.has(state.activeTabThreadId)
      ? state.activeTabThreadId
      : "";
    const activeTabThreadByMachine = Object.fromEntries(
      Object.entries(state.activeTabThreadByMachine)
        .filter(([, threadId]) => persistedOpenThreadIdSet.has(threadId))
    );
    const threadOrderByMachine = Object.fromEntries(
      Object.entries(state.threadOrderByMachine)
        .map(([machineId, threadIds]) => [
          machineId,
          threadIds.filter((threadId) => persistedOpenThreadIdSet.has(threadId))
        ])
        .filter(([, threadIds]) => threadIds.length)
    );
    writeCurrentSurfaceUiStateRaw(JSON.stringify({
      tabSnapshotVersion: 1,
      activeWorkspacePath: state.activeWorkspacePath,
      activeMachineId: state.activeMachineId,
      activeTabThreadId,
      activeTabThreadByMachine,
      openThreadIds: persistedOpenThreadIds,
      openThreadTargets,
      threadOrderByMachine,
      selectedProjectKey: state.selectedProjectKey,
      projectSearch: state.sidebarDraftStore.getSnapshot().projectSearch,
      sidebarCollapsed: state.sidebarCollapsed,
      collapsedProjectMachineKeys: state.collapsedProjectMachineKeys
    }));
  }, [
    state.activeWorkspacePath,
    state.activeMachineId,
    state.activeTabThreadByMachine,
    state.activeTabThreadId,
    selectors.openThreadIdsKey,
    surfaceProjectScopeKey,
    state.selectedProjectKey,
    state.sidebarCollapsed,
    state.collapsedProjectMachineKeys,
    state.threadOrderByMachine,
    state.threadProjectTargets,
    state.initialized
  ]);

  useEffect(() => {
    if (!state.initialized || !state.pendingRestoreThreadIds.length) return;
    let disposed = false;
    let inFlight = false;
    let retryTimer: number | null = null;
    const maxAttempts = 10;

    const retryPendingThreads = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const pendingThreadIds = [...state.pendingRestoreThreadIds];
      const pendingActiveThreadId = state.pendingRestoreActiveThreadId;
      const hasActiveThread = Boolean(state.activeTabThreadId);
      try {
        for (const threadId of pendingThreadIds) {
          if (disposed) return;
          const claimedAttempts = claimPendingThreadRestoreAttempt(
            state.pendingRestoreAttemptCountsRef.current,
            threadId,
            maxAttempts
          );
          if (!claimedAttempts) continue;
          state.pendingRestoreAttemptCountsRef.current = claimedAttempts;
          try {
            await actions.openThread(
              threadId,
              pendingThreadRestoreOpenOptions({
                threadId,
                activeThreadId: pendingActiveThreadId,
                hasActiveThread,
                targets: state.pendingRestoreTargets
              })
            );
            if (disposed) return;
            state.setPendingRestoreThreadIds((current) => current.filter((id) => id !== threadId));
            state.setPendingRestoreActiveThreadId((current) => current === threadId ? "" : current);
            state.setPendingRestoreTargets((current) =>
              removePendingThreadRestoreTarget(current, threadId)
            );
            const remainingAttempts = { ...state.pendingRestoreAttemptCountsRef.current };
            delete remainingAttempts[threadId];
            state.pendingRestoreAttemptCountsRef.current = remainingAttempts;
          } catch {
            // Keep the target in memory; the authority/runtime may still be waking up.
          }
        }
      } finally {
        inFlight = false;
        const exhausted = pendingThreadIds.every(
          (threadId) => (state.pendingRestoreAttemptCountsRef.current[threadId] ?? 0) >= maxAttempts
        );
        if (exhausted && retryTimer !== null) {
          const exhaustedIds = new Set(pendingThreadIds.filter(
            (threadId) => (state.pendingRestoreAttemptCountsRef.current[threadId] ?? 0) >= maxAttempts
          ));
          window.clearInterval(retryTimer);
          retryTimer = null;
          state.setPendingRestoreThreadIds((current) => current.filter(
            (threadId) => !exhaustedIds.has(threadId)
          ));
          state.setPendingRestoreActiveThreadId((current) =>
            exhaustedIds.has(current) ? "" : current
          );
          state.setPendingRestoreTargets((current) => Object.fromEntries(
            Object.entries(current).filter(([threadId]) => !exhaustedIds.has(threadId))
          ));
          state.setThreadProjectTargets((current) => Object.fromEntries(
            Object.entries(current).filter(([threadId]) => !exhaustedIds.has(threadId))
          ));
          const remainingAttempts = { ...state.pendingRestoreAttemptCountsRef.current };
          for (const threadId of exhaustedIds) delete remainingAttempts[threadId];
          state.pendingRestoreAttemptCountsRef.current = remainingAttempts;
        }
      }
    };

    retryTimer = window.setInterval(() => void retryPendingThreads(), 1_500);
    void retryPendingThreads();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearInterval(retryTimer);
    };
  }, [
    state.activeTabThreadId,
    state.initialized,
    state.pendingRestoreActiveThreadId,
    state.pendingRestoreTargets,
    state.pendingRestoreThreadIds
  ]);

  useEffect(() => {
    let projectSearch = state.sidebarDraftStore.getSnapshot().projectSearch;
    let timer: number | null = null;
    const persistProjectSearch = () => {
      timer = null;
      try {
        const parsed = JSON.parse(readCurrentSurfaceUiStateRaw() ?? "null");
        const stored = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        writeCurrentSurfaceUiStateRaw(JSON.stringify({ ...stored, projectSearch }));
      } catch {
        // Ignore storage failures; project search remains available for this page.
      }
    };
    const unsubscribe = state.sidebarDraftStore.subscribe(() => {
      const nextProjectSearch = state.sidebarDraftStore.getSnapshot().projectSearch;
      if (nextProjectSearch === projectSearch) return;
      projectSearch = nextProjectSearch;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(persistProjectSearch, 200);
    });
    return () => {
      unsubscribe();
      if (timer !== null) {
        window.clearTimeout(timer);
        persistProjectSearch();
      }
    };
  }, [state.sidebarDraftStore]);

  useEffect(() => {
    if (!state.initialized) return;
    state.sidebarDraftStore.set("taskDraft", (current) => {
      if (current.machineId && current.projectPath) return current;
      const preferredMachine = selectors.onlineMachines.find(machineProjectLauncher)
        ?? state.machines.find(machineProjectLauncher)
        ?? selectors.onlineMachines[0]
        ?? state.machines[0];
      const preferredProject = preferredMachine
        ? selectors.projectList.find((project) => project.machineId === preferredMachine.machineId)
        : selectors.projectList[0];
      const nextMachineId = current.machineId || preferredProject?.machineId || preferredMachine?.machineId || "";
      const nextProjectPath = current.projectPath || preferredProject?.path || "";
      if (nextMachineId === current.machineId && nextProjectPath === current.projectPath) return current;
      return {
        ...current,
        machineId: nextMachineId,
        projectPath: nextProjectPath
      };
    });
  }, [state.initialized, state.machines, selectors.onlineMachines, selectors.projectList]);

  useEffect(() => {
    if (!state.initialized || !selectors.selectedProject) return;
    const selectedProject = selectors.selectedProject;
    state.sidebarDraftStore.set("taskDraft", (current) => {
      if (current.machineId === selectedProject.machineId && current.projectPath === selectedProject.path) return current;
      return {
        ...current,
        machineId: selectedProject.machineId,
        projectPath: selectedProject.path,
        threadId: ""
      };
    });
  }, [state.initialized, selectors.selectedProject?.machineId, selectors.selectedProject?.path]);

  useEffect(() => {
    if (!state.initialized) return;
    const availableRuntimes = state.runtimeList;
    if (!availableRuntimes.length) {
      if (state.activeMachineId) state.setActiveMachineId("");
      // Keep an already open thread selected while the runtime is briefly
      // absent during reconnect. Clearing it here leaves Ant Tabs with a
      // visible label but no mounted conversation/composer.
      if (state.activeTabThreadId && !state.openThreads.length) {
        state.setActiveTabThreadId("");
      }
      return;
    }

    const selectedRuntimeSession = runtimeForProject(selectors.selectedProject ?? undefined, state.runtimeList);
    if (state.selectedProjectKey && selectors.selectedProject) {
      if (selectedRuntimeSession && state.activeMachineId !== selectedRuntimeSession.machineId) {
        state.setActiveMachineId(selectedRuntimeSession.machineId);
      } else if (!selectedRuntimeSession && !selectors.selectedProject.machineOnline && state.activeMachineId) {
        state.setActiveMachineId("");
      }
      return;
    }

    const activeTabMachineId = selectors.activeThread?.runtime.machineId;
    const preferredSession = activeTabMachineId
      ? availableRuntimes.find((runtime) => runtime.machineId === activeTabMachineId)
      : undefined;
    const runtime = preferredSession ?? selectors.activeRuntime ?? state.runtimeList[0];
    if (runtime && !state.activeMachineId) state.setActiveMachineId(runtime.machineId);

    if (state.activeTabThreadId || state.openThreads.length) return;

    const initialThreadId = runtime
      ? isFixedWorkspaceSurface
        ? ""
        : preferredThreadIdForRuntime(
          runtime,
          undefined
        )
      : undefined;
    if (initialThreadId) {
      void actions.openThread(initialThreadId).catch(() => actions.clearActiveThreadIfLatest(initialThreadId));
    }
  }, [
    selectors.activeThread?.runtime.machineId,
    state.activeMachineId,
    state.activeTabThreadId,
    selectors.activeRuntime,
    state.initialized,
    selectors.projectList,
    selectors.selectedProject,
    state.selectedProjectKey,
    state.runtimeList,
    state.openThreads.length
  ]);

  const openThreadPresenceKey = JSON.stringify(state.openThreads.flatMap((thread) => {
    const machineId = thread.runtime.machineId;
    if (!machineId) return [];
    const projectTarget = state.threadProjectTargets[thread.threadId];
    return [{
      threadId: thread.threadId,
      machineId,
      workingDirectory: thread.workingDirectory,
      ...(thread.title ? { title: thread.title } : {}),
      ...(projectTarget?.machineId === machineId ? { projectTarget } : {})
    }];
  }));
  useEffect(() => {
    if (!state.initialized) return;
    state.realtimeClient.current?.setOpenThreads(JSON.parse(openThreadPresenceKey));
  }, [state.initialized, openThreadPresenceKey]);

  useEffect(() => {
    if (!state.initialized) return;
    actions.syncThreadSubscriptions(
      subagentThreadSubscriptionIds(selectors.openThreadIds, state.subagentThreadDialog)
    );
  }, [
    selectors.openThreadIdsKey,
    state.initialized,
    state.subagentThreadDialog?.status,
    state.subagentThreadDialog?.threadId
  ]);

  useEffect(() => {
    if (!state.initialized || !state.threadModelDialogOpen) return undefined;
    const machineId = selectors.threadModelDialogMachineId;
    if (!machineId) return undefined;
    const currentCatalog = state.modelCatalogByMachine[machineId];
    if (
      currentCatalog?.status === "loading"
      || currentCatalog?.status === "ready"
      || currentCatalog?.status === "error"
    ) return undefined;
    const refresh = currentCatalog?.refresh === true;
    state.setModelCatalogByMachine((current) => ({
      ...current,
      [machineId]: {
        status: "loading",
        models: currentCatalog?.models ?? [],
        source: currentCatalog?.source,
        updatedAt: currentCatalog?.updatedAt,
        stale: currentCatalog?.stale
      }
    }));
    void apiRouteJson(apiRoutes.runtimeModels, machineId, false, refresh)
      .then((payload) => {
        state.setModelCatalogByMachine((current) => ({
          ...current,
          [machineId]: {
            status: "ready",
            models: Array.isArray(payload.models) ? payload.models : [],
            source: payload.source,
            updatedAt: payload.updatedAt,
            stale: payload.stale
          }
        }));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        state.setModelCatalogByMachine((current) => ({
          ...current,
          [machineId]: currentCatalog?.source === "cache" && currentCatalog.models.length
            ? {
                ...currentCatalog,
                status: "ready",
                refresh: undefined,
                error: message || "Live model catalog refresh failed."
              }
            : {
                status: "error",
                models: [],
                error: message || "Model catalog unavailable."
              }
        }));
      });
  }, [
    selectors.threadModelDialogMachineId,
    state.initialized,
    state.modelCatalogByMachine,
    state.threadModelDialogOpen
  ]);

  useEffect(() => {
    if (!state.initialized) return undefined;
    const targets = new Map<string, { machineId: string; cwd: string }>();
    for (const thread of [
      selectors.activeThread,
      ...subagentDialogConversationThreads(state.subagentThreadDialog)
    ]) {
      const machineId = thread?.runtime.machineId;
      const cwd = thread?.workingDirectory;
      if (!thread?.runtime.online || !machineId || !cwd) continue;
      targets.set(permissionProfileScopeKey(machineId, cwd), { machineId, cwd });
    }
    const pendingTargets = [...targets].filter(([scopeKey]) => {
      const catalog = state.permissionProfilesByScope[scopeKey];
      return !catalog;
    });
    if (!pendingTargets.length) return undefined;
    state.setPermissionProfilesByScope((current) => {
      const next = { ...current };
      for (const [scopeKey] of pendingTargets) {
        if (!next[scopeKey]) next[scopeKey] = { status: "loading", profiles: [] };
      }
      return next;
    });
    for (const [scopeKey, { machineId, cwd }] of pendingTargets) {
      void apiRouteJson(apiRoutes.runtimePermissionProfiles, machineId, cwd)
        .then((payload) => {
          state.setPermissionProfilesByScope((current) => ({
            ...current,
            [scopeKey]: {
              status: "ready",
              profiles: Array.isArray(payload.profiles) ? payload.profiles : []
            }
          }));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          state.setPermissionProfilesByScope((current) => ({
            ...current,
            [scopeKey]: {
              status: "error",
              profiles: [],
              error: message || "Permission profiles unavailable."
            }
          }));
        });
    }
  }, [
    selectors.activeThread,
    state.initialized,
    state.permissionProfilesByScope,
    state.subagentThreadDialog
  ]);

  useEffect(() => {
    if (!state.composerMenuOpen) return undefined;
    const close = () => state.setComposerMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [state.composerMenuOpen]);

  useEffect(() => {
    if (!state.threadControlsMenuOpen) return undefined;
    const close = () => state.setThreadControlsMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [state.threadControlsMenuOpen]);

  useEffect(() => {
    if (!state.messageSelectionToolbar) return undefined;
    const close = () => state.setMessageSelectionToolbar(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [state.messageSelectionToolbar]);

  useEffect(() => {
    state.setMessageSelectionToolbar(null);
  }, [state.activeTabThreadId]);

  useEffect(() => {
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || state.subagentThreadDialog || !selectors.activeThread?.running) return;
      event.preventDefault();
      void actions.stopTurn(selectors.activeThread.threadId);
    };
    window.addEventListener("keydown", stopOnEscape);
    return () => window.removeEventListener("keydown", stopOnEscape);
  }, [selectors.activeThread?.threadId, selectors.activeThread?.running, state.subagentThreadDialog]);

  useEffect(() => {
    const links: HTMLLinkElement[] = [];
    for (const plugin of state.plugins) {
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
  }, [state.plugins]);
};
