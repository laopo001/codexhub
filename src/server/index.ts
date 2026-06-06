import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MachineHub } from "../core/machineHub.js";
import { loadConfig } from "../core/config.js";
import { loadDotEnv } from "../core/dotenv.js";
import { CodexhubServerState } from "../core/serverState.js";
import { ThreadHub } from "../core/threadHub.js";
import { startTelegramBotFromEnv, type TelegramBotHandle } from "../telegram/index.js";

const inputSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        url: z.string().min(1),
        detail: z.enum(["auto", "low", "high", "original"]).optional()
      })
    ])
  )
]);

const threadRunOptionsSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional()
});

const workerRegistrationSchema = z.object({
  workerId: z.string().min(1).optional(),
  machineId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  workingDirectory: z.string().min(1),
  appServerUrl: z.string().min(1).optional(),
  pid: z.number().int().optional(),
  hostname: z.string().min(1).optional(),
  currentThreadId: z.string().min(1).optional()
});

const workerHeartbeatSchema = workerRegistrationSchema.partial();

const codexRecordSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().optional(),
  type: z.string().min(1),
  payload: z.unknown(),
  line: z.number().int().optional(),
  sourceThreadId: z.string().optional()
});

const workerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thread_event"),
    threadId: z.string().min(1),
    commandId: z.string().min(1).optional(),
    heartbeat: z.boolean().optional(),
    message: z.unknown()
  }),
  z.object({
    type: z.literal("worker_current_changed"),
    currentThreadId: z.string().min(1),
    heartbeat: z.boolean().optional()
  }),
  z.object({
    type: z.literal("thread_execution_changed"),
    threadId: z.string().min(1),
    running: z.boolean(),
    turnId: z.string().min(1).optional(),
    heartbeat: z.boolean().optional()
  }),
  z.object({
    type: z.literal("runtime_settings_changed"),
    threadId: z.string().min(1),
    model: z.string().min(1).nullable().optional(),
    modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional(),
    heartbeat: z.boolean().optional()
  })
]);

const workerTransportMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("register"),
    commandCursor: z.number().int().min(0).optional(),
    registration: workerRegistrationSchema
  }),
  z.object({
    type: z.literal("unregister")
  }),
  z.object({
    type: z.literal("heartbeat"),
    registration: workerHeartbeatSchema.optional()
  }),
  z.object({
    type: z.literal("event"),
    event: workerEventSchema
  }),
  z.object({
    type: z.literal("records"),
    threadId: z.string().min(1),
    heartbeat: z.boolean().optional(),
    records: z.array(codexRecordSchema)
  }),
  z.object({
    type: z.literal("command_result"),
    commandId: z.string().min(1),
    result: z.unknown()
  }),
  z.object({
    type: z.literal("command_error"),
    commandId: z.string().min(1),
    message: z.string().min(1)
  })
]);

const machineRegistrationSchema = z.object({
  machineId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  hostname: z.string().min(1),
  pid: z.number().int().optional(),
  platform: z.string().min(1).optional(),
  cwd: z.string().min(1).optional()
});

const machineHeartbeatSchema = machineRegistrationSchema.partial();

const machineStartWorkerResultSchema = z.object({
  workerId: z.string().min(1),
  threadId: z.string().min(1),
  appServerUrl: z.string().min(1),
  cwd: z.string().min(1),
  reused: z.boolean().optional()
});

const machineDirectoryListingSchema = z.object({
  cwd: z.string().min(1),
  parent: z.string().min(1).optional(),
  home: z.string().min(1),
  entries: z.array(z.object({
    name: z.string().min(1),
    path: z.string().min(1)
  }))
});

const machineTransportMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("register"),
    commandCursor: z.number().int().min(0).optional(),
    registration: machineRegistrationSchema
  }),
  z.object({
    type: z.literal("unregister")
  }),
  z.object({
    type: z.literal("heartbeat"),
    registration: machineHeartbeatSchema.optional()
  }),
  z.object({
    type: z.literal("command_result"),
    commandId: z.string().min(1),
    result: z.union([machineStartWorkerResultSchema, machineDirectoryListingSchema])
  }),
  z.object({
    type: z.literal("command_error"),
    commandId: z.string().min(1),
    message: z.string().min(1)
  })
]);

type SseStream = NodeJS.WritableStream & {
  destroyed?: boolean;
  flushHeaders?: () => void;
  writableEnded?: boolean;
  writeHead?: (statusCode: number, headers: Record<string, string>) => void;
};

