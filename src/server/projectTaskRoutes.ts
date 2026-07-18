import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MachineHub } from "../core/machineHub.js";
import type { CodexhubServerState } from "../core/serverState.js";
import type { ThreadHub } from "../core/threadHub.js";
import type { ProjectRelation, ProjectSource, StoredTask } from "../shared/projectTypes.js";
import type { CodexHubSurface } from "../shared/surfaceTypes.js";
import {
  projectSourceSchema,
  projectUpdateSchema,
  taskCreateSchema,
  taskUpdateSchema,
  type ProjectMutationPayload,
  type ProjectThreadStartPayload,
  type ProjectsPayload,
  type TaskMutationPayload,
  type TasksPayload,
  type TaskView,
  type WorktreeThreadStartPayload
} from "../shared/apiContract.js";

export type ProjectTaskRoutesContext = {
  features: { tasks: boolean };
  fixedProjectPathExists: (machineId: string, projectPath: string) => boolean;
  isEmbeddedWorkspaceSource: (source: ProjectSource | undefined) => boolean;
  localTaskView: (task: StoredTask) => TaskView;
  localTaskViews: () => TaskView[];
  machines: MachineHub;
  projectIsFixed: (projectId: string) => boolean | undefined;
  projectSnapshot: () => ProjectsPayload;
  publishProjects: () => void;
  refreshParentRegistration: () => void;
  publishTasks: () => void;
  resolveTargetMachine: (
    machines: ReturnType<MachineHub["listMachines"]>,
    requestedMachineId: string | undefined
  ) => ReturnType<MachineHub["listMachines"]>[number];
  runLocalTask: (taskId: string) => Promise<TaskMutationPayload>;
  state: CodexhubServerState;
  surface: CodexHubSurface;
  threads: ThreadHub;
  waitForSession: (sessionId: string) => Promise<unknown>;
};

export const registerProjectTaskRoutes = (app: FastifyInstance, ctx: ProjectTaskRoutesContext) => {
  const startProjectThreadOnMachine = async (input: {
    machine: ReturnType<MachineHub["listMachines"]>[number];
    path: string;
    reuse?: boolean;
    persist?: boolean;
    source?: ProjectSource;
    relation?: ProjectRelation;
  }): Promise<ProjectThreadStartPayload> => {
    const previousProject = ctx.state.listStoredProjects()
      .find((project) => project.machineId === input.machine.machineId && project.path === input.path);
    const knownLastThread = previousProject?.lastThreadId
      ? ctx.threads.listThreads().find((thread) => thread.threadId === previousProject.lastThreadId)
      : undefined;
    const relation = input.relation ?? previousProject?.relation;
    const knownLastThreadMismatches = Boolean(knownLastThread && knownLastThread.workingDirectory !== input.path);
    const worktreeNeedsKnownThread = relation?.type === "worktree";
    const reusableThreadId = input.reuse === false || knownLastThreadMismatches || (worktreeNeedsKnownThread && !knownLastThread)
      ? undefined
      : previousProject?.lastThreadId;
    const reuseExistingProjectRuntime = input.reuse === false
      ? false
      : !knownLastThreadMismatches && (!worktreeNeedsKnownThread || Boolean(knownLastThread));
    const started = ctx.machines.startSession(input.machine.machineId, {
      cwd: input.path,
      reuse: reuseExistingProjectRuntime,
      threadId: reusableThreadId
    });
    const result = await started.promise;
    const sessionId = result.sessionId;
    await ctx.waitForSession(sessionId);
    ctx.threads.attachSessionThread(sessionId, result.threadId, result.cwd);
    const project = input.persist === false
      ? ctx.state.upsertTransientProject({
        machineId: input.machine.machineId,
        path: result.cwd,
        relation: input.relation,
        threadId: result.threadId,
        source: input.source
      })
      : ctx.state.upsertProject({
        machineId: input.machine.machineId,
        path: result.cwd,
        relation: input.relation,
        threadId: result.threadId
      });
    if (!project) throw new Error("Project could not be opened.");
    ctx.publishProjects();
    ctx.refreshParentRegistration();
    return { ok: true, machine: input.machine, project, result, ...ctx.projectSnapshot() } satisfies ProjectThreadStartPayload;
  };

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
        ...ctx.projectSnapshot()
      } satisfies ProjectMutationPayload;
    }
    const deleted = ctx.state.deleteProject(params.projectId);
    if (!deleted) {
      reply.code(404);
      return { error: `Project not found: ${params.projectId}` };
    }
    ctx.publishProjects();
    return { ok: true, deleted, ...ctx.projectSnapshot() } satisfies ProjectMutationPayload;
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
      const providerSeed = ctx.surface !== "default"
        && machine.type === "local"
        && ctx.isEmbeddedWorkspaceSource(payload.source);
      if (fixedCatalog && !providerSeed && !ctx.fixedProjectPathExists(machine.machineId, payload.path)) {
        reply.code(409);
        return { error: "This machine exposes a fixed workspace project list." };
      }
      return await startProjectThreadOnMachine({
        machine,
        path: payload.path,
        reuse: payload.reuse,
        persist: payload.persist,
        source: payload.source
      });
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/projects/worktree/open", async (request, reply) => {
    const payload = z.object({
      parentProjectId: z.string().min(1),
      branch: z.string().trim().min(1),
      baseRef: z.string().trim().min(1).optional(),
      path: z.string().trim().min(1).optional(),
      reuse: z.boolean().optional(),
      persist: z.boolean().optional()
    }).parse(request.body);

    try {
      const parent = ctx.state.projectTarget(payload.parentProjectId);
      if (!parent) {
        reply.code(404);
        return { error: `Project not found: ${payload.parentProjectId}` };
      }
      const machine = ctx.resolveTargetMachine(ctx.machines.listMachines(), parent.machineId);
      const created = ctx.machines.createGitWorktree(machine.machineId, {
        parentCwd: parent.path,
        branch: payload.branch,
        baseRef: payload.baseRef,
        path: payload.path
      });
      const worktree = await created.promise;
      const relation: ProjectRelation = {
        type: "worktree",
        parentProjectId: parent.projectId,
        parentPath: parent.path,
        branch: worktree.branch,
        ...(worktree.baseRef ? { baseRef: worktree.baseRef } : payload.baseRef ? { baseRef: payload.baseRef } : {})
      };
      const opened = await startProjectThreadOnMachine({
        machine,
        path: worktree.path,
        relation,
        reuse: payload.reuse,
        persist: payload.persist
      });
      return { ...opened, worktree } satisfies WorktreeThreadStartPayload;
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
