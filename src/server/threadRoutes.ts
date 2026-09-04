import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MachineHub } from "../core/machineHub.js";
import { defaultThreadHistoryPageSize, type ThreadHub } from "../core/threadHub.js";
import type { StoredDeveloperInstruction } from "../shared/projectTypes.js";
import {
  inputSchema,
  commitMessageGenerationSchema,
  machineThreadInputSchema,
  threadApprovalDecisionSchema,
  threadGoalUpdateSchema,
  threadRenameSchema,
  threadRunOptionsSchema,
  threadUserInputResponseSchema,
  threadHistoryQuerySchema,
  webEventsMessageSchema,
  type RuntimeEnsurePayload,
  type RuntimeModelsPayload,
  type RuntimePermissionProfilesPayload,
  type RuntimesPayload,
  type CommandPalettePayload,
  type CommitMessageGenerationPayload,
  type ThreadCandidatesPayload,
  type ThreadCompactPayload,
  type ThreadDeletePayload,
  type ThreadDetail,
  type ThreadApprovalPayload,
  type ThreadBackgroundTerminalTerminatePayload,
  type ThreadGoalMutationPayload,
  type ThreadRenamePayload,
  type ThreadTitleSuggestionPayload,
  type ThreadReviewPayload,
  type ThreadQueueCancelPayload,
  type ThreadsPayload,
  type ThreadStopPayload,
  type ThreadTurnPayload,
  type ThreadUserInputPayload,
  type MachineAppsPayload,
  type MachinePluginReconcilePayload,
  type WebEventsMessage
} from "../shared/apiContract.js";

type ControlEvent = {
  seq: number;
  kind: string;
};

export type ThreadRoutesContext<
  ProjectEvent extends ControlEvent,
  TaskEvent extends ControlEvent,
  ConnectionEvent extends ControlEvent
> = {
  connectionSnapshotEvent: () => ConnectionEvent;
  connectionSubscribers: Set<(event: ConnectionEvent) => void>;
  forceReleaseThreadRecordSubscription: (threadId: string) => void;
  markStaleSessions: () => { offline: number; removed: number };
  machines: MachineHub;
  projectSnapshotEvent: () => ProjectEvent;
  projectSubscribers: Set<(event: ProjectEvent) => void>;
  publishProjects: () => void;
  releaseThreadRecordSubscription: (threadId: string) => void;
  retainThreadRecordSubscription: (threadId: string) => void;
  resolveDeveloperInstruction: (id: string) => StoredDeveloperInstruction | null;
  taskSnapshotEvent: () => TaskEvent;
  taskSubscribers: Set<(event: TaskEvent) => void>;
  threads: ThreadHub;
  waitForSession: (sessionId: string) => Promise<unknown>;
};

export const registerThreadRoutes = <
  ProjectEvent extends ControlEvent,
  TaskEvent extends ControlEvent,
  ConnectionEvent extends ControlEvent
