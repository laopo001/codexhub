import type React from "react";
import type { ProjectUpdateInput } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import {
  apiRouteJson,
  appendThreadOrder,
  mergeThreadOrderByMachine,
  normalizeMachines,
  normalizeProjects,
  normalizeRuntimes,
  preferredThreadIdForRuntime,
  fixedProject,
  machineProjectCatalogEditable,
  machineProjectLauncher,
  projectKeyFor,
  projectKeyForProject,
  runtimeForProject
} from "../appHelpers.js";
import type {
  OpenThreadState,
  CodexThreadCandidate,
  MachineSummary,
  ProjectMachineGroup,
  ProjectPickerState,
  ProjectsPayload,
  ProjectSummary,
  RuntimeSummary,
  ThreadPickerState
} from "../types.js";

type ProjectActionsContext = {
  activeRuntime?: RuntimeSummary | null;
  activeTabThreadByMachine: Record<string, string>;
  activeTabThreadId: string;
  closedThreadIds: React.MutableRefObject<Set<string>>;
  latestRequestedThreadId: React.MutableRefObject<string>;
  machines: MachineSummary[];
  projectList: ProjectSummary[];
  projectPicker: ProjectPickerState | null;
  selectedProjectKey: string;
  runtimeList: RuntimeSummary[];
  openThreads: OpenThreadState[];
  threadOrderByMachine: Record<string, string[]>;
  threadLastSeqs: React.MutableRefObject<Map<string, number>>;
  threadPicker: ThreadPickerState | null;
  setActiveMachineId: React.Dispatch<React.SetStateAction<string>>;
  setActiveTabThreadByMachine: React.Dispatch<React.SetStateAction<Record<string, string>>>;
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
  setRuntimeList: React.Dispatch<React.SetStateAction<RuntimeSummary[]>>;
  setTaskError: React.Dispatch<React.SetStateAction<string>>;
  setThreadOrderByMachine: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
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
  threadPickerBootstrapId?: string;
};

