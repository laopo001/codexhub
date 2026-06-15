import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ThreadHub } from "../core/threadHub.js";
import {
  inputSchema,
  threadGoalUpdateSchema,
  threadRunOptionsSchema,
  webEventsMessageSchema,
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
  projectSnapshotEvent: () => ProjectEvent;
  projectSubscribers: Set<(event: ProjectEvent) => void>;
  publishProjects: () => void;
  releaseThreadRecordSubscription: (threadId: string) => void;
  retainThreadRecordSubscription: (threadId: string) => void;
  taskSnapshotEvent: () => TaskEvent;
  taskSubscribers: Set<(event: TaskEvent) => void>;
  threads: ThreadHub;
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
  }));

  app.get("/api/sessions", async (request) => {
    const query = z.object({ includeOffline: z.string().optional() }).parse(request.query);
    return {
      ...ctx.markStaleSessions(),
      sessions: ctx.threads.listSessions({ includeOffline: query.includeOffline === "true" })
    };
  });

  app.get("/api/events/ws", { websocket: true }, (socket) => {
    const threadUnsubscribers = new Map<string, () => void>();
    let unsubscribeSessions: (() => void) | null = null;
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
      unsubscribeSessions?.();
      unsubscribeSessions = null;
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

      const sessionsAfter = input.sessionsAfter ?? 0;
      const projectsAfter = input.projectsAfter ?? 0;
      const tasksAfter = input.tasksAfter ?? 0;
      const connectionsAfter = input.connectionsAfter ?? 0;

      unsubscribeSessions = ctx.threads.subscribeSessions(sessionsAfter, (event) => {
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
        });
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

  app.get("/api/sessions/:sessionId/thread-candidates", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cwd: z.string().min(1).optional()
    }).parse(request.query);
    try {
      return await ctx.threads.listSessionThreadCandidates(params.sessionId, query.limit ?? 50, query.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Session not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/sessions/:sessionId/threads", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const payload = z.discriminatedUnion("action", [
      z.object({ action: z.literal("new"), cwd: z.string().min(1).optional() }),
      z.object({ action: z.literal("resume"), threadId: z.string().min(1), cwd: z.string().min(1).optional() })
    ]).parse(request.body);
    try {
      const thread = payload.action === "new"
        ? await ctx.threads.startSessionThread(params.sessionId, payload.cwd)
        : await ctx.threads.resumeSessionThread(params.sessionId, payload.threadId, payload.cwd);
      ctx.publishProjects();
      return thread;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Session not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/sessions/:sessionId/turn", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const payload = z.object({
      threadId: z.string().min(1),
      input: inputSchema,
      source: z.enum(["web", "telegram", "task"]).optional(),
      options: threadRunOptionsSchema.optional(),
      cwd: z.string().min(1).optional()
    }).parse(request.body);

    try {
      const result = ctx.threads.runSessionThreadTurn(
        params.sessionId,
        payload.threadId,
        payload.input,
        payload.source ?? "web",
        payload.options,
        payload.cwd
      );
      result.promise.catch(() => undefined);
      return { ok: true, thread: result.thread, command: result.command };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Session not found:") || message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.get("/api/threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const thread = ctx.threads.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { error: "thread_not_found" };
    }
    return thread;
  });

  app.delete("/api/threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      ctx.forceReleaseThreadRecordSubscription(params.threadId);
      return await ctx.threads.deleteThread(params.threadId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/threads/:threadId/fork", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ messageId: z.string().min(1) }).parse(request.body);
    try {
      return await ctx.threads.forkThread(params.threadId, payload.messageId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/threads/:threadId/rollback", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ messageId: z.string().min(1) }).parse(request.body);
    try {
      return await ctx.threads.rollbackThreadAfterRecord(params.threadId, payload.messageId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/threads/:threadId/turn", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({
      input: inputSchema,
      source: z.enum(["web", "telegram", "task"]).optional(),
      options: threadRunOptionsSchema.optional()
    }).parse(request.body);

    try {
      const command = ctx.threads.runLocalCommand(params.threadId, payload.input, payload.source ?? "web");
      if (command.handled) return { ok: true, command: command.command };
      ctx.threads.runTurn(params.threadId, payload.input, payload.source ?? "web", payload.options).catch(() => undefined);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/goal", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = threadGoalUpdateSchema.parse(request.body);
    try {
      await ctx.threads.setGoal(params.threadId, payload);
      return { ok: true };
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
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/stop", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      return ctx.threads.stopTurn(params.threadId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
};