const envMs = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const sseHeartbeatMs = () => envMs("CODEX_HUB_SSE_HEARTBEAT_MS", 20_000);

const sseEventId = (data: unknown) => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const seq = (data as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? String(seq) : null;
};

const sendSse = (raw: SseStream, event: string, data: unknown) => {
  const id = sseEventId(data);
  if (id) raw.write(`id: ${id}\n`);
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
};

const sendSseComment = (raw: SseStream, comment: string) => {
  if (raw.destroyed || raw.writableEnded) return;
  raw.write(`: ${comment}\n\n`);
};

const startSse = (raw: SseStream) => {
  raw.writeHead?.(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  raw.flushHeaders?.();
  sendSseComment(raw, "connected");

  const intervalMs = sseHeartbeatMs();
  const heartbeat = intervalMs > 0
    ? setInterval(() => sendSseComment(raw, "ping"), intervalMs)
    : null;
  return () => {
    if (heartbeat) clearInterval(heartbeat);
  };
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const staticRoot = (override?: string) => override
  ? path.resolve(override)
  : path.resolve(process.env.CODEX_HUB_STATIC_DIR ?? path.join(packageRoot, "dist"));
const workerOfflineTimeoutMs = () => envMs("CODEX_HUB_WORKER_OFFLINE_TIMEOUT_MS", 45_000);
const workerOfflineRetentionMs = () => envMs("CODEX_HUB_WORKER_OFFLINE_RETENTION_MS", 30 * 60_000);
const workerSweepIntervalMs = () => envMs("CODEX_HUB_WORKER_SWEEP_INTERVAL_MS", 5_000);
const localApiBaseUrl = (host: string, port: number) => {
  const apiHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${apiHost}:${port}`;
};

export type ServerStartOptions = {
  host?: string;
  port?: number;
  staticDirectory?: string;
};

export type ServerHandle = {
  app: FastifyInstance;
  host: string;
  port: number;
  stop: () => Promise<void>;
};

export const startServer = async (options: ServerStartOptions = {}): Promise<ServerHandle> => {
  const config = loadConfig({ host: options.host, port: options.port });
  const threads = new ThreadHub(config.defaultThreadOptions);
  const state = await CodexhubServerState.load();
  const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });
  const projectSubscribers = new Set<(event: ReturnType<typeof projectSnapshotEvent>) => void>();
  let projectSeq = 0;
  const machines = new MachineHub({ onChange: () => publishProjects() });
  const contextWindowTokens = Number(process.env.CODEX_CONTEXT_WINDOW_TOKENS || 0) || null;
  const staticDirectory = staticRoot(options.staticDirectory);
  let telegramBot: TelegramBotHandle | null = null;
  const workerSweep = setInterval(() => {
    threads.markStaleWorkersOffline(workerOfflineTimeoutMs(), Date.now(), workerOfflineRetentionMs());
  }, workerSweepIntervalMs());
  workerSweep.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(workerSweep);
    telegramBot?.stop("server closing");
    await state.flush();
  });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  function projectSnapshot() {
    return state.snapshot({
      machines: machines.listMachines(),
      workers: threads.listWorkers({ includeOffline: true }),
      threads: threads.listThreads()
    });
  }

  function projectSnapshotEvent() {
    return {
      seq: projectSeq,
      kind: "projects" as const,
      ...projectSnapshot()
    };
  }

  function publishProjects() {
    const event = {
      seq: ++projectSeq,
      kind: "projects" as const,
      ...projectSnapshot()
    };
    for (const subscriber of projectSubscribers) subscriber(event);
  }

  app.get("/api/health", async () => ({
    ok: true,
    env: process.env.CODEX_HUB_ENV ?? process.env.NODE_ENV ?? "development",
    build: process.env.CODEX_HUB_BUILD_ID ?? null,
    host: config.host,
    port: config.port,
    staticDirectory,
    statePath: state.path,
    model: config.defaultThreadOptions.model ?? null,
    modelReasoningEffort: config.defaultThreadOptions.modelReasoningEffort ?? null,
    contextWindowTokens,
    telegram: {
      started: Boolean(telegramBot)
    }
  }));

  app.get("/api/codex-usage", async (request, reply) => {
    reply.header("x-codexhub-compat", "threadUsage");
    const query = z.object({ threadId: z.string().min(1).optional() }).parse(request.query);
    if (!query.threadId) {
      reply.code(400);
      return { error: "threadId_required", message: "This compatibility endpoint only returns thread-local usage." };
    }
    return threads.getThreadUsage(query.threadId);
  });

  app.get("/api/threads", async () => ({
    ...threads.markStaleWorkersOffline(workerOfflineTimeoutMs(), Date.now(), workerOfflineRetentionMs()),
    threads: threads.listThreads()
  }));

  app.get("/api/workers", async (request) => {
    const query = z.object({ includeOffline: z.string().optional() }).parse(request.query);
    return {
      ...threads.markStaleWorkersOffline(workerOfflineTimeoutMs(), Date.now(), workerOfflineRetentionMs()),
      workers: threads.listWorkers({ includeOffline: query.includeOffline === "true" })
    };
  });

  app.get("/api/workers/:workerId/thread-candidates", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);
    try {
      return await threads.listWorkerThreadCandidates(params.workerId, query.limit ?? 50);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Worker not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/workers/:workerId/threads", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const payload = z.discriminatedUnion("action", [
      z.object({ action: z.literal("new") }),
      z.object({ action: z.literal("resume"), threadId: z.string().min(1) })
    ]).parse(request.body);
    try {
      const thread = payload.action === "new"
        ? await threads.startWorkerThread(params.workerId)
        : await threads.resumeWorkerThread(params.workerId, payload.threadId);
      publishProjects();
      return thread;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Worker not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.get("/api/machines", async () => ({
    machines: machines.listMachines()
  }));

  app.get("/api/machines/:machineId/directories", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    try {
      const command = machines.listDirectory(params.machineId, { cwd: query.path });
      return await command.promise;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/projects", async () => projectSnapshot());

  app.get("/api/projects/events", async (request, reply) => {
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);
    const stopSse = startSse(reply.raw);
    const after = query.after ?? 0;
    if (after <= 0) sendSse(reply.raw, "projects", projectSnapshotEvent());
    const subscriber = (event: ReturnType<typeof projectSnapshotEvent>) => {
      if (event.seq > after) sendSse(reply.raw, event.kind, event);
    };
    projectSubscribers.add(subscriber);
    reply.raw.on("close", () => {
      stopSse();
      projectSubscribers.delete(subscriber);
    });
  });

  app.post("/api/projects/open", async (request, reply) => {
    const payload = z.object({
      machineId: z.string().min(1).optional(),
      path: z.string().min(1),
      reuse: z.boolean().optional()
    }).parse(request.body);

    try {
      const machine = resolveTargetMachine(machines.listMachines(), payload.machineId);
      const started = machines.startWorker(machine.machineId, {
        cwd: payload.path,
        reuse: payload.reuse ?? true
      });
      const result = await started.promise;
      const project = state.upsertProject({
        machineId: machine.machineId,
        path: result.cwd,
        workerId: result.workerId,
        threadId: result.threadId
      });
      publishProjects();
      return { ok: true, machine, project, result, ...projectSnapshot() };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/workers/events", async (request, reply) => {
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);
    threads.markStaleWorkersOffline(workerOfflineTimeoutMs(), Date.now(), workerOfflineRetentionMs());

    const stopSse = startSse(reply.raw);

    const unsubscribe = threads.subscribeWorkers(query.after ?? 0, (event) => {
      sendSse(reply.raw, event.kind, event);
    });
    reply.raw.on("close", () => {
      stopSse();
      unsubscribe();
    });
  });

  app.get("/api/workers/connect", { websocket: true }, (socket) => {
    const transportId = randomUUID();
    let workerId: string | null = null;
    let commandCursor = 0;
    let closed = false;
    let commandPumpStarted = false;

    const send = (message: unknown) => {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify(message));
    };

    const startCommandPump = () => {
      if (commandPumpStarted) return;
      commandPumpStarted = true;
      void commandPump().catch((error: unknown) => {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        socket.close();
      });
    };

    const commandPump = async () => {
      while (!closed && workerId) {
        const response = await threads.waitWorkerCommands(workerId, commandCursor, 60_000);
        if (closed || !workerId) return;
        commandCursor = Math.max(commandCursor, response.cursor);
        if (response.commands.length) {
          send({ type: "commands", cursor: commandCursor, commands: response.commands });
        }
      }
    };

    const handleMessage = async (data: unknown) => {
      let parsed: z.infer<typeof workerTransportMessageSchema>;
      try {
        parsed = workerTransportMessageSchema.parse(JSON.parse(String(data)));
      } catch (error) {
        send({ type: "error", message: `invalid worker transport message: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }

      if (parsed.type !== "register" && !workerId) {
        send({ type: "error", message: "worker transport must register before sending messages" });
        return;
      }

      try {
        if (parsed.type === "register") {
          const result = threads.registerWorker({ ...parsed.registration, transportId });
          workerId = result.workerId;
          commandCursor = threads.clampWorkerCommandCursor(workerId, parsed.commandCursor ?? 0);
          send({ type: "registered", workerId, worker: result.worker });
          publishProjects();
          startCommandPump();
          return;
        }

        if (parsed.type === "unregister") {
          threads.unregisterWorker(workerId!, transportId);
          publishProjects();
          workerId = null;
          socket.close();
          return;
        }

        if (parsed.type === "heartbeat") {
          threads.heartbeatWorker(workerId!, parsed.registration ?? {});
          publishProjects();
          return;
        }

        if (parsed.type === "event") {
          threads.applyWorkerEvent(workerId!, parsed.event);
          publishProjects();
          return;
        }

        if (parsed.type === "records") {
          threads.applyWorkerRecords(workerId!, {
            threadId: parsed.threadId,
            records: parsed.records,
            heartbeat: parsed.heartbeat
          });
          publishProjects();
          return;
        }

        if (parsed.type === "command_result") {
          threads.resolveWorkerCommand(workerId!, parsed.commandId, parsed.result);
          publishProjects();
          return;
        }

        threads.failWorkerCommand(workerId!, parsed.commandId, parsed.message);
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };

    socket.on("message", (data: unknown) => void handleMessage(data));
    socket.on("close", () => {
      closed = true;
      if (workerId) {
        threads.disconnectWorker(workerId, transportId);
        publishProjects();
      }
    });
    socket.on("error", () => {
      closed = true;
      if (workerId) {
        threads.disconnectWorker(workerId, transportId);
        publishProjects();
      }
    });
  });

  app.get("/api/machines/connect", { websocket: true }, (socket) => {
    const transportId = randomUUID();
    let machineId: string | null = null;
    let commandCursor = 0;
    let closed = false;
    let commandPumpStarted = false;

    const send = (message: unknown) => {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify(message));
    };

    const startCommandPump = () => {
      if (commandPumpStarted) return;
      commandPumpStarted = true;
      void commandPump().catch((error: unknown) => {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        socket.close();
      });
    };

    const commandPump = async () => {
      while (!closed && machineId) {
        const response = await machines.waitMachineCommands(machineId, commandCursor, 60_000);
        if (closed || !machineId) return;
        commandCursor = Math.max(commandCursor, response.cursor);
        if (response.commands.length) {
          send({ type: "commands", cursor: commandCursor, commands: response.commands });
        }
      }
    };

    const handleMessage = async (data: unknown) => {
      let parsed: z.infer<typeof machineTransportMessageSchema>;
      try {
        parsed = machineTransportMessageSchema.parse(JSON.parse(String(data)));
      } catch (error) {
        send({ type: "error", message: `invalid machine transport message: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }

      if (parsed.type !== "register" && !machineId) {
        send({ type: "error", message: "machine transport must register before sending messages" });
        return;
      }

      try {
        if (parsed.type === "register") {
          const result = machines.registerMachine({ ...parsed.registration, transportId });
          state.upsertMachine({
            machineId: result.machineId,
            hostname: result.machine.hostname,
            name: result.machine.name,
            lastSeenAt: result.machine.lastSeenAt
          });
          machineId = result.machineId;
          commandCursor = machines.clampMachineCommandCursor(machineId, parsed.commandCursor ?? 0);
          send({ type: "registered", machineId, machine: result.machine });
          publishProjects();
          startCommandPump();
          return;
        }

        if (parsed.type === "unregister") {
          machines.unregisterMachine(machineId!, transportId);
          publishProjects();
          machineId = null;
          socket.close();
          return;
        }

        if (parsed.type === "heartbeat") {
          machines.heartbeatMachine(machineId!, parsed.registration ?? {});
          publishProjects();
          return;
        }

        if (parsed.type === "command_result") {
          machines.resolveCommand(machineId!, parsed.commandId, parsed.result);
          publishProjects();
          return;
        }

        machines.failCommand(machineId!, parsed.commandId, parsed.message);
        publishProjects();
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };

    socket.on("message", (data: unknown) => void handleMessage(data));
    socket.on("close", () => {
      closed = true;
      if (machineId) {
        machines.disconnectMachine(machineId, transportId);
        publishProjects();
      }
    });
    socket.on("error", () => {
      closed = true;
      if (machineId) {
        machines.disconnectMachine(machineId, transportId);
        publishProjects();
      }
    });
  });

  app.post("/api/workers/:workerId/turn", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const payload = z.object({
      input: inputSchema,
      source: z.enum(["web", "telegram", "task"]).optional(),
      options: threadRunOptionsSchema.optional()
    }).parse(request.body);

    try {
      const result = threads.runWorkerTurn(params.workerId, payload.input, payload.source ?? "web", payload.options);
      result.promise.catch(() => undefined);
      return { ok: true, thread: result.thread };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Worker has no current thread:") ? 409 : 404);
      return { error: message };
    }
  });

  app.get("/api/threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const thread = threads.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { error: "thread_not_found" };
    }
    return thread;
  });

  app.delete("/api/threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      return await threads.deleteThread(params.threadId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/threads/:threadId/fork", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ messageId: z.string().min(1) }).parse(request.body);
    try {
      return await threads.forkThread(params.threadId, payload.messageId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/threads/:threadId/rollback", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ messageId: z.string().min(1) }).parse(request.body);
    try {
      return await threads.rollbackThreadAfterRecord(params.threadId, payload.messageId);
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
      const command = threads.runLocalCommand(params.threadId, payload.input, payload.source ?? "web");
      if (command.handled) return { ok: true, command: command.command };
      threads.runTurn(params.threadId, payload.input, payload.source ?? "web", payload.options).catch(() => undefined);
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
      return threads.stopTurn(params.threadId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/threads/:threadId/events", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);

    const stopSse = startSse(reply.raw);

    try {
      const unsubscribe = threads.subscribe(params.threadId, query.after ?? 0, (event) => {
        sendSse(reply.raw, event.kind, event);
      });
      reply.raw.on("close", () => {
        stopSse();
        unsubscribe();
      });
    } catch (error) {
      stopSse();
      sendSse(reply.raw, "error", { error: error instanceof Error ? error.message : String(error) });
      reply.raw.end();
    }
  });

  if (staticDirectory) registerStaticRoutes(app, staticDirectory);

  await app.listen({ host: config.host, port: config.port });

  try {
    telegramBot = await startTelegramBotFromEnv({
      apiBaseUrl: localApiBaseUrl(config.host, config.port),
      requireToken: false
    });
  } catch (error) {
    await app.close();
    throw error;
  }

  return {
    app,
    host: config.host,
    port: config.port,
    stop: () => app.close()
  };
};

const resolveTargetMachine = (
  allMachines: Array<{ machineId: string; online: boolean }>,
  requestedMachineId: string | undefined
) => {
  const onlineMachines = allMachines.filter((machine) => machine.online);
  if (requestedMachineId) {
    const machine = onlineMachines.find((item) => item.machineId === requestedMachineId);
    if (!machine) throw new Error(`Machine is offline or not found: ${requestedMachineId}`);
    return machine;
  }
  if (onlineMachines.length === 1) return onlineMachines[0];
  if (onlineMachines.length === 0) throw new Error("No online codexhub machine.");
  throw new Error("Multiple online machines. Choose one before opening a project.");
};

const registerStaticRoutes = (app: FastifyInstance, root: string) => {
  const sendIndex = async (_request: unknown, reply: any) => {
    const indexPath = path.join(root, "index.html");
    if (!await fileExists(indexPath)) {
      reply.code(404);
      return { error: "dist_index_not_found", path: indexPath };
    }
    reply.type("text/html; charset=utf-8");
    return reply.send(createReadStream(indexPath));
  };

  app.get("/", sendIndex);
  app.get("/*", async (request, reply) => {
    const rawPath = (request.params as { "*": string })["*"] ?? "";
    if (rawPath === "api" || rawPath.startsWith("api/")) {
      reply.code(404);
      return { error: "api_route_not_found", path: `/${rawPath}` };
    }
    const requested = path.resolve(root, rawPath);
    if (!requested.startsWith(`${root}${path.sep}`)) {
      reply.code(403);
      return { error: "forbidden_path" };
    }
    if (await fileExists(requested)) {
      reply.type(contentType(requested));
      return reply.send(createReadStream(requested));
    }
    return sendIndex(request, reply);
  });
};

const fileExists = async (filePath: string) => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const contentType = (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".ico") return "image/x-icon";
  return "application/octet-stream";
};

const isDirectEntryPoint = () => {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && path.resolve(entrypoint) === fileURLToPath(import.meta.url));
};

if (isDirectEntryPoint()) {
  await loadDotEnv();
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
