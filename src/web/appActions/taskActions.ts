import type React from "react";
import type { TaskUpdateInput } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import {
  apiRouteJson,
  defaultTaskDraft,
  mergeThreadOrderBySession,
  normalizeMachines,
  normalizeProjects,
  normalizeSessions,
  normalizeTasks,
  primeTaskCompletionSound,
  primeTaskNotificationPermission
} from "../appHelpers.js";
import type { AppSettings, LocalTask, MachineSummary, ProjectSummary, ProjectsPayload, SessionView, TaskDraft } from "../types.js";

type TaskActionsContext = {
  appSettingsRef: React.MutableRefObject<AppSettings>;
  notificationAudioContext: React.MutableRefObject<AudioContext | null>;
  projectList: ProjectSummary[];
  sessionList: SessionView[];
  taskDraft: TaskDraft;
  setActiveSessionId: React.Dispatch<React.SetStateAction<string>>;
  setMachines: React.Dispatch<React.SetStateAction<MachineSummary[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setSessionList: React.Dispatch<React.SetStateAction<SessionView[]>>;
  setTaskBusyId: React.Dispatch<React.SetStateAction<string>>;
  setTaskDraft: React.Dispatch<React.SetStateAction<TaskDraft>>;
  setTaskError: React.Dispatch<React.SetStateAction<string>>;
  setTaskFormOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTasks: React.Dispatch<React.SetStateAction<LocalTask[]>>;
  setThreadOrderBySession: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};

export type TaskActionsDependencies = {
  clearActiveThreadIfLatest: (threadId: string) => void;
  openThread: (threadId: string) => Promise<void>;
};

export type TaskActions = {
  refreshSessions: () => Promise<SessionView[]>;
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
  const refreshSessions = async () => {
    const freshSessions = await apiRouteJson(apiRoutes.sessions)
      .then((data) => normalizeSessions(data.sessions));
    ctx.setSessionList(freshSessions);
    ctx.setThreadOrderBySession((current) => mergeThreadOrderBySession(current, freshSessions));
    return freshSessions;
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
    ctx.setTaskDraft((current) => ({
      ...current,
      machineId,
      projectPath: nextProject?.path ?? "",
      threadId: ""
    }));
  };

  const updateTaskDraftProject = (projectPath: string) => {
    ctx.setTaskDraft((current) => ({
      ...current,
      projectPath,
      threadId: ""
    }));
  };

  const focusTaskDraftProject = (project: Pick<ProjectSummary, "machineId" | "path">) => {
    ctx.setTaskDraft((current) => {
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
    const name = ctx.taskDraft.name.trim() || "Scheduled task";
    const schedule = ctx.taskDraft.schedule.trim();
    const machineId = ctx.taskDraft.machineId.trim();
    const projectPath = ctx.taskDraft.projectPath.trim();
    const input = ctx.taskDraft.input.trim();
    const threadId = ctx.taskDraft.threadId.trim();
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
        enabled: ctx.taskDraft.enabled,
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
      ctx.setTaskDraft((current) => ({
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
      const freshSessions = await refreshSessions().catch(() => ctx.sessionList);
      if (payload.sessionId) {
        const session = freshSessions.find((item) => item.sessionId === payload.sessionId);
        if (session) ctx.setActiveSessionId(session.sessionId);
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
    refreshSessions,
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
