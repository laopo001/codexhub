import type React from "react";
import {
  apiJson,
  appendThreadOrder,
  mergeThreadOrderBySession,
  normalizeMachines,
  normalizeProjects,
  normalizeSessions,
  preferredThreadIdForSession,
  fixedProject,
  machineProjectCatalogEditable,
  machineProjectLauncher,
  projectKeyFor,
  projectKeyForProject
} from "../appHelpers.js";
import type {
  OpenThreadState,
  CodexThreadCandidate,
  MachineDirectoryListing,
  MachineSummary,
  ProjectMachineGroup,
  ProjectPickerState,
  ProjectsPayload,
  ProjectSummary,
  SessionSummary,
  SessionView,
  ThreadDetail,
  ThreadPickerState
} from "../types.js";

type SessionsPayload = {
  sessions?: SessionSummary[];
};

type ThreadCandidatesPayload = {
  threads?: CodexThreadCandidate[];
};

type ProjectOpenPayload = ProjectsPayload & {
  result?: {
    cwd?: string;
    sessionId?: string;
    threadId?: string;
  };
};

type ProjectPatchInput = {
  pinned?: boolean;
};

type ProjectActionsContext = {
  activeProjectSession?: SessionView | null;
  activeTabThreadBySession: Record<string, string>;
  activeTabThreadId: string;
  closedThreadIds: React.MutableRefObject<Set<string>>;
  latestRequestedThreadId: React.MutableRefObject<string>;
  machines: MachineSummary[];
  projectList: ProjectSummary[];
  projectPicker: ProjectPickerState | null;
  selectedProjectKey: string;
  sessionList: SessionView[];
  openThreads: OpenThreadState[];
  threadOrderBySession: Record<string, string[]>;
  threadLastSeqs: React.MutableRefObject<Map<string, number>>;
  threadPicker: ThreadPickerState | null;
  setActiveSessionId: React.Dispatch<React.SetStateAction<string>>;
  setActiveTabThreadBySession: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setActiveTabThreadId: React.Dispatch<React.SetStateAction<string>>;
  setActiveWorkspacePath: React.Dispatch<React.SetStateAction<string>>;
  setCollapsedProjectMachineKeys: React.Dispatch<React.SetStateAction<string[]>>;
  setDeletingProjectId: React.Dispatch<React.SetStateAction<string>>;
  setMachines: React.Dispatch<React.SetStateAction<MachineSummary[]>>;
  setOpeningProjectKey: React.Dispatch<React.SetStateAction<string>>;
  setProjectOpenError: React.Dispatch<React.SetStateAction<string>>;
  setProjectPicker: React.Dispatch<React.SetStateAction<ProjectPickerState | null>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setSelectedProjectKey: React.Dispatch<React.SetStateAction<string>>;
  setSessionList: React.Dispatch<React.SetStateAction<SessionView[]>>;
  setTaskError: React.Dispatch<React.SetStateAction<string>>;
  setThreadOrderBySession: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setThreadPicker: React.Dispatch<React.SetStateAction<ThreadPickerState | null>>;
};

export type ProjectActionsDependencies = {
  clearActiveThreadIfLatest: (threadId: string) => void;
  focusTaskDraftProject: (project: Pick<ProjectSummary, "machineId" | "path">) => void;
  openThread: (threadId: string) => Promise<void>;
  subscribeThread: (threadId: string, after: number) => void;
};

