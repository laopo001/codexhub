import { useEffect } from "react";
import { storageKey } from "./appConfig.js";
import {
  apiRouteJson,
  machineProjectLauncher,
  permissionProfileScopeKey,
  preferredThreadIdForSession,
  primeTaskCompletionSound,
  runtimeSessionForProject
} from "./appHelpers.js";
import type { AppSelectors } from "./appSelectors.js";
import type { AppState } from "./appState.js";
import { apiRoutes } from "../shared/apiRoutes.js";

type AppEffectsActions = {
  clearActiveThreadIfLatest: (threadId: string) => void;
  initialize: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  stopTurn: (threadId: string) => unknown;
  syncThreadSubscriptions: (threadIds: string[]) => void;
};

type AppEffectsInput = {
  actions: AppEffectsActions;
  resizeComposerTextarea: (textarea: HTMLTextAreaElement | null) => void;
  selectors: AppSelectors;
  state: AppState;
};

export const useAppEffects = ({ actions, resizeComposerTextarea, selectors, state }: AppEffectsInput) => {
  useEffect(() => {
    resizeComposerTextarea(state.composerTextareaRef.current);
  }, [selectors.activeThread?.threadId]);

  useEffect(() => {
    void actions.initialize();
    return () => {
      state.realtimeClient.current?.disconnect();
      state.realtimeClient.current = null;
      state.realtimeThreadSubscriptions.current.clear();
    };
  }, []);

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
    localStorage.setItem(storageKey, JSON.stringify({
      activeWorkspacePath: state.activeWorkspacePath,
      activeSessionId: state.activeSessionId,
      activeTabThreadId: state.activeTabThreadId,
      activeTabThreadBySession: state.activeTabThreadBySession,
      openThreadIds: selectors.openThreadIds,
      threadOrderBySession: state.threadOrderBySession,
      selectedProjectKey: state.selectedProjectKey,
      projectSearch: state.sidebarDraftStore.getSnapshot().projectSearch,
      messageDisplayMode: state.messageDisplayMode,
      sidebarCollapsed: state.sidebarCollapsed,
      collapsedProjectMachineKeys: state.collapsedProjectMachineKeys
    }));
  }, [
    state.activeWorkspacePath,
    state.activeSessionId,
    state.activeTabThreadBySession,
    state.activeTabThreadId,
    selectors.openThreadIds,
    state.selectedProjectKey,
    state.messageDisplayMode,
    state.sidebarCollapsed,
    state.collapsedProjectMachineKeys,
    state.threadOrderBySession,
    state.initialized
  ]);

  useEffect(() => {
    let projectSearch = state.sidebarDraftStore.getSnapshot().projectSearch;
    let timer: number | null = null;
    const persistProjectSearch = () => {
      timer = null;
      try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        const stored = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        localStorage.setItem(storageKey, JSON.stringify({ ...stored, projectSearch }));
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
    const availableSessions = state.sessionList;
    if (!availableSessions.length) {
      if (state.activeSessionId) state.setActiveSessionId("");
      if (state.activeTabThreadId) state.setActiveTabThreadId("");
      return;
    }

    const selectedRuntimeSession = runtimeSessionForProject(selectors.selectedProject ?? undefined, state.sessionList);
    if (state.selectedProjectKey && selectors.selectedProject) {
      if (selectedRuntimeSession && state.activeSessionId !== selectedRuntimeSession.sessionId) {
        state.setActiveSessionId(selectedRuntimeSession.sessionId);
      } else if (!selectedRuntimeSession && !selectors.selectedProject.machineOnline && state.activeSessionId) {
        state.setActiveSessionId("");
      }
      return;
    }

    const activeTabSessionId = selectors.activeThread?.session.sessionId;
    const preferredSession = activeTabSessionId
      ? availableSessions.find((session) => session.sessionId === activeTabSessionId)
      : undefined;
    const session = preferredSession ?? selectors.activeRuntimeSession ?? state.sessionList[0];
    if (session && !state.activeSessionId) state.setActiveSessionId(session.sessionId);

    if (state.activeTabThreadId || state.openThreads.length) return;

    const initialThreadId = session
      ? preferredThreadIdForSession(
        session,
        selectors.projectList.find((project) =>
          project.machineId === session.machineId
          && project.path === session.workingDirectory
        )
      )
      : undefined;
    if (initialThreadId) {
      void actions.openThread(initialThreadId).catch(() => actions.clearActiveThreadIfLatest(initialThreadId));
    }
  }, [
    selectors.activeThread?.session.sessionId,
    state.activeSessionId,
    state.activeTabThreadId,
    selectors.activeRuntimeSession,
    state.initialized,
    selectors.projectList,
    selectors.selectedProject,
    state.selectedProjectKey,
    state.sessionList,
    state.openThreads.length
  ]);

  useEffect(() => {
    if (!state.initialized) return;
    actions.syncThreadSubscriptions(selectors.openThreadIds);
  }, [selectors.openThreadIdsKey, state.initialized]);

  useEffect(() => {
    if (!state.initialized || !state.threadModelDialogOpen) return undefined;
    const sessionId = selectors.activeRuntimeSession?.sessionId;
    if (!sessionId) return undefined;
    const currentCatalog = state.modelCatalogBySession[sessionId];
    if (
      currentCatalog?.status === "loading"
      || currentCatalog?.status === "ready"
      || currentCatalog?.status === "error"
    ) return undefined;
    state.setModelCatalogBySession((current) => ({
      ...current,
      [sessionId]: { status: "loading", models: [] }
    }));
    void apiRouteJson(apiRoutes.sessionModels, sessionId)
      .then((payload) => {
        state.setModelCatalogBySession((current) => ({
          ...current,
          [sessionId]: {
            status: "ready",
            models: Array.isArray(payload.models) ? payload.models : []
          }
        }));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        state.setModelCatalogBySession((current) => ({
          ...current,
          [sessionId]: {
            status: "error",
            models: [],
            error: message || "Model catalog unavailable."
          }
        }));
      });
  }, [
    selectors.activeRuntimeSession?.sessionId,
    state.initialized,
    state.modelCatalogBySession,
    state.threadModelDialogOpen
  ]);

  useEffect(() => {
    if (!state.initialized || !state.composerMenuOpen) return undefined;
    const sessionId = selectors.activeThread?.session.sessionId;
    const cwd = selectors.activeThread?.workingDirectory;
    if (!sessionId || !cwd) return undefined;
    const scopeKey = permissionProfileScopeKey(sessionId, cwd);
    let cancelled = false;
    state.setPermissionProfilesByScope((current) => ({
      ...current,
      [scopeKey]: { status: "loading", profiles: [] }
    }));
    void apiRouteJson(apiRoutes.sessionPermissionProfiles, sessionId, cwd)
      .then((payload) => {
        if (cancelled) return;
        state.setPermissionProfilesByScope((current) => ({
          ...current,
          [scopeKey]: {
            status: "ready",
            profiles: Array.isArray(payload.profiles) ? payload.profiles : []
          }
        }));
      })
      .catch((error) => {
        if (cancelled) return;
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
    return () => {
      cancelled = true;
    };
  }, [
    selectors.activeThread?.session.sessionId,
    selectors.activeThread?.workingDirectory,
    state.composerMenuOpen,
    state.initialized
  ]);

  useEffect(() => {
    if (!state.activeTabThreadId) return;
    state.messagesShouldFollowRef.current = true;
  }, [state.activeTabThreadId]);

  useEffect(() => {
    if (!state.composerMenuOpen) return undefined;
    const close = () => state.setComposerMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [state.composerMenuOpen]);

  useEffect(() => {
    if (!state.threadControlsMenuOpen) return undefined;
    const close = () => state.setThreadControlsMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [state.threadControlsMenuOpen]);

  useEffect(() => {
    if (!state.messageContextMenu) return undefined;
    const close = () => state.setMessageContextMenu(null);
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
  }, [state.messageContextMenu]);

  useEffect(() => {
    state.setMessageContextMenu(null);
  }, [state.activeTabThreadId]);

  useEffect(() => {
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !selectors.activeThread?.running) return;
      event.preventDefault();
      void actions.stopTurn(selectors.activeThread.threadId);
    };
    window.addEventListener("keydown", stopOnEscape);
    return () => window.removeEventListener("keydown", stopOnEscape);
  }, [selectors.activeThread?.threadId, selectors.activeThread?.running]);

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
