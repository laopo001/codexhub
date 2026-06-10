// @ts-nocheck
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

export const createTaskActions = (ctx, actions) => {
  const refreshSessions = async () => {
    const freshSessions = await apiJson("/api/sessions")
      .then((data) => normalizeSessions(data.sessions));
    ctx.setSessionList(freshSessions);
    ctx.setThreadOrderBySession((current) => mergeThreadOrderBySession(current, freshSessions));
    return freshSessions;
  };

  const refreshProjects = async () => {
    const payload = await apiJson("/api/projects");
    ctx.setMachines(normalizeMachines(payload.machines));
    ctx.setProjects(normalizeProjects(payload.projects));
    return payload;
  };

  const refreshTasks = async () => {
    const payload = await apiJson("/api/tasks");
    ctx.setTasks(normalizeTasks(payload.tasks));
  };

  const updateTaskDraftMachine = (machineId) => {
    const nextProject = ctx.projectList.find((project) => project.machineId === machineId);
    ctx.setTaskDraft((current) => ({
      ...current,
      machineId,
      projectPath: nextProject?.path ?? "",
      threadId: ""
    }));
  };

  const updateTaskDraftProject = (projectPath) => {
    ctx.setTaskDraft((current) => ({
      ...current,
      projectPath,
      threadId: ""
    }));
  };

  const focusTaskDraftProject = (project) => {
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

  const createTask = async (event) => {
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
      const payload = await apiJson("/api/tasks", {
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
      if (payload.task) {
        ctx.setTasks((current) => normalizeTasks([payload.task, ...current.filter((task) => task.taskId !== payload.task.taskId)]));
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

  const patchTask = async (taskId, patch) => {
    ctx.setTaskBusyId(taskId);
    ctx.setTaskError("");
    try {
      const payload = await apiJson(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (payload.task) {
        ctx.setTasks((current) => normalizeTasks(current.map((task) => task.taskId === taskId ? payload.task : task)));
      } else {
        await refreshTasks();
      }
    } catch (error) {
      ctx.setTaskError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setTaskBusyId((current) => current === taskId ? "" : current);
    }
  };

  const deleteTask = async (taskId) => {
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

  const runTaskNow = async (task) => {
    primeTaskCompletionFeedback();
    ctx.setTaskBusyId(task.taskId);
    ctx.setTaskError("");
    try {
      const payload = await apiJson(
        `/api/tasks/${encodeURIComponent(task.taskId)}/run`,
        { method: "POST" }
      );
      if (payload.task) {
        ctx.setTasks((current) => normalizeTasks(current.map((item) => item.taskId === task.taskId ? payload.task : item)));
      }
      await refreshTasks().catch(() => undefined);
      const freshSessions = await refreshSessions().catch(() => ctx.sessionList);
      if (payload.sessionId) {
        const session = freshSessions.find((item) => item.sessionId === payload.sessionId);
        if (session) ctx.setActiveSessionId(session.sessionId);
      }
      if (payload.threadId) {
        await actions.openThread(payload.threadId).catch(() => actions.clearActiveThreadIfLatest(payload.threadId));
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