export type ProjectActions = {
  selectProjectSession: (session: SessionView) => Promise<void>;
  selectSessionThread: (session: SessionView, threadId: string) => Promise<void>;
  selectProject: (project: ProjectSummary) => Promise<void>;
  loadProjectPickerDirectory: (machineId: string, targetPath?: string) => Promise<void>;
  openProjectPicker: (machine: ProjectMachineGroup) => void;
  changeProjectPickerMachine: (machineId: string) => void;
  submitProjectPickerPath: (event: React.FormEvent<HTMLFormElement>) => void;
  confirmProjectPicker: () => Promise<void>;
  loadThreadPickerCandidates: (sessionId: string) => Promise<void>;
  openThreadPicker: (session: SessionView) => void;
  activateSessionThread: (sessionId: string, threadId: string) => Promise<void>;
  threadIsOpenForSession: (sessionId: string, threadId: string) => boolean;
  createSessionThread: () => Promise<void>;
  chooseThreadCandidate: (candidate: CodexThreadCandidate) => Promise<void>;
  openProject: (projectPath: string, machineId?: string) => Promise<boolean>;
  deleteProject: (project: ProjectSummary) => Promise<void>;
  patchProject: (project: ProjectSummary, patch: ProjectPatchInput) => Promise<void>;
  toggleProjectPinned: (project: ProjectSummary) => Promise<void>;
  toggleProjectMachineGroup: (machineKey: string) => void;
  switchSessionThread: (threadId: string) => Promise<void>;
};

