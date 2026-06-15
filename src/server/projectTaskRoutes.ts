import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MachineHub } from "../core/machineHub.js";
import type { CodexhubServerState } from "../core/serverState.js";
import type { ThreadHub } from "../core/threadHub.js";
import type { ProjectSource, StoredTask } from "../shared/projectTypes.js";
import {
  projectSourceSchema,
  projectUpdateSchema,
  taskCreateSchema,
  taskUpdateSchema,
  type ProjectMutationPayload,
  type ProjectOpenPayload,
  type ProjectsPayload,
  type TaskMutationPayload,
  type TasksPayload,
  type TaskView
} from "../shared/apiContract.js";

type ProjectSessionStopResult = {
  machineId: string;
  sessionId: string;
  stopped: boolean;
  removed: boolean;
  reason: string;
};

export type ProjectTaskRoutesContext = {
  features: { tasks: boolean };
  fixedProjectPathExists: (machineId: string, projectPath: string) => boolean;
  isVscodeWorkspaceSource: (source: ProjectSource | undefined) => boolean;
  localTaskView: (task: StoredTask) => TaskView;
  localTaskViews: () => TaskView[];
  machines: MachineHub;
  projectIsFixed: (projectId: string) => boolean | undefined;
  projectSnapshot: () => ProjectsPayload;
  publishProjects: () => void;
  publishTasks: () => void;
  resolveTargetMachine: (
    machines: ReturnType<MachineHub["listMachines"]>,
    requestedMachineId: string | undefined
  ) => ReturnType<MachineHub["listMachines"]>[number];
  runLocalTask: (taskId: string) => Promise<TaskMutationPayload>;
  sessionsForProject: (target: { machineId: string; path: string }) => Array<{ sessionId: string }>;
  state: CodexhubServerState;
  stopProjectSessions: (target: { machineId: string; path: string }) => Promise<ProjectSessionStopResult[]> | ProjectSessionStopResult[];
  surface: "default" | "vscode";
  threads: ThreadHub;
  waitForSession: (sessionId: string) => Promise<unknown>;
};