export type ProjectActions = {
  selectProjectRuntime: (runtime: RuntimeSummary) => Promise<void>;
  selectRuntimeThread: (runtime: RuntimeSummary, threadId: string) => Promise<void>;
  selectProject: (project: ProjectSummary) => Promise<void>;
  loadProjectPickerDirectory: (machineId: string, targetPath?: string) => Promise<void>;
  showProjectPicker: (machine: ProjectMachineGroup) => void;
  changeProjectPickerMachine: (machineId: string) => void;
  submitProjectPickerPath: (event: React.FormEvent<HTMLFormElement>) => void;
  confirmProjectPicker: () => Promise<void>;
  loadThreadPickerCandidates: (machineId: string) => Promise<void>;
  openThreadPicker: (runtime: RuntimeSummary, workingDirectory?: string) => void;
  openSelectedProjectThreadPicker: () => Promise<void>;
  activateMachineThread: (machineId: string, threadId: string) => Promise<void>;
  threadIsOpenForMachine: (machineId: string, threadId: string) => boolean;
  createMachineThread: () => Promise<void>;
  createWorktreeThread: () => Promise<void>;
  chooseThreadCandidate: (candidate: CodexThreadCandidate) => Promise<void>;
  startProjectThread: (projectPath: string, machineId?: string, options?: StartProjectThreadOptions) => Promise<boolean>;
  deleteProject: (project: ProjectSummary) => Promise<void>;
  patchProject: (project: ProjectSummary, patch: ProjectUpdateInput) => Promise<void>;
  toggleProjectPinned: (project: ProjectSummary) => Promise<void>;
  toggleProjectMachineGroup: (machineKey: string) => void;
  switchMachineThread: (threadId: string) => Promise<void>;
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

  const selectProjectRuntime = async (runtime: RuntimeSummary) => {
    ctx.setActiveMachineId(runtime.machineId);
    const selectedProject = ctx.selectedProjectKey
      ? ctx.projectList.find((item) => projectKeyForProject(item) === ctx.selectedProjectKey)
      : undefined;
    const project = selectedProject?.machineId === runtime.machineId
      ? selectedProject
      : ctx.projectList.find((item) => item.machineId === runtime.machineId && item.path === runtime.workingDirectory);
    ctx.setActiveWorkspacePath(project?.path ?? runtime.workingDirectory);
    if (project) {
      ctx.setSelectedProjectKey(projectKeyForProject(project));
      deps.focusTaskDraftProject(project);
    }
    const activeTabThreadIdForSession = ctx.activeTabThreadByMachine[runtime.machineId];
    const runtimeThreadIds = new Set(runtime.threads?.map((thread) => thread.threadId) ?? []);
    const targetThreadId = activeTabThreadIdForSession && runtimeThreadIds.has(activeTabThreadIdForSession)
      ? activeTabThreadIdForSession
      : preferredThreadIdForRuntime(runtime, project);
    if (targetThreadId) {
      await deps.openThread(targetThreadId).catch(() => deps.clearActiveThreadIfLatest(targetThreadId));
    } else {
      ctx.setActiveTabThreadId("");
    }
  };

  const selectRuntimeThread = async (runtime: RuntimeSummary, threadId: string) => {
    ctx.setSelectedProjectKey("");
    ctx.setTaskError("");
    ctx.setProjectActionError("");
    ctx.setThreadPicker(null);
    ctx.setActiveWorkspacePath(runtime.workingDirectory);
    await activateMachineThread(runtime.machineId, threadId);
  };

  const selectProject = async (project: ProjectSummary) => {
    ctx.setSelectedProjectKey(projectKeyForProject(project));
    deps.focusTaskDraftProject(project);
    ctx.setTaskError("");
    ctx.setProjectActionError("");
    ctx.setActiveWorkspacePath(project.path);
    ctx.setThreadPicker(null);
    ctx.setActiveTabThreadId("");
    const runtime = runtimeForProject(project, ctx.runtimeList);
    if (runtime?.online) ctx.setActiveMachineId(runtime.machineId);
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
    const browseMachineId = machine.machineId;
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

  const loadThreadPickerCandidates = async (machineId: string, workingDirectory?: string) => {
    if (!machineId) return;
    const cwd = workingDirectory ?? ctx.threadPicker?.workingDirectory;
    const matchesRequest = (current: ThreadPickerState | null): current is ThreadPickerState =>
      Boolean(current && current.machineId === machineId && (!cwd || current.workingDirectory === cwd));
    ctx.setThreadPicker((current) => current && matchesRequest(current) ? {
      ...current,
      loading: true,
      error: ""
    } : current);
    try {
      const payload = await apiRouteJson(apiRoutes.threadCandidates, machineId, cwd, 20);
      ctx.setThreadPicker((current) => current && matchesRequest(current) ? {
        ...current,
        loading: false,
        candidates: Array.isArray(payload.threads) ? payload.threads : [],
        error: ""
      } : current);
    } catch (error) {
      ctx.setThreadPicker((current) => current && matchesRequest(current) ? {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const openThreadPicker = (
    runtime: RuntimeSummary,
    workingDirectory = runtime.workingDirectory,
    bootstrapId?: string
  ) => {
    if (!bootstrapId) {
      ctx.setActiveMachineId(runtime.machineId);
      ctx.setActiveWorkspacePath(workingDirectory);
    }
    const readyPicker: ThreadPickerState = {
      machineId: runtime.machineId,
      workingDirectory,
      preparingRuntime: false,
      bootstrapId,
      loading: true,
      error: "",
      candidates: [],
      searchQuery: "",
      acting: null,
      worktreeBranch: "",
      worktreeBaseRef: "",
      worktreePath: ""
    };
    ctx.setThreadPicker((current) => {
      if (bootstrapId && current?.bootstrapId !== bootstrapId) return current;
      return readyPicker;
    });
    void loadThreadPickerCandidates(runtime.machineId, workingDirectory);
  };

  const openSelectedProjectThreadPicker = async () => {
    const selectedProject = ctx.selectedProjectKey
      ? ctx.projectList.find((project) => projectKeyForProject(project) === ctx.selectedProjectKey)
      : undefined;
    if (!selectedProject) {
      const runtime = ctx.activeRuntime;
      if (runtime?.online) openThreadPicker(runtime);
      return;
    }
    ctx.setTaskError("");
    ctx.setProjectActionError("");
    ctx.setActiveMachineId(selectedProject.machineId);
    ctx.setActiveWorkspacePath(selectedProject.path);
    const runtime = runtimeForProject(selectedProject, ctx.runtimeList);
    if (runtime?.online) {
      openThreadPicker(runtime, selectedProject.path);
      return;
    }
    if (!selectedProject.machineOnline) {
      ctx.setProjectActionError(`Machine offline for project: ${selectedProject.name}`);
      return;
    }
    const bootstrapId = [
      selectedProject.machineId,
      selectedProject.path,
      Date.now().toString(36),
      Math.random().toString(36).slice(2)
    ].join(":");
    ctx.setThreadPicker({
      machineId: selectedProject.machineId,
      workingDirectory: selectedProject.path,
      preparingRuntime: true,
      bootstrapId,
      loading: false,
      error: "",
      candidates: [],
      searchQuery: "",
      acting: null,
      worktreeBranch: "",
      worktreeBaseRef: "",
      worktreePath: ""
    });
    try {
      const payload = await apiRouteJson(apiRoutes.ensureRuntime, selectedProject.machineId, {
        cwd: selectedProject.path
      });
      if (!payload.runtime?.online) throw new Error("Codex runtime started, but it is not available.");
      ctx.setRuntimeList((current) => [
        ...current.filter((item) => item.machineId !== payload.runtime!.machineId),
        payload.runtime!
      ]);
      openThreadPicker(payload.runtime, selectedProject.path, bootstrapId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.setThreadPicker((current) => current?.bootstrapId === bootstrapId ? {
        ...current,
        preparingRuntime: false,
        loading: false,
        error: message
      } : current);
    }
  };

  const activateMachineThread = async (machineId: string, threadId: string) => {
    ctx.closedThreadIds.current.delete(threadId);
    const runtime = ctx.runtimeList.find((item) => item.machineId === machineId);
    const thread = runtime?.threads?.find((item) => item.threadId === threadId)
      ?? ctx.openThreads.find((item) => item.threadId === threadId);
    if (runtime) {
      ctx.setActiveMachineId(runtime.machineId);
      ctx.setActiveWorkspacePath(thread?.workingDirectory ?? runtime.workingDirectory);
    }
    ctx.setActiveTabThreadByMachine((current) => ({ ...current, [machineId]: threadId }));
    ctx.setThreadOrderByMachine((current) => appendThreadOrder(current, machineId, threadId));
    if (ctx.openThreads.some((thread) => thread.threadId === threadId)) {
      ctx.latestRequestedThreadId.current = threadId;
      deps.subscribeThread(threadId, ctx.threadLastSeqs.current.get(threadId) ?? 0);
      ctx.setActiveTabThreadId(threadId);
      return;
    }
    await deps.openThread(threadId);
  };

  const threadIsOpenForMachine = (machineId: string, threadId: string) => {
    const runtime = ctx.runtimeList.find((item) => item.machineId === machineId);
    return Boolean(
      runtime?.threads?.some((thread) => thread.threadId === threadId)
      || (ctx.threadOrderByMachine[machineId] ?? []).includes(threadId)
      || ctx.openThreads.some((thread) => thread.threadId === threadId)
    );
  };

  const createMachineThread = async () => {
    const picker = ctx.threadPicker;
    if (!picker || picker.preparingRuntime || !picker.machineId) return;
    const machineId = picker.machineId;
    ctx.setThreadPicker((current) => current && current.machineId === machineId ? { ...current, acting: "new", error: "" } : current);
    try {
      const thread = await apiRouteJson(apiRoutes.createMachineThread, machineId, {
        action: "new",
        cwd: picker.workingDirectory
      });
      ctx.setThreadPicker(null);
      await activateMachineThread(machineId, thread.threadId);
    } catch (error) {
      ctx.setThreadPicker((current) => current && current.machineId === machineId ? {
        ...current,
        acting: null,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const createWorktreeThread = async () => {
    const picker = ctx.threadPicker;
    if (!picker || picker.preparingRuntime || !picker.machineId) return;
    const machineId = picker.machineId;
    const branch = picker.worktreeBranch.trim();
    if (!branch) {
      ctx.setThreadPicker((current) => current && current.machineId === machineId ? {
        ...current,
        error: "Worktree branch is required."
      } : current);
      return;
    }
    const runtime = ctx.runtimeList.find((item) => item.machineId === machineId);
    const parentProject = ctx.projectList.find((project) =>
      runtime?.machineId
      && project.machineId === runtime.machineId
      && project.path === picker.workingDirectory
    );
    if (!parentProject) {
      ctx.setThreadPicker((current) => current && current.machineId === machineId ? {
        ...current,
        error: "Parent project is not available."
      } : current);
      return;
    }
    ctx.setThreadPicker((current) => current && current.machineId === machineId ? { ...current, acting: "worktree", error: "" } : current);
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
      const freshRuntimes = await apiRouteJson(apiRoutes.runtimes)
        .then((data) => normalizeRuntimes(data.runtimes))
        .catch(() => ctx.runtimeList);
      ctx.setRuntimeList(freshRuntimes);
      ctx.setThreadOrderByMachine((current) => mergeThreadOrderByMachine(current, freshRuntimes));
      ctx.setThreadPicker(null);
      const openedMachineId = payload.result?.machineId;
      if (openedMachineId && payload.result?.threadId) {
        await activateMachineThread(openedMachineId, payload.result.threadId);
      } else if (openedMachineId) {
        ctx.setActiveMachineId(openedMachineId);
      }
    } catch (error) {
      ctx.setThreadPicker((current) => current && current.machineId === machineId ? {
        ...current,
        acting: null,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  };

  const chooseThreadCandidate = async (candidate: CodexThreadCandidate) => {
    const picker = ctx.threadPicker;
    if (!picker || picker.preparingRuntime || !picker.machineId) return;
    const machineId = picker.machineId;
    if (threadIsOpenForMachine(machineId, candidate.threadId)) {
      ctx.setThreadPicker(null);
      await activateMachineThread(machineId, candidate.threadId);
      return;
    }
    ctx.setThreadPicker((current) => current && current.machineId === machineId ? {
      ...current,
      acting: candidate.threadId,
      error: ""
    } : current);
    try {
      const thread = await apiRouteJson(apiRoutes.createMachineThread, machineId, {
        action: "resume",
        threadId: candidate.threadId,
        cwd: picker.workingDirectory
      });
      ctx.setThreadPicker(null);
      await activateMachineThread(machineId, thread.threadId);
    } catch (error) {
      ctx.setThreadPicker((current) => current && current.machineId === machineId ? {
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
      const freshRuntimes = await apiRouteJson(apiRoutes.runtimes)
        .then((data) => normalizeRuntimes(data.runtimes))
        .catch(() => ctx.runtimeList);
      ctx.setRuntimeList(freshRuntimes);
      ctx.setThreadOrderByMachine((current) => mergeThreadOrderByMachine(current, freshRuntimes));
      const openedMachineId = payload.result?.machineId;
      const runtime = openedMachineId
        ? freshRuntimes.find((item) => item.machineId === openedMachineId)
        : undefined;
      if (options.openThreadPicker && !runtime) {
        throw new Error("Codex runtime started, but it is not available.");
      }
      if (runtime && options.openThreadPicker) {
        openThreadPicker(
          runtime,
          payload.result?.cwd ?? trimmedPath,
          options.threadPickerBootstrapId
        );
      }
      if (runtime && payload.result?.threadId && options.activateThread !== false) {
        await activateMachineThread(runtime.machineId, payload.result.threadId);
      } else if (runtime) {
        ctx.setActiveMachineId(runtime.machineId);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.setProjectActionError(message);
      ctx.setProjectPicker((current) => current && current.machineId === machineId ? { ...current, error: message } : current);
      if (options.threadPickerBootstrapId) {
        ctx.setThreadPicker((current) => current && current.bootstrapId === options.threadPickerBootstrapId ? {
          ...current,
          preparingRuntime: false,
          loading: false,
          error: message
        } : current);
      }
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

  const switchMachineThread = async (threadId: string) => {
    if (threadId === ctx.activeTabThreadId) return;
    const thread = ctx.openThreads.find((item) => item.threadId === threadId);
    const machineId = thread?.runtime.machineId ?? ctx.activeRuntime?.machineId ?? "";
    if (machineId) {
      if (!ctx.selectedProjectKey) ctx.setActiveMachineId(machineId);
      ctx.setActiveTabThreadByMachine((current) => ({ ...current, [machineId]: threadId }));
    }
    if (thread) {
      if (!ctx.selectedProjectKey) ctx.setActiveWorkspacePath(thread.workingDirectory);
    }
    await deps.openThread(threadId).catch(() => deps.clearActiveThreadIfLatest(threadId));
  };

  return {
    selectProjectRuntime,
    selectRuntimeThread,
    selectProject,
    loadProjectPickerDirectory,
    showProjectPicker,
    changeProjectPickerMachine,
    submitProjectPickerPath,
    confirmProjectPicker,
    loadThreadPickerCandidates,
    openThreadPicker,
    openSelectedProjectThreadPicker,
    activateMachineThread,
    threadIsOpenForMachine,
    createMachineThread,
    createWorktreeThread,
    chooseThreadCandidate,
    startProjectThread,
    deleteProject,
    patchProject,
    toggleProjectPinned,
    toggleProjectMachineGroup,
    switchMachineThread
  };
};
