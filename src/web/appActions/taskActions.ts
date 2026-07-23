import type React from "react";
import type { TaskUpdateInput } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import {
  apiRouteJson,
  defaultTaskDraft,
  mergeThreadOrderByMachine,
  normalizeMachines,
  normalizeProjects,
  normalizeRuntimes,
  normalizeTasks,
  primeTaskCompletionSound,
  primeTaskNotificationPermission,
  type SidebarDraftStore
} from "../appHelpers.js";
import type { AppSettings, LocalTask, MachineSummary, ProjectSummary, ProjectsPayload, RuntimeSummary, TaskDraft } from "../types.js";

type TaskActionsContext = {
  appSettingsRef: React.MutableRefObject<AppSettings>;
  notificationAudioContext: React.MutableRefObject<AudioContext | null>;
  projectList: ProjectSummary[];
  runtimeList: RuntimeSummary[];
  sidebarDraftStore: SidebarDraftStore;
  setActiveMachineId: React.Dispatch<React.SetStateAction<string>>;
  setMachines: React.Dispatch<React.SetStateAction<MachineSummary[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setRuntimeList: React.Dispatch<React.SetStateAction<RuntimeSummary[]>>;
  setTaskBusyId: React.Dispatch<React.SetStateAction<string>>;
  setTaskError: React.Dispatch<React.SetStateAction<string>>;
  setTaskFormOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTasks: React.Dispatch<React.SetStateAction<LocalTask[]>>;
  setThreadOrderByMachine: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};

export type TaskActionsDependencies = {
  clearActiveThreadIfLatest: (threadId: string) => void;
  openThread: (threadId: string) => Promise<void>;
};

export type TaskActions = {
  refreshRuntimes: () => Promise<RuntimeSummary[]>;
  refreshProjects: () => Promise<ProjectsPayload>;
  refreshTasks: () => Promise<void>;
  updateTaskDraftMachine: (machineId: string) => void;
  updateTaskDraftProject: (projectPath: string) => void;
  focusTaskDraftProject: (project: Pick<ProjectSummary, "machineId" | "path">) => void;
  primeTaskCompletionFeedback: () => void;
  createTask: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  patchTask: (taskId: string, patch: TaskUpdateInput) => Promise<boolean>;
  deleteTask: (taskId: string) => Promise<void>;
  runTaskNow: (task: LocalTask) => Promise<void>;
  openTaskRunThread: (threadId: string) => Promise<void>;
};

export const createTaskActions = (ctx: TaskActionsContext, deps: TaskActionsDependencies): TaskActions => {
  const setTaskDraft = (update: React.SetStateAction<TaskDraft>) => {
    ctx.sidebarDraftStore.set("taskDraft", update);
  };
  const refreshRuntimes = async () => {
    const freshRuntimes = await apiRouteJson(apiRoutes.runtimes)
      .then((data) => normalizeRuntimes(data.runtimes));
    ctx.setRuntimeList(freshRuntimes);
    ctx.setThreadOrderByMachine((current) => mergeThreadOrderByMachine(current, freshRuntimes));
    return freshRuntimes;
  };

  const refreshProjects = async () => {
    const payload = await apiRouteJson(apiRoutes.projects);
    ctx.setMachines(normalizeMachines(payload.machines));
    ctx.setProjects(normalizeProjects(payload.projects));
    return payload;
  };

  const refreshTasks = async () => {
    const payload = await apiRouteJson(apiRoutes.tasks);
    ctx.setTasks(normalizeTasks(payload.tasks));
  };

  const updateTaskDraftMachine = (machineId: string) => {
    const nextProject = ctx.projectList.find((project) => project.machineId === machineId);
    setTaskDraft((current) => ({
      ...current,
      machineId,
      projectPath: nextProject?.path ?? "",
      threadId: ""
    }));
  };

  const updateTaskDraftProject = (projectPath: string) => {
    setTaskDraft((current) => ({
      ...current,
      projectPath,
      threadId: ""
    }));
  };

  const focusTaskDraftProject = (project: Pick<ProjectSummary, "machineId" | "path">) => {
    setTaskDraft((current) => {
      if (current.machineId === project.machineId && current.projectPath === project.path) return current;
      return {
        ...current,
        machineId: project.machineId,
        projectPath: project.path,
        threadId: ""
      };
    });
  };

  const primeTaskCompletionFeedback = () => {
    if (ctx.appSettingsRef.current.taskCompleteSystemNotifications) {
      primeTaskNotificationPermission();
    }
    primeTaskCompletionSound(ctx.notificationAudioContext);
  };

  const createTask = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    primeTaskCompletionFeedback();
    const taskDraft = ctx.sidebarDraftStore.getSnapshot().taskDraft;
    const name = taskDraft.name.trim() || "Scheduled task";
    const schedule = taskDraft.schedule.trim();
    const machineId = taskDraft.machineId.trim();
    const projectPath = taskDraft.projectPath.trim();
    const input = taskDraft.input.trim();
    const threadId = taskDraft.threadId.trim();
    if (!machineId || !projectPath || !schedule || !input) {
      ctx.setTaskError("Missing task fields");
      return;
    }
    const project = ctx.projectList.find((item) => item.machineId === machineId && item.path === projectPath);
    ctx.setTaskBusyId("create");
    ctx.setTaskError("");
    try {
      const payload = await apiRouteJson(apiRoutes.createTask, {
        name,
        enabled: taskDraft.enabled,
        schedule,
        machineId,
        projectId: project?.projectId,
        projectPath,
        input,
        ...(threadId ? { threadId } : {})
      });
      const task = payload.task;
      if (task) {
        ctx.setTasks((current) => normalizeTasks([task, ...current.filter((item) => item.taskId !== task.taskId)]));
      } else {
        await refreshTasks();
      }
      setTaskDraft((current) => ({
        ...defaultTaskDraft(),
        machineId,
        projectPath,
        schedule: current.schedule,
        input: current.input
      }));
      ctx.setTaskFormOpen(false);
    } catch (error) {
      ctx.setTaskError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setTaskBusyId((current) => current === "create" ? "" : current);
    }
  };

  const patchTask = async (taskId: string, patch: TaskUpdateInput) => {
    ctx.setTaskBusyId(taskId);
    ctx.setTaskError("");
    try {
      const payload = await apiRouteJson(apiRoutes.updateTask, taskId, patch);
      const task = payload.task;
      if (task) {
        ctx.setTasks((current) => normalizeTasks(current.map((item) => item.taskId === taskId ? task : item)));
      } else {
        await refreshTasks();
      }
      return true;
    } catch (error) {
      ctx.setTaskError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      ctx.setTaskBusyId((current) => current === taskId ? "" : current);
    }
  };

  const deleteTask = async (taskId: string) => {
    ctx.setTaskBusyId(taskId);
    ctx.setTaskError("");
    try {
      await apiRouteJson(apiRoutes.deleteTask, taskId);
      ctx.setTasks((current) => current.filter((task) => task.taskId !== taskId));
    } catch (error) {
      ctx.setTaskError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setTaskBusyId((current) => current === taskId ? "" : current);
    }
  };

  const runTaskNow = async (task: LocalTask) => {
    primeTaskCompletionFeedback();
    ctx.setTaskBusyId(task.taskId);
    ctx.setTaskError("");
    try {
      const payload = await apiRouteJson(apiRoutes.runTask, task.taskId);
      const updatedTask = payload.task;
      if (updatedTask) {
        ctx.setTasks((current) => normalizeTasks(current.map((item) => item.taskId === task.taskId ? updatedTask : item)));
      }
      await refreshTasks().catch(() => undefined);
      const freshRuntimes = await refreshRuntimes().catch(() => ctx.runtimeList);
      if (payload.machineId) {
        const runtime = freshRuntimes.find((item) => item.machineId === payload.machineId);
        if (runtime) ctx.setActiveMachineId(runtime.machineId);
      }
      const threadId = payload.threadId;
      if (threadId) {
        await deps.openThread(threadId).catch(() => deps.clearActiveThreadIfLatest(threadId));
      }
    } catch (error) {
      ctx.setTaskError(error instanceof Error ? error.message : String(error));
      await refreshTasks().catch(() => undefined);
    } finally {
      ctx.setTaskBusyId((current) => current === task.taskId ? "" : current);
    }
  };

  const openTaskRunThread = async (threadId: string) => {
    const targetThreadId = threadId.trim();
    if (!targetThreadId) return;
    ctx.setTaskError("");
    try {
      await deps.openThread(targetThreadId);
    } catch (error) {
      deps.clearActiveThreadIfLatest(targetThreadId);
      ctx.setTaskError(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    refreshRuntimes,
    refreshProjects,
    refreshTasks,
    updateTaskDraftMachine,
    updateTaskDraftProject,
    focusTaskDraftProject,
    primeTaskCompletionFeedback,
    createTask,
    patchTask,
    deleteTask,
    runTaskNow,
    openTaskRunThread
  };
};