export const registerProjectTaskRoutes = (app: FastifyInstance, ctx: ProjectTaskRoutesContext) => {
  app.get("/api/projects", async () => ctx.projectSnapshot() satisfies ProjectsPayload);

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    if (ctx.projectIsFixed(params.projectId)) {
      reply.code(409);
      return { error: "Fixed workspace projects are controlled by their provider." };
    }
    if (ctx.state.deleteTransientProject(params.projectId)) {
      ctx.publishProjects();
      return {
        ok: true,
        deleted: true,
        transient: true,
        stoppedSessions: [],
        ...ctx.projectSnapshot()
      } satisfies ProjectMutationPayload;
    }
    const target = ctx.state.projectDeleteTarget(params.projectId);
    const deleted = ctx.state.deleteProject(params.projectId);
    const existingSessions = target ? ctx.sessionsForProject(target) : [];
    if (!deleted && existingSessions.length === 0) {
      reply.code(404);
      return { error: `Project not found: ${params.projectId}` };
    }
    if (deleted) ctx.publishProjects();
    const stoppedSessions = target ? await ctx.stopProjectSessions(target) : [];
    ctx.publishProjects();
    return { ok: true, deleted, stoppedSessions, ...ctx.projectSnapshot() } satisfies ProjectMutationPayload;
  });

  app.patch("/api/projects/:projectId", async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const payload = projectUpdateSchema.parse(request.body);
    if (ctx.projectIsFixed(params.projectId)) {
      reply.code(409);
      return { error: "Fixed workspace projects cannot be saved, pinned, or renamed." };
    }
    const project = ctx.state.isTransientProject(params.projectId) && !ctx.state.hasStoredProject(params.projectId) && payload.pinned
      ? ctx.state.persistTransientProject(params.projectId, { pinned: true })
      : ctx.state.updateProject(params.projectId, payload);
    if (!project) {
      reply.code(404);
      return { error: `Project not found: ${params.projectId}` };
    }
    ctx.publishProjects();
    return { ok: true, project, ...ctx.projectSnapshot() } satisfies ProjectMutationPayload;
  });

  app.post("/api/projects/open", async (request, reply) => {
    const payload = z.object({
      machineId: z.string().min(1).optional(),
      path: z.string().min(1),
      reuse: z.boolean().optional(),
      persist: z.boolean().optional(),
      source: projectSourceSchema.optional()
    }).parse(request.body);

    try {
      const machine = ctx.resolveTargetMachine(ctx.machines.listMachines(), payload.machineId);
      const fixedCatalog = machine.capabilities?.projectCatalog === "fixed";
      const providerSeed = ctx.surface === "vscode" && machine.type === "local" && ctx.isVscodeWorkspaceSource(payload.source);
      if (fixedCatalog && !providerSeed && !ctx.fixedProjectPathExists(machine.machineId, payload.path)) {
        reply.code(409);
        return { error: "This machine exposes a fixed workspace project list." };
      }
      const previousProject = ctx.state.listStoredProjects()
        .find((project) => project.machineId === machine.machineId && project.path === payload.path);
      const started = ctx.machines.startSession(machine.machineId, {
        cwd: payload.path,
        reuse: payload.reuse ?? true,
        threadId: payload.reuse === false ? undefined : previousProject?.lastThreadId
      });
      const result = await started.promise;
      const sessionId = result.sessionId;
      await ctx.waitForSession(sessionId);
      ctx.threads.attachSessionThread(sessionId, result.threadId, result.cwd);
      const project = payload.persist === false
        ? ctx.state.upsertTransientProject({
          machineId: machine.machineId,
          path: result.cwd,
          sessionId,
          threadId: result.threadId,
          source: payload.source
        })
        : ctx.state.upsertProject({
          machineId: machine.machineId,
          path: result.cwd,
          threadId: result.threadId
        });
      if (!project) {
        reply.code(409);
        return { error: "Project could not be opened." };
      }
      ctx.publishProjects();
      return { ok: true, machine, project, result, ...ctx.projectSnapshot() } satisfies ProjectOpenPayload;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/tasks", async () => ({
    tasks: ctx.localTaskViews()
  } satisfies TasksPayload));

  app.post("/api/tasks", async (request, reply) => {
    const payload = taskCreateSchema.parse(request.body);
    try {
      const task = ctx.state.upsertTask({
        taskId: randomUUID(),
        name: payload.name,
        enabled: payload.enabled ?? true,
        schedule: payload.schedule,
        machineId: payload.machineId,
        projectId: payload.projectId,
        projectPath: payload.projectPath,
        threadId: payload.threadId,
        input: payload.input
      });
      ctx.publishTasks();
      return { ok: true, task: ctx.localTaskView(task) } satisfies TaskMutationPayload;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.patch("/api/tasks/:taskId", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const payload = taskUpdateSchema.parse(request.body);
    const existing = ctx.state.getTask(params.taskId);
    if (!existing) {
      reply.code(404);
      return { error: "task_not_found" };
    }
    try {
      const task = ctx.state.upsertTask({
        ...existing,
        ...payload,
        taskId: existing.taskId,
        name: payload.name ?? existing.name,
        enabled: payload.enabled ?? existing.enabled,
        schedule: payload.schedule ?? existing.schedule,
        machineId: payload.machineId ?? existing.machineId,
        projectPath: payload.projectPath ?? existing.projectPath,
        input: payload.input ?? existing.input,
        projectId: payload.projectId ?? existing.projectId,
        threadId: payload.threadId ?? existing.threadId,
        createdAt: existing.createdAt
      });
      ctx.publishTasks();
      return { ok: true, task: ctx.localTaskView(task) } satisfies TaskMutationPayload;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.delete("/api/tasks/:taskId", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    if (!ctx.state.deleteTask(params.taskId)) {
      reply.code(404);
      return { error: "task_not_found" };
    }
    ctx.publishTasks();
    return { ok: true, deleted: true } satisfies { ok: boolean; deleted: boolean };
  });

  app.post("/api/tasks/:taskId/run", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    try {
      const result = await ctx.runLocalTask(params.taskId);
      return result satisfies TaskMutationPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Task not found:") ? 404 : 409);
      return { error: message };
    }
  });
};