>(
  app: FastifyInstance,
  ctx: ThreadRoutesContext<ProjectEvent, TaskEvent, ConnectionEvent>
) => {
  app.get("/api/threads", async () => ({
    ...ctx.markStaleSessions(),
    threads: ctx.threads.listThreads()
  } satisfies ThreadsPayload));

  app.get("/api/runtimes", async (request) => {
    const query = z.object({ includeOffline: z.string().optional() }).parse(request.query);
    return {
      ...ctx.markStaleSessions(),
      runtimes: ctx.threads.listRuntimes({ includeOffline: query.includeOffline === "true" })
    } satisfies RuntimesPayload;
  });

  app.get("/api/events/ws", { websocket: true }, (socket) => {
    const threadUnsubscribers = new Map<string, () => void>();
    let unsubscribeRuntimes: (() => void) | null = null;
    let projectSubscriber: ((event: ProjectEvent) => void) | null = null;
    let taskSubscriber: ((event: TaskEvent) => void) | null = null;
    let connectionSubscriber: ((event: ConnectionEvent) => void) | null = null;

    const send = (message: unknown) => {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify(message));
    };

    const sendEvent = <T extends { kind: string }>(event: T) => {
      send({ type: event.kind, ...event });
    };

    const unsubscribeControl = () => {
      unsubscribeRuntimes?.();
      unsubscribeRuntimes = null;
      if (projectSubscriber) ctx.projectSubscribers.delete(projectSubscriber);
      if (taskSubscriber) ctx.taskSubscribers.delete(taskSubscriber);
      if (connectionSubscriber) ctx.connectionSubscribers.delete(connectionSubscriber);
      projectSubscriber = null;
      taskSubscriber = null;
      connectionSubscriber = null;
    };

    const subscribeControl = (input: Extract<WebEventsMessage, { type: "hello" }>) => {
      unsubscribeControl();
      ctx.markStaleSessions();

      const runtimesAfter = input.runtimesAfter ?? 0;
      const projectsAfter = input.projectsAfter ?? 0;
      const tasksAfter = input.tasksAfter ?? 0;
      const connectionsAfter = input.connectionsAfter ?? 0;

      unsubscribeRuntimes = ctx.threads.subscribeRuntimes(runtimesAfter, (event) => {
        sendEvent(event);
      });
      const projectSnapshot = ctx.projectSnapshotEvent();
      const taskSnapshot = ctx.taskSnapshotEvent();
      const connectionSnapshot = ctx.connectionSnapshotEvent();
      if (projectsAfter <= 0 || projectSnapshot.seq > projectsAfter) sendEvent(projectSnapshot);
      if (tasksAfter <= 0 || taskSnapshot.seq > tasksAfter) sendEvent(taskSnapshot);
      if (connectionsAfter <= 0 || connectionSnapshot.seq > connectionsAfter) sendEvent(connectionSnapshot);

      projectSubscriber = (event) => {
        if (event.seq > projectsAfter) sendEvent(event);
      };
      taskSubscriber = (event) => {
        if (event.seq > tasksAfter) sendEvent(event);
      };
      connectionSubscriber = (event) => {
        if (event.seq > connectionsAfter) sendEvent(event);
      };
      ctx.projectSubscribers.add(projectSubscriber);
      ctx.taskSubscribers.add(taskSubscriber);
      ctx.connectionSubscribers.add(connectionSubscriber);
      send({ type: "ready" });
    };

    const subscribeThread = (threadId: string, after = 0) => {
      threadUnsubscribers.get(threadId)?.();
      threadUnsubscribers.delete(threadId);
      try {
        const unsubscribeStream = ctx.threads.subscribe(threadId, after, (event) => {
          sendEvent(event);
        }, { historyPageSize: defaultThreadHistoryPageSize });
        ctx.retainThreadRecordSubscription(threadId);
        const unsubscribe = () => {
          unsubscribeStream();
          ctx.releaseThreadRecordSubscription(threadId);
        };
        threadUnsubscribers.set(threadId, unsubscribe);
        send({ type: "thread_subscribed", threadId });
      } catch (error) {
        send({
          type: "error",
          scope: "thread",
          threadId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };

    const unsubscribeThread = (threadId: string) => {
      threadUnsubscribers.get(threadId)?.();
      threadUnsubscribers.delete(threadId);
      send({ type: "thread_unsubscribed", threadId });
    };

    const closeSubscriptions = () => {
      unsubscribeControl();
      for (const unsubscribe of threadUnsubscribers.values()) unsubscribe();
      threadUnsubscribers.clear();
    };

    const handleMessage = (data: unknown) => {
      let parsed: WebEventsMessage;
      try {
        parsed = webEventsMessageSchema.parse(JSON.parse(String(data)));
      } catch (error) {
        send({ type: "error", message: `invalid web events message: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }

      if (parsed.type === "hello") {
        subscribeControl(parsed);
        return;
      }
      if (parsed.type === "subscribe_thread") {
        subscribeThread(parsed.threadId, parsed.after ?? 0);
        return;
      }
      if (parsed.type === "unsubscribe_thread") {
        unsubscribeThread(parsed.threadId);
      }
    };

    socket.on("message", (data: unknown) => handleMessage(data));
    socket.on("close", closeSubscriptions);
  });

  app.post("/api/machines/:machineId/runtime/ensure", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ cwd: z.string().min(1) }).strict().parse(request.body);
    try {
      const current = ctx.threads.runtimeForMachine(params.machineId);
      if (current?.online) return { ok: true, runtime: current } satisfies RuntimeEnsurePayload;
      const ensured = await ctx.machines.ensureRuntime(params.machineId, { cwd: payload.cwd }).promise;
      await ctx.waitForSession(ensured.sessionId);
      const runtime = ctx.threads.runtimeForMachine(params.machineId);
      if (!runtime?.online) throw new Error(`Runtime did not register for machine: ${params.machineId}`);
      return { ok: true, runtime } satisfies RuntimeEnsurePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Machine not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.get("/api/machines/:machineId/thread-candidates", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cwd: z.string().min(1).optional()
    }).parse(request.query);
    try {
      const result = await ctx.threads.listMachineThreadCandidates(params.machineId, query.limit ?? 50, query.cwd);
      return result satisfies ThreadCandidatesPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Runtime not found") ? 404 : 409);
      return { error: message };
    }
  });

  app.get("/api/machines/:machineId/models", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const query = z.object({
      includeHidden: z.string().optional(),
      refresh: z.string().optional()
    }).parse(request.query);
    try {
      const result = await ctx.threads.listMachineModels(
        params.machineId,
        query.includeHidden === "true",
        query.refresh === "true"
      );
      return result satisfies RuntimeModelsPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Runtime not found") ? 404 : 409);
      return { error: message };
    }
  });

  app.get("/api/machines/:machineId/permission-profiles", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const query = z.object({
      cwd: z.string().min(1)
    }).parse(request.query);
    try {
      const result = await ctx.threads.listMachinePermissionProfiles(
        params.machineId,
        query.cwd
      );
      return result satisfies RuntimePermissionProfilesPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Runtime not found") ? 404 : 409);
      return { error: message };
    }
  });

  app.get("/api/machines/:machineId/command-palette", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const query = z.object({
      cwd: z.string().min(1).optional(),
      part: z.enum(["core", "plugins", "all"]).optional()
    }).parse(request.query);
    try {
      const result = await ctx.threads.listMachineCommandPalette(params.machineId, query.cwd, query.part);
      return result satisfies CommandPalettePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Runtime not found") ? 404 : 409);
      return { error: message };
    }
  });

  app.get("/api/machines/:machineId/apps", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const query = z.object({ threadId: z.string().min(1).optional() }).parse(request.query);
    try {
      if (query.threadId) {
        const thread = ctx.threads.getThread(query.threadId);
        if (!thread || thread.runtime?.machineId !== params.machineId) {
          reply.code(409);
          return { error: "The selected thread does not belong to this machine." };
        }
      }
      return await ctx.threads.listMachineApps(params.machineId, query.threadId) satisfies MachineAppsPayload;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/machines/:machineId/plugins/reconcile", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const body = z.object({ reason: z.string().trim().max(500).optional() }).strict().parse(request.body ?? {});
    try {
      return await ctx.threads.reconcileMachinePlugins(params.machineId, body.reason) satisfies MachinePluginReconcilePayload;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/machines/:machineId/commit-message", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const payload = commitMessageGenerationSchema.parse(request.body);
    try {
      return await ctx.threads.generateCommitMessage(
        params.machineId,
        payload.cwd,
        payload.diff,
        payload.currentMessage,
        payload.model,
        payload.prompt
      ) satisfies CommitMessageGenerationPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Runtime not found") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/machines/:machineId/threads", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).strict().parse(request.params);
    const payload = machineThreadInputSchema.parse(request.body);
    try {
      let thread: ThreadDetail;
      let developerInstruction: StoredDeveloperInstruction | null = null;
      if (payload.action === "new") {
        if (payload.developerInstructionsId) {
          developerInstruction = ctx.resolveDeveloperInstruction(payload.developerInstructionsId);
          if (developerInstruction === null) {
            reply.code(404);
            return { error: `Developer instruction template not found: ${payload.developerInstructionsId}` };
          }
        }
        thread = await ctx.threads.startMachineThread(
          params.machineId,
          payload.cwd,
          developerInstruction ? { developerInstructions: developerInstruction.instructions } : undefined
        );
      } else {
        thread = await ctx.threads.resumeMachineThread(params.machineId, payload.threadId, payload.cwd);
      }
      ctx.publishProjects();
      const detail = ctx.threads.getThreadPage(thread.threadId);
      return {
        ...detail,
        ...(payload.action === "new" && developerInstruction ? {
          developerInstruction: {
            templateId: developerInstruction.id,
            templateName: developerInstruction.name,
            instructions: developerInstruction.instructions,
            injectedAt: new Date().toISOString()
          }
        } : {})
      } satisfies ThreadDetail;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Runtime not found") ? 404 : 409);
      return { error: message };
    }
  });

  app.get("/api/threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      return ctx.threads.getThreadPage(params.threadId) satisfies ThreadDetail;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Thread not found:")) throw error;
      reply.code(404);
      return { error: "thread_not_found" };
    }
  });

  app.get("/api/threads/:threadId/history", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const query = threadHistoryQuerySchema.parse(request.query);
    try {
      return await ctx.threads.loadThreadHistoryPage(params.threadId, query) satisfies ThreadDetail;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Thread not found:")) {
        reply.code(404);
        return { error: "thread_not_found" };
      }
      if (message.startsWith("Thread history cursor not found:")) {
        reply.code(409);
        return { error: "thread_history_cursor_not_found" };
      }
      throw error;
    }
  });

  app.patch("/api/threads/:threadId/name", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = threadRenameSchema.parse(request.body);
    try {
      const thread = await ctx.threads.renameThread(params.threadId, payload.title);
      return { ok: true, thread } satisfies ThreadRenamePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/name/suggest", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      return await ctx.threads.suggestThreadTitle(params.threadId) satisfies ThreadTitleSuggestionPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.delete("/api/threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      ctx.forceReleaseThreadRecordSubscription(params.threadId);
      const result = await ctx.threads.deleteThread(params.threadId);
      return result satisfies ThreadDeletePayload;
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/threads/:threadId/fork", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ messageId: z.string().min(1) }).parse(request.body);
    try {
      const thread = await ctx.threads.forkThread(params.threadId, payload.messageId);
      return ctx.threads.getThreadPage(thread.threadId) satisfies ThreadDetail;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(
        message.startsWith("Thread not found:")
          ? 404
          : message.toLowerCase().includes("timed out")
            ? 504
            : 409
      );
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/turn", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({
      submissionId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/).optional(),
      input: inputSchema,
      source: z.enum(["web", "telegram", "task"]).optional(),
      options: threadRunOptionsSchema.optional()
    }).parse(request.body);

    let delivery: ThreadTurnPayload["delivery"];
    try {
      const command = ctx.threads.runLocalCommand(params.threadId, payload.input, payload.source ?? "web");
      if (command.handled) return { ok: true, command: command.command } satisfies ThreadTurnPayload;
      const dispatch = ctx.threads.runTurnWithDelivery(
        params.threadId,
        payload.input,
        payload.source ?? "web",
        payload.options,
        payload.submissionId
      );
      delivery = dispatch.delivery;
      if (!dispatch.accepted || dispatch.delivery === "goal") {
        await dispatch.completion;
      } else {
        void dispatch.completion.catch(() => undefined);
      }
      return {
        ok: true,
        submissionId: dispatch.submissionId,
        delivery: dispatch.delivery,
        ...(dispatch.delivery === "queued" ? { queued: true } : {})
      } satisfies ThreadTurnPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message, ...(delivery ? { delivery } : {}) } satisfies ThreadTurnPayload;
    }
  });

  app.delete("/api/threads/:threadId/queue/:submissionId", async (request, reply) => {
    const params = z.object({
      threadId: z.string().min(1),
      submissionId: z.string().min(1).max(160)
    }).parse(request.params);
    try {
      const cancelled = ctx.threads.cancelQueuedTurn(params.threadId, params.submissionId);
      return { cancelled: true, submissionId: cancelled.submissionId } satisfies ThreadQueueCancelPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { cancelled: false, error: message } satisfies ThreadQueueCancelPayload;
    }
  });

  app.post("/api/threads/:threadId/goal", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = threadGoalUpdateSchema.parse(request.body);
    try {
      await ctx.threads.setGoal(params.threadId, payload);
      return { ok: true } satisfies ThreadGoalMutationPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.delete("/api/threads/:threadId/goal", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      await ctx.threads.clearGoal(params.threadId);
      return { ok: true } satisfies ThreadGoalMutationPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/stop", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      const result = await ctx.threads.stopTurn(params.threadId);
      return result satisfies ThreadStopPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/background-terminals/:processId/terminate", async (request, reply) => {
    const params = z.object({
      threadId: z.string().min(1),
      processId: z.string().min(1)
    }).parse(request.params);
    try {
      const result = await ctx.threads.terminateBackgroundTerminal(params.threadId, params.processId);
      return result satisfies ThreadBackgroundTerminalTerminatePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/compact", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      const result = await ctx.threads.compactThread(params.threadId);
      return { ok: true, ...result } satisfies ThreadCompactPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/review", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      const result = await ctx.threads.reviewThread(params.threadId);
      return { ok: true, ...result } satisfies ThreadReviewPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/approval", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = threadApprovalDecisionSchema.parse(request.body);
    try {
      const result = await ctx.threads.respondToApproval(params.threadId, payload.approvalId, payload.decision);
      return { ok: true, ...result } satisfies ThreadApprovalPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") || message.startsWith("Approval not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/user-input", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = threadUserInputResponseSchema.parse(request.body);
    try {
      const result = await ctx.threads.respondToUserInput(params.threadId, payload.userInputId, payload.answers);
      return { ok: true, ...result } satisfies ThreadUserInputPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") || message.startsWith("User input not found:") ? 404 : 409);
      return { error: message };
    }
  });
};
