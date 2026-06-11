import type React from "react";
import {
  apiJson,
  defaultTaskDraft,
  mergeThreadOrderBySession,
  normalizeMachines,
  normalizeProjects,
  normalizeSessions,
  normalizeTasks,
  primeTaskCompletionSound,
  primeTaskNotificationPermission
} from "../appHelpers.js";
import type { LocalTask, MachineSummary, ProjectSummary, ProjectsPayload, SessionSummary, SessionView, TaskDraft } from "../types.js";

type SessionsPayload = {
  sessions?: SessionSummary[];
};

type TasksPayload = {
  tasks?: LocalTask[];
};

type TaskMutationPayload = {
  task?: LocalTask;
  sessionId?: string;
  threadId?: string;
};

type TaskPatchInput = Partial<Pick<LocalTask, "enabled" | "input" | "name" | "schedule" | "threadId">>;

type TaskActionsContext = {
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

type TaskActionsDependencies = {
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
  patchTask: (taskId: string, patch: TaskPatchInput) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  runTaskNow: (task: LocalTask) => Promise<void>;
};

export const createTaskActions = (ctx: TaskActionsContext, actions: Record<string, any>): TaskActions => {
  const refreshSessions = async () => {
    const freshSessions = await apiJson<SessionsPayload>("/api/sessions")
      .then((data) => normalizeSessions(data.sessions));
    ctx.setSessionList(freshSessions);
    ctx.setThreadOrderBySession((current) => mergeThreadOrderBySession(current, freshSessions));
    return freshSessions;
  };

  const refreshProjects = async () => {
    const payload = await apiJson<ProjectsPayload>("/api/projects");
    ctx.setMachines(normalizeMachines(payload.machines));
    ctx.setProjects(normalizeProjects(payload.projects));
    return payload;
  };

  const refreshTasks = async () => {
    const payload = await apiJson<TasksPayload>("/api/tasks");
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
    primeTaskNotificationPermission();
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
      const payload = await apiJson<TaskMutationPayload>("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          enabled: ctx.taskDraft.enabled,
          schedule,
          machineId,
          projectId: project?.projectId,
          projectPath,
          input,
          ...(threadId ? { threadId } : {})
        })
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

  const patchTask = async (taskId: string, patch: TaskPatchInput) => {
    ctx.setTaskBusyId(taskId);
    ctx.setTaskError("");
    try {
      const payload = await apiJson<TaskMutationPayload>(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      const task = payload.task;
      if (task) {
        ctx.setTasks((current) => normalizeTasks(current.map((item) => item.taskId === taskId ? task : item)));
      } else {
        await refreshTasks();
      }
    } catch (error) {
      ctx.setTaskError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setTaskBusyId((current) => current === taskId ? "" : current);
    }
  };

  const deleteTask = async (taskId: string) => {
    ctx.setTaskBusyId(taskId);
    ctx.setTaskError("");
    try {
      await apiJson(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
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
      const payload = await apiJson<TaskMutationPayload>(
        `/api/tasks/${encodeURIComponent(task.taskId)}/run`,
        { method: "POST" }
      );
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
        const deps = actions as TaskActionsDependencies;
        await deps.openThread(threadId).catch(() => deps.clearActiveThreadIfLatest(threadId));
      }
    } catch (error) {
      ctx.setTaskError(error instanceof Error ? error.message : String(error));
      await refreshTasks().catch(() => undefined);
    } finally {
      ctx.setTaskBusyId((current) => current === task.taskId ? "" : current);
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
    runTaskNow
  };
};
