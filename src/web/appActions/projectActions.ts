import type React from "react";
import type { ProjectUpdateInput } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import {
  apiRouteJson,
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
  projectKeyForProject,
  runtimeSessionForProject
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
  SessionView,
  ThreadDetail,
  ThreadPickerState
} from "../types.js";

type ProjectActionsContext = {
  activeRuntimeSession?: SessionView | null;
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
  setProjectActionError: React.Dispatch<React.SetStateAction<string>>;
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

type StartProjectThreadOptions = {
  activateThread?: boolean;
  openThreadPicker?: boolean;
};

export type ProjectActions = {
  selectProjectSession: (session: SessionView) => Promise<void>;
  selectSessionThread: (session: SessionView, threadId: string) => Promise<void>;
  selectProject: (project: ProjectSummary) => Promise<void>;
  loadProjectPickerDirectory: (machineId: string, targetPath?: string) => Promise<void>;
  showProjectPicker: (machine: ProjectMachineGroup) => void;
  changeProjectPickerMachine: (machineId: string) => void;
  submitProjectPickerPath: (event: React.FormEvent<HTMLFormElement>) => void;
  confirmProjectPicker: () => Promise<void>;
  loadThreadPickerCandidates: (sessionId: string) => Promise<void>;
  openThreadPicker: (session: SessionView, workingDirectory?: string) => void;
  openSelectedProjectThreadPicker: () => Promise<void>;
  activateSessionThread: (sessionId: string, threadId: string) => Promise<void>;
  threadIsOpenForSession: (sessionId: string, threadId: string) => boolean;
  createSessionThread: () => Promise<void>;
  createWorktreeThread: () => Promise<void>;
  chooseThreadCandidate: (candidate: CodexThreadCandidate) => Promise<void>;
  startProjectThread: (projectPath: string, machineId?: string, options?: StartProjectThreadOptions) => Promise<boolean>;
  deleteProject: (project: ProjectSummary) => Promise<void>;
  patchProject: (project: ProjectSummary, patch: ProjectUpdateInput) => Promise<void>;
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
    const project = selectedProject?.machineId === session.machineId
      ? selectedProject
      : ctx.projectList.find((item) => item.machineId === session.machineId && item.path === session.workingDirectory);
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
    ctx.setProjectActionError("");
    ctx.setThreadPicker(null);
    ctx.setActiveWorkspacePath(session.workingDirectory);
    await activateSessionThread(session.sessionId, threadId);
  };

  const selectProject = async (project: ProjectSummary) => {
    ctx.setSelectedProjectKey(projectKeyForProject(project));
    deps.focusTaskDraftProject(project);
    ctx.setTaskError("");
    ctx.setProjectActionError("");
    ctx.setActiveWorkspacePath(project.path);
    ctx.setThreadPicker(null);
    ctx.setActiveTabThreadId("");
    const runtimeSession = runtimeSessionForProject(project, ctx.sessionList);
    if (runtimeSession?.online) ctx.setActiveSessionId(runtimeSession.sessionId);
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
      const listing = await apiRouteJson(apiRoutes.machineDirectories, machineId, trimmedPath);
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

  const showProjectPicker = (machine: ProjectMachineGroup) => {
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
    const opened = await startProjectThread(ctx.projectPicker.path, ctx.projectPicker.machineId);
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
      const payload = await apiRouteJson(apiRoutes.threadCandidates, sessionId, cwd, 50);
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

  const openThreadPicker = (session: SessionView, workingDirectory = session.workingDirectory) => {
    ctx.setActiveSessionId(session.sessionId);
    ctx.setActiveWorkspacePath(workingDirectory);
    ctx.setThreadPicker({
      sessionId: session.sessionId,
      workingDirectory,
      loading: true,
      error: "",
      candidates: [],
      searchQuery: "",
      acting: null,
      worktreeBranch: "",
      worktreeBaseRef: "",
      worktreePath: ""
    });
    void loadThreadPickerCandidates(session.sessionId, workingDirectory);
  };

  const openSelectedProjectThreadPicker = async () => {
    const selectedProject = ctx.selectedProjectKey
      ? ctx.projectList.find((project) => projectKeyForProject(project) === ctx.selectedProjectKey)
      : undefined;
    if (!selectedProject) {
      const session = ctx.activeRuntimeSession;
      if (session?.online) openThreadPicker(session);
      return;
    }
    ctx.setTaskError("");
    ctx.setProjectActionError("");
    ctx.setActiveWorkspacePath(selectedProject.path);
    const runtimeSession = runtimeSessionForProject(selectedProject, ctx.sessionList);
    if (runtimeSession?.online) {
      openThreadPicker(runtimeSession, selectedProject.path);
      return;
    }
    if (!selectedProject.machineOnline) {
      ctx.setProjectActionError(`Machine offline for project: ${selectedProject.name}`);
      return;
    }
    await startProjectThread(selectedProject.path, selectedProject.machineId, {
      activateThread: false,
      openThreadPicker: true
    });
  };

  const activateSessionThread = async (sessionId: string, threadId: string) => {
    ctx.closedThreadIds.current.delete(threadId);
    const session = ctx.sessionList.find((item) => item.sessionId === sessionId);
    const thread = session?.threads?.find((item) => item.threadId === threadId)
      ?? ctx.openThreads.find((item) => item.threadId === threadId);
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
      const thread = await apiRouteJson(apiRoutes.createSessionThread, sessionId, {
        action: "new",
        cwd: ctx.threadPicker.workingDirectory
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

  const createWorktreeThread = async () => {
    if (!ctx.threadPicker) return;
    const picker = ctx.threadPicker;
    const sessionId = picker.sessionId;
    const branch = picker.worktreeBranch.trim();
    if (!branch) {
      ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        error: "Worktree branch is required."
      } : current);
      return;
    }
    const session = ctx.sessionList.find((item) => item.sessionId === sessionId);
    const parentProject = ctx.projectList.find((project) =>
      session?.machineId
      && project.machineId === session.machineId
      && project.path === picker.workingDirectory
    );
    if (!parentProject) {
      ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? {
        ...current,
        error: "Parent project is not available."
      } : current);
      return;
    }
    ctx.setThreadPicker((current) => current && current.sessionId === sessionId ? { ...current, acting: "worktree", error: "" } : current);
    try {
      const payload = await apiRouteJson(apiRoutes.startWorktreeThread, {
        parentProjectId: parentProject.projectId,
        branch,
        baseRef: picker.worktreeBaseRef.trim() || undefined,
        path: picker.worktreePath.trim() || undefined,
        reuse: true
      });
      ctx.setMachines(normalizeMachines(payload.machines));
      const freshProjects = normalizeProjects(payload.projects);
      ctx.setProjects(freshProjects);
      const cwd = payload.result?.cwd ?? payload.worktree?.path ?? "";
      if (cwd) {
        ctx.setActiveWorkspacePath(cwd);
        ctx.setSelectedProjectKey(projectKeyFor(parentProject.machineId, cwd));
        deps.focusTaskDraftProject({ machineId: parentProject.machineId, path: cwd });
      }
      const freshSessions = await apiRouteJson(apiRoutes.sessions)
        .then((data) => normalizeSessions(data.sessions))
        .catch(() => ctx.sessionList);
      ctx.setSessionList(freshSessions);
      ctx.setThreadOrderBySession((current) => mergeThreadOrderBySession(current, freshSessions));
      ctx.setThreadPicker(null);
      const openedSessionId = payload.result?.sessionId;
      if (openedSessionId && payload.result?.threadId) {
        await activateSessionThread(openedSessionId, payload.result.threadId);
      } else if (openedSessionId) {
        ctx.setActiveSessionId(openedSessionId);
      }
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
      const thread = await apiRouteJson(apiRoutes.createSessionThread, sessionId, {
        action: "resume",
        threadId: candidate.threadId,
        cwd: ctx.threadPicker.workingDirectory
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

  const startProjectThread = async (projectPath: string, machineId?: string, options: StartProjectThreadOptions = {}) => {
    const trimmedPath = projectPath.trim();
    if (!trimmedPath) return false;
    const key = `${machineId ?? ""}:${trimmedPath}`;
    if (machineId) {
      ctx.setSelectedProjectKey(projectKeyFor(machineId, trimmedPath));
      deps.focusTaskDraftProject({ machineId, path: trimmedPath });
    }
    ctx.setProjectActionError("");
    ctx.setActiveWorkspacePath(trimmedPath);
    ctx.setProjectPicker((current) => current && current.machineId === machineId ? { ...current, error: "" } : current);
    ctx.setOpeningProjectKey(key);
    try {
      const existingProject = machineId
        ? ctx.projectList.find((project) => project.machineId === machineId && project.path === trimmedPath)
        : undefined;
      const vscodeSource = existingProject?.source?.kind === "vscode" ? existingProject.source : undefined;
      const payload = await apiRouteJson(apiRoutes.startProjectThread, {
        path: trimmedPath,
        machineId: machineId || undefined,
        reuse: true,
        persist: vscodeSource ? false : undefined,
        source: vscodeSource
      });
      ctx.setMachines(normalizeMachines(payload.machines));
      const freshProjects = normalizeProjects(payload.projects);
      ctx.setProjects(freshProjects);
      ctx.setProjectActionError("");
      ctx.setActiveWorkspacePath(payload.result?.cwd ?? trimmedPath);
      const freshSessions = await apiRouteJson(apiRoutes.sessions)
        .then((data) => normalizeSessions(data.sessions))
        .catch(() => ctx.sessionList);
      ctx.setSessionList(freshSessions);
      ctx.setThreadOrderBySession((current) => mergeThreadOrderBySession(current, freshSessions));
      const sessionId = payload.result?.sessionId;
      const session = sessionId
        ? freshSessions.find((item) => item.sessionId === sessionId)
        : undefined;
      if (session && options.openThreadPicker) {
        openThreadPicker(session, payload.result?.cwd ?? trimmedPath);
      }
      if (session && payload.result?.threadId && options.activateThread !== false) {
        await activateSessionThread(session.sessionId, payload.result.threadId);
      } else if (session) {
        ctx.setActiveSessionId(session.sessionId);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.setProjectActionError(message);
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
      const payload = await apiRouteJson(apiRoutes.deleteProject, project.projectId);
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

  const patchProject = async (project: ProjectSummary, patch: ProjectUpdateInput) => {
    ctx.setProjectActionError("");
    try {
      const payload = await apiRouteJson(apiRoutes.updateProject, project.projectId, patch);
      applyProjectPayload(payload);
    } catch (error) {
      ctx.setProjectActionError(error instanceof Error ? error.message : String(error));
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
    const sessionId = thread?.session.sessionId ?? ctx.activeRuntimeSession?.sessionId ?? "";
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
    showProjectPicker,
    changeProjectPickerMachine,
    submitProjectPickerPath,
    confirmProjectPicker,
    loadThreadPickerCandidates,
    openThreadPicker,
    openSelectedProjectThreadPicker,
    activateSessionThread,
    threadIsOpenForSession,
    createSessionThread,
    createWorktreeThread,
    chooseThreadCandidate,
    startProjectThread,
    deleteProject,
    patchProject,
    toggleProjectPinned,
    toggleProjectMachineGroup,
    switchSessionThread
  };
};