export const createProjectActions = (ctx: ProjectActionsContext, deps: ProjectActionsDependencies): ProjectActions => {
  const fixedCatalogMessage = "This machine exposes a fixed workspace project list.";
  const editableProjectPickerMachine = (machineId: string) =>
    ctx.machines.find((machine) =>
      machine.machineId === machineId
      && machine.online
      && machineProjectLauncher(machine)
      && machineProjectCatalogEditable(machine)
    );

  const selectProjectSession = async (session: SessionView) => {
    ctx.setActiveSessionId(session.sessionId);
    const selectedProject = ctx.selectedProjectKey
      ? ctx.projectList.find((item) => projectKeyForProject(item) === ctx.selectedProjectKey)
      : undefined;
    const project = selectedProject?.session?.sessionId === session.sessionId
      ? selectedProject
      : ctx.projectList.find((item) => item.session?.sessionId === session.sessionId && item.path === session.workingDirectory)
      ?? ctx.projectList.find((item) => item.machineId === session.machineId && item.path === session.workingDirectory);
    ctx.setActiveWorkspacePath(project?.path ?? session.workingDirectory);
    if (project) {
      ctx.setSelectedProjectKey(projectKeyForProject(project));
      deps.focusTaskDraftProject(project);
    }
    const activeTabThreadIdForSession = ctx.activeTabThreadBySession[session.sessionId];
    const sessionThreadIds = new Set(session.threads?.map((thread) => thread.threadId) ?? []);
    const targetThreadId = activeTabThreadIdForSession && sessionThreadIds.has(activeTabThreadIdForSession)
      ? activeTabThreadIdForSession
      : preferredThreadIdForSession(session, project);
    if (targetThreadId) {
      await deps.openThread(targetThreadId).catch(() => deps.clearActiveThreadIfLatest(targetThreadId));
    } else {
      ctx.setActiveTabThreadId("");
    }
  };

  const selectSessionThread = async (session: SessionView, threadId: string) => {
    ctx.setSelectedProjectKey("");
    ctx.setTaskError("");
    ctx.setProjectOpenError("");
    ctx.setThreadPicker(null);
    ctx.setActiveWorkspacePath(session.workingDirectory);
    await activateSessionThread(session.sessionId, threadId);
  };

  const selectProject = async (project: ProjectSummary) => {
    ctx.setSelectedProjectKey(projectKeyForProject(project));
    deps.focusTaskDraftProject(project);
    ctx.setTaskError("");
    ctx.setProjectOpenError("");
    ctx.setActiveWorkspacePath(project.path);
    if (project.session?.online) {
      ctx.setActiveSessionId(project.session.sessionId);
      return;
    }
    await openProject(project.path, project.machineId);
  };

  const loadProjectPickerDirectory = async (machineId: string, targetPath?: string) => {
    if (!editableProjectPickerMachine(machineId)) {
      ctx.setProjectPicker((current) => current && current.machineId === machineId ? {
        ...current,
        loading: false,
        error: fixedCatalogMessage
      } : current);
      return;
    }
    const trimmedPath = targetPath?.trim();
    ctx.setProjectPicker((current) => current && current.machineId === machineId ? {
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

  const openProjectPicker = (machine: ProjectMachineGroup) => {
    const browseMachineId = machine.machineId ?? machine.key;
    const summary = editableProjectPickerMachine(browseMachineId);
    if (!summary) return;
    const initialPath = summary?.cwd ?? machine.projects[0]?.path ?? "";
    ctx.setProjectPicker({
      machineId: browseMachineId,
      path: initialPath,
      entries: [],
      loading: true,
      error: ""
    });
    void loadProjectPickerDirectory(browseMachineId, initialPath);
  };

  const changeProjectPickerMachine = (machineId: string) => {
    const summary = editableProjectPickerMachine(machineId);
    if (!summary) {
      ctx.setProjectPicker((current) => current ? { ...current, loading: false, error: fixedCatalogMessage } : current);
      return;
    }
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

  const submitProjectPickerPath = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ctx.projectPicker) return;
    void loadProjectPickerDirectory(ctx.projectPicker.machineId, ctx.projectPicker.path);
  };

  const confirmProjectPicker = async () => {
    if (!ctx.projectPicker) return;
    if (!editableProjectPickerMachine(ctx.projectPicker.machineId)) {
      ctx.setProjectPicker((current) => current ? { ...current, loading: false, error: fixedCatalogMessage } : current);
      return;
    }
    const opened = await openProject(ctx.projectPicker.path, ctx.projectPicker.machineId);
    if (opened) ctx.setProjectPicker(null);
  };

  const loadThreadPickerCandidates = async (sessionId: string, workingDirectory?: string) => {
    ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? {
      ...current,
      loading: true,
      error: ""
    } : current);
    try {
      const cwd = workingDirectory ?? ctx.threadPicker?.workingDirectory;
      const query = new URLSearchParams({ limit: "20" });
      if (cwd) query.set("cwd", cwd);
      const payload = await apiJson<ThreadCandidatesPayload>(
        `/api/sessions/${encodeURIComponent(sessionId)}/thread-candidates?${query.toString()}`
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

  const openThreadPicker = (session: SessionView) => {
    ctx.setActiveSessionId(session.sessionId);
    ctx.setActiveWorkspacePath(session.workingDirectory);
    ctx.setThreadPicker({
      sessionId: session.sessionId,
      workingDirectory: session.workingDirectory,
      loading: true,
      error: "",
      candidates: [],
      acting: null
    });
    void loadThreadPickerCandidates(session.sessionId, session.workingDirectory);
  };

  const activateSessionThread = async (sessionId: string, threadId: string) => {
    ctx.closedThreadIds.current.delete(threadId);
    const session = ctx.sessionList.find((item) => item.sessionId === sessionId);
    const thread = session?.threads?.find((item) => item.threadId === threadId)
      ?? ctx.projectList
        .flatMap((project) => project.session?.sessionId === sessionId ? project.session.threads ?? [] : [])
        .find((item) => item.threadId === threadId);
    if (session) {
      ctx.setActiveSessionId(session.sessionId);
      ctx.setActiveWorkspacePath(thread?.workingDirectory ?? session.workingDirectory);
    }
    ctx.setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: threadId }));
    ctx.setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, threadId));
    if (ctx.openThreads.some((thread) => thread.threadId === threadId)) {
      ctx.latestRequestedThreadId.current = threadId;
      deps.subscribeThread(threadId, ctx.threadLastSeqs.current.get(threadId) ?? 0);
      ctx.setActiveTabThreadId(threadId);
      return;
    }
    await deps.openThread(threadId);
  };

  const threadIsOpenForSession = (sessionId: string, threadId: string) => {
    const session = ctx.sessionList.find((item) => item.sessionId === sessionId);
    return Boolean(
      session?.threads?.some((thread) => thread.threadId === threadId)
      || (ctx.threadOrderBySession[sessionId] ?? []).includes(threadId)
      || ctx.openThreads.some((thread) => thread.threadId === threadId)
    );
  };

  const createSessionThread = async () => {
    if (!ctx.threadPicker) return;
    const sessionId = ctx.threadPicker.sessionId;
    ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? { ...current, acting: "new", error: "" } : current);
    try {
      const thread = await apiJson<ThreadDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "new", cwd: ctx.threadPicker.workingDirectory })
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

  const chooseThreadCandidate = async (candidate: CodexThreadCandidate) => {
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
      const thread = await apiJson<ThreadDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "resume",
          threadId: candidate.threadId,
          cwd: ctx.threadPicker.workingDirectory
        })
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

  const openProject = async (projectPath: string, machineId?: string) => {
    const trimmedPath = projectPath.trim();
    if (!trimmedPath) return false;
    const key = `${machineId ?? ""}:${trimmedPath}`;
    if (machineId) {
      ctx.setSelectedProjectKey(projectKeyFor(machineId, trimmedPath));
      deps.focusTaskDraftProject({ machineId, path: trimmedPath });
    }
    ctx.setProjectOpenError("");
    ctx.setActiveWorkspacePath(trimmedPath);
    ctx.setProjectPicker((current) => current && current.machineId === machineId ? { ...current, error: "" } : current);
    ctx.setOpeningProjectKey(key);
    try {
      const existingProject = machineId
        ? ctx.projectList.find((project) => project.machineId === machineId && project.path === trimmedPath)
        : undefined;
      const vscodeSource = existingProject?.source?.kind === "vscode" ? existingProject.source : undefined;
      const payload = await apiJson<ProjectOpenPayload>("/api/projects/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: trimmedPath,
          machineId: machineId || undefined,
          reuse: true,
          persist: vscodeSource ? false : undefined,
          source: vscodeSource
        })
      });
      ctx.setMachines(normalizeMachines(payload.machines));
      const freshProjects = normalizeProjects(payload.projects);
      ctx.setProjects(freshProjects);
      ctx.setProjectOpenError("");
      ctx.setActiveWorkspacePath(payload.result?.cwd ?? trimmedPath);
      const freshSessions = await apiJson<SessionsPayload>("/api/sessions")
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
      if (session) ctx.setActiveSessionId(session.sessionId);
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

  const deleteProject = async (project: ProjectSummary) => {
    if (fixedProject(project)) return;
    const prompt = `Remove ${project.name} from CodexHub projects?\n\nThis does not delete files or close open thread tabs.`;
    if (!window.confirm(prompt)) return;
    ctx.setDeletingProjectId(project.projectId);
    try {
      const payload = await apiJson<ProjectsPayload>(`/api/projects/${encodeURIComponent(project.projectId)}`, {
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

  const applyProjectPayload = (payload: ProjectsPayload) => {
    ctx.setMachines(normalizeMachines(payload.machines));
    const freshProjects = normalizeProjects(payload.projects);
    ctx.setProjects(freshProjects);
    return freshProjects;
  };

  const patchProject = async (project: ProjectSummary, patch: ProjectPatchInput) => {
    ctx.setProjectOpenError("");
    try {
      const payload = await apiJson<ProjectsPayload>(`/api/projects/${encodeURIComponent(project.projectId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      applyProjectPayload(payload);
    } catch (error) {
      ctx.setProjectOpenError(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleProjectPinned = async (project: ProjectSummary) => {
    if (fixedProject(project)) return;
    await patchProject(project, { pinned: !project.pinned });
  };

  const toggleProjectMachineGroup = (machineKey: string) => {
    ctx.setCollapsedProjectMachineKeys((current) =>
      current.includes(machineKey)
        ? current.filter((key) => key !== machineKey)
        : [...current, machineKey]
    );
  };

  const switchSessionThread = async (threadId: string) => {
    if (threadId === ctx.activeTabThreadId) return;
    const thread = ctx.openThreads.find((item) => item.threadId === threadId);
    const sessionId = thread?.session.sessionId ?? ctx.activeProjectSession?.sessionId ?? "";
    if (sessionId) {
      if (!ctx.selectedProjectKey) ctx.setActiveSessionId(sessionId);
      ctx.setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: threadId }));
    }
    if (thread) {
      if (!ctx.selectedProjectKey) ctx.setActiveWorkspacePath(thread.workingDirectory);
    }
    await deps.openThread(threadId).catch(() => deps.clearActiveThreadIfLatest(threadId));
  };

  return {
    selectProjectSession,
    selectSessionThread,
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
    patchProject,
    toggleProjectPinned,
    toggleProjectMachineGroup,
    switchSessionThread
  };
};
