// @ts-nocheck
import {
  apiJson,
  appendThreadOrder,
  mergeThreadOrderBySession,
  normalizeMachines,
  normalizeProjects,
  normalizeSessions,
  preferredThreadIdForSession,
  projectKeyFor,
  projectKeyForProject
} from "../appHelpers.js";

export const createProjectActions = (ctx, actions) => {
  const selectProjectSession = async (session) => {
    ctx.setActiveSessionId(session.sessionId);
    ctx.setActiveWorkspacePath(session.workingDirectory);
    const project = ctx.projectList.find((item) => item.session?.sessionId === session.sessionId)
      ?? ctx.projectList.find((item) => item.machineId === session.machineId && item.path === session.workingDirectory);
    if (project) {
      ctx.setSelectedProjectKey(projectKeyForProject(project));
      actions.focusTaskDraftProject(project);
    }
    const activeTabThreadIdForSession = ctx.activeTabThreadBySession[session.sessionId];
    const sessionThreadIds = new Set(session.threads?.map((thread) => thread.threadId) ?? []);
    const targetThreadId = activeTabThreadIdForSession && sessionThreadIds.has(activeTabThreadIdForSession)
      ? activeTabThreadIdForSession
      : preferredThreadIdForSession(session, project);
    if (targetThreadId) {
      await actions.openThread(targetThreadId).catch(() => actions.clearActiveThreadIfLatest(targetThreadId));
    } else {
      ctx.setActiveTabThreadId("");
    }
  };

  const selectProject = async (project) => {
    ctx.setSelectedProjectKey(projectKeyForProject(project));
    actions.focusTaskDraftProject(project);
    ctx.setTaskError("");
    ctx.setProjectOpenError("");
    ctx.setActiveWorkspacePath(project.path);
    if (project.session?.online) {
      await selectProjectSession(project.session);
      return;
    }
    ctx.setActiveSessionId("");
    ctx.setActiveTabThreadId("");
    ctx.latestRequestedThreadId.current = "";
    await openProject(project.path, project.machineId);
  };

  const loadProjectPickerDirectory = async (machineId, targetPath) => {
    const trimmedPath = targetPath?.trim();
    ctx.setProjectPicker((current) => current && current.machineId === machineId ? {
      ...current,
      path: trimmedPath ?? current.path,
      loading: true,
      error: ""
    } : current);
    try {
      const query = trimmedPath ? `?path=${encodeURIComponent(trimmedPath)}` : "";
      const listing = await apiJson(
        `/api/machines/${encodeURIComponent(machineId)}/directories${query}`
      );
      ctx.setProjectPicker((current) => current && current.machineId === machineId ? {
        ...current,
        path: listing.cwd,
        parent: listing.parent,
        home: listing.home,
        entries: listing.entries,
        loading: false,
        error: ""
      } : current);
    } catch (error) {
      ctx.setProjectPicker((current) => current && current.machineId === machineId ? {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const openProjectPicker = (machine) => {
    const summary = ctx.machines.find((item) => item.machineId === machine.key);
    const initialPath = summary?.cwd ?? machine.projects[0]?.path ?? "";
    ctx.setProjectPicker({
      machineId: machine.key,
      path: initialPath,
      entries: [],
      loading: true,
      error: ""
    });
    void loadProjectPickerDirectory(machine.key, initialPath);
  };

  const changeProjectPickerMachine = (machineId) => {
    const summary = ctx.machines.find((machine) => machine.machineId === machineId);
    const initialPath = summary?.cwd ?? "";
    ctx.setProjectPicker({
      machineId,
      path: initialPath,
      entries: [],
      loading: true,
      error: ""
    });
    void loadProjectPickerDirectory(machineId, initialPath);
  };

  const submitProjectPickerPath = (event) => {
    event.preventDefault();
    if (!ctx.projectPicker) return;
    void loadProjectPickerDirectory(ctx.projectPicker.machineId, ctx.projectPicker.path);
  };

  const confirmProjectPicker = async () => {
    if (!ctx.projectPicker) return;
    const opened = await openProject(ctx.projectPicker.path, ctx.projectPicker.machineId);
    if (opened) ctx.setProjectPicker(null);
  };

  const loadThreadPickerCandidates = async (sessionId) => {
    ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? {
      ...current,
      loading: true,
      error: ""
    } : current);
    try {
      const payload = await apiJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/thread-candidates?limit=20`
      );
      ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        loading: false,
        candidates: Array.isArray(payload.threads) ? payload.threads : [],
        error: ""
      } : current);
    } catch (error) {
      ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const openThreadPicker = (session) => {
    ctx.setActiveSessionId(session.sessionId);
    ctx.setActiveWorkspacePath(session.workingDirectory);
    ctx.setThreadPicker({
      sessionId: session.sessionId,
      loading: true,
      error: "",
      candidates: [],
      acting: null
    });
    void loadThreadPickerCandidates(session.sessionId);
  };

  const activateSessionThread = async (sessionId, threadId) => {
    ctx.closedThreadIds.current.delete(threadId);
    const session = ctx.sessionList.find((item) => item.sessionId === sessionId);
    if (session) {
      ctx.setActiveSessionId(session.sessionId);
      ctx.setActiveWorkspacePath(session.workingDirectory);
    }
    ctx.setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: threadId }));
    ctx.setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, threadId));
    if (ctx.sessions.some((session) => session.threadId === threadId)) {
      ctx.latestRequestedThreadId.current = threadId;
      actions.subscribeThread(threadId, ctx.threadLastSeqs.current.get(threadId) ?? 0);
      ctx.setActiveTabThreadId(threadId);
      return;
    }
    await actions.openThread(threadId);
  };

  const threadIsOpenForSession = (sessionId, threadId) => {
    const session = ctx.sessionList.find((item) => item.sessionId === sessionId);
    return Boolean(
      session?.threads?.some((thread) => thread.threadId === threadId)
      || (ctx.threadOrderBySession[sessionId] ?? []).includes(threadId)
      || ctx.sessions.some((session) => session.threadId === threadId)
    );
  };

  const createSessionThread = async () => {
    if (!ctx.threadPicker) return;
    const sessionId = ctx.threadPicker.sessionId;
    ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? { ...current, acting: "new", error: "" } : current);
    try {
      const thread = await apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "new" })
      });
      ctx.setThreadPicker(null);
      await activateSessionThread(sessionId, thread.threadId);
    } catch (error) {
      ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        acting: null,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const chooseThreadCandidate = async (candidate) => {
    if (!ctx.threadPicker) return;
    const sessionId = ctx.threadPicker.sessionId;
    if (threadIsOpenForSession(sessionId, candidate.threadId)) {
      ctx.setThreadPicker(null);
      await activateSessionThread(sessionId, candidate.threadId);
      return;
    }
    ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? {
      ...current,
      acting: candidate.threadId,
      error: ""
    } : current);
    try {
      const thread = await apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", threadId: candidate.threadId })
      });
      ctx.setThreadPicker(null);
      await activateSessionThread(sessionId, thread.threadId);
    } catch (error) {
      ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        acting: null,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const openProject = async (projectPath, machineId) => {
    const trimmedPath = projectPath.trim();
    if (!trimmedPath) return false;
    const key = `${machineId ?? ""}:${trimmedPath}`;
    if (machineId) {
      ctx.setSelectedProjectKey(projectKeyFor(machineId, trimmedPath));
      actions.focusTaskDraftProject({ machineId, path: trimmedPath });
    }
    ctx.setProjectOpenError("");
    ctx.setActiveWorkspacePath(trimmedPath);
    ctx.setActiveSessionId("");
    ctx.setActiveTabThreadId("");
    ctx.latestRequestedThreadId.current = "";
    ctx.setProjectPicker((current) => current && current.machineId === machineId ? { ...current, error: "" } : current);
    ctx.setOpeningProjectKey(key);
    try {
      const payload = await apiJson("/api/projects/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: trimmedPath, machineId: machineId || undefined, reuse: true })
      });
      ctx.setMachines(normalizeMachines(payload.machines));
      const freshProjects = normalizeProjects(payload.projects);
      ctx.setProjects(freshProjects);
      ctx.setProjectOpenError("");
      ctx.setActiveWorkspacePath(payload.result?.cwd ?? trimmedPath);
      const freshSessions = await apiJson("/api/sessions")
        .then((data) => normalizeSessions(data.sessions))
        .catch(() => ctx.sessionList);
      ctx.setSessionList(freshSessions);
      ctx.setThreadOrderBySession((current) => mergeThreadOrderBySession(current, freshSessions));
      const sessionId = payload.result?.sessionId;
      const project = freshProjects.find((item) => item.path === (payload.result?.cwd ?? trimmedPath));
      const session = sessionId
        ? project?.session?.sessionId === sessionId
          ? project.session
          : freshSessions.find((item) => item.sessionId === sessionId)
        : undefined;
      if (session && payload.result?.threadId) await activateSessionThread(session.sessionId, payload.result.threadId);
      else if (session) await selectProjectSession(session);
      else if (payload.result?.threadId) await actions.openThread(payload.result.threadId).catch(() => actions.clearActiveThreadIfLatest(payload.result.threadId));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.setProjectOpenError(message);
      ctx.setProjectPicker((current) => current && current.machineId === machineId ? { ...current, error: message } : current);
      return false;
    } finally {
      ctx.setOpeningProjectKey((current) => current === key ? "" : current);
    }
  };

  const deleteProject = async (project) => {
    if (!window.confirm(`Remove ${project.name} from CodexHub projects?\n\nThis does not delete files. Active sessions for this project will be stopped.`)) return;
    ctx.setDeletingProjectId(project.projectId);
    try {
      const payload = await apiJson(`/api/projects/${encodeURIComponent(project.projectId)}`, {
        method: "DELETE"
      });
      ctx.setMachines(normalizeMachines(payload.machines));
      ctx.setProjects(normalizeProjects(payload.projects));
      if (ctx.selectedProjectKey === projectKeyForProject(project)) ctx.setSelectedProjectKey("");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setDeletingProjectId((current) => current === project.projectId ? "" : current);
    }
  };

  const toggleProjectMachineGroup = (machineKey) => {
    ctx.setCollapsedProjectMachineKeys((current) =>
      current.includes(machineKey)
        ? current.filter((key) => key !== machineKey)
        : [...current, machineKey]
    );
  };

  const switchSessionThread = async (threadId) => {
    if (!ctx.activeProjectSession || threadId === ctx.activeTabThreadId) return;
    ctx.setActiveTabThreadBySession((current) => ({ ...current, [ctx.activeProjectSession.sessionId]: threadId }));
    await actions.openThread(threadId).catch(() => actions.clearActiveThreadIfLatest(threadId));
  };

  return {
    selectProjectSession,
    selectProject,
    loadProjectPickerDirectory,
    openProjectPicker,
    changeProjectPickerMachine,
    submitProjectPickerPath,
    confirmProjectPicker,
    loadThreadPickerCandidates,
    openThreadPicker,
    activateSessionThread,
    threadIsOpenForSession,
    createSessionThread,
    chooseThreadCandidate,
    openProject,
    deleteProject,
    toggleProjectMachineGroup,
    switchSessionThread
  };
};
