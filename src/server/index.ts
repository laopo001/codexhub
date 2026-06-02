import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { loadDotEnv } from "../core/dotenv.js";
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

const rateLimitWindowSchema = z.object({
  used_percent: z.number(),
  window_minutes: z.number(),
  resets_at: z.number()
});
const tokenUsageSchema = z.object({
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
  total_tokens: z.number()
});
const codexUsageSchema = z.object({
  rateLimits: z.object({
    limit_id: z.string().nullable().optional(),
    limit_name: z.string().nullable().optional(),
    primary: rateLimitWindowSchema.nullable().optional(),
    secondary: rateLimitWindowSchema.nullable().optional(),
    plan_type: z.string().nullable().optional(),
    rate_limit_reached_type: z.string().nullable().optional()
  }).nullable(),
  tokenUsage: z.object({
    totalTokenUsage: tokenUsageSchema.nullable(),
    lastTokenUsage: tokenUsageSchema.nullable(),
    modelContextWindow: z.number().nullable()
  }).nullable(),
  sourceFile: z.string().nullable(),
  observedAt: z.string().nullable(),
  source: z.enum(["latest", "thread"])
});

const workerRegistrationSchema = z.object({
  workerId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  workingDirectory: z.string().min(1),
  appServerUrl: z.string().min(1).optional(),
  pid: z.number().int().optional(),
  hostname: z.string().min(1).optional(),
  currentThreadId: z.string().min(1).optional(),
  codexUsage: codexUsageSchema.optional(),
  threadCodexUsage: z.record(z.string(), codexUsageSchema).optional()
});

const workerHeartbeatSchema = workerRegistrationSchema.omit({ currentThreadId: true }).partial();

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

const sendSse = (raw: NodeJS.WritableStream, event: string, data: unknown) => {
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
};

const staticRoot = (override?: string) => override
  ? path.resolve(override)
  : path.resolve(process.env.CODEX_PROXY_STATIC_DIR ?? "dist");
const workerOfflineTimeoutMs = () => Number(process.env.CODEX_PROXY_WORKER_OFFLINE_TIMEOUT_MS || 0) || 45_000;
const workerSweepIntervalMs = () => Number(process.env.CODEX_PROXY_WORKER_SWEEP_INTERVAL_MS || 0) || 5_000;
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
  const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });
  const contextWindowTokens = Number(process.env.CODEX_CONTEXT_WINDOW_TOKENS || 0) || null;
  const staticDirectory = staticRoot(options.staticDirectory);
  let telegramBot: TelegramBotHandle | null = null;
  const workerSweep = setInterval(() => {
    threads.markStaleWorkersOffline(workerOfflineTimeoutMs());
  }, workerSweepIntervalMs());
  workerSweep.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(workerSweep);
    telegramBot?.stop("server closing");
  });
  await app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    ok: true,
    env: process.env.CODEX_PROXY_ENV ?? process.env.NODE_ENV ?? "development",
    build: process.env.CODEX_PROXY_BUILD_ID ?? null,
    host: config.host,
    port: config.port,
    staticDirectory,
    model: config.defaultThreadOptions.model ?? null,
    modelReasoningEffort: config.defaultThreadOptions.modelReasoningEffort ?? null,
    contextWindowTokens,
    telegram: {
      started: Boolean(telegramBot)
    }
  }));

  app.get("/api/codex-usage", async (request) => {
    const query = z.object({ threadId: z.string().optional() }).parse(request.query);
    return threads.getCodexUsage(query.threadId);
  });

  app.get("/api/threads", async () => ({
    ...threads.markStaleWorkersOffline(workerOfflineTimeoutMs()),
    threads: threads.listThreads()
  }));

  app.get("/api/workers", async (request) => {
    const query = z.object({ includeOffline: z.string().optional() }).parse(request.query);
    return {
      ...threads.markStaleWorkersOffline(workerOfflineTimeoutMs()),
      workers: threads.listWorkers({ includeOffline: query.includeOffline === "true" })
    };
  });

  app.get("/api/workers/events", async (request, reply) => {
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);
    threads.markStaleWorkersOffline(workerOfflineTimeoutMs());

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    const unsubscribe = threads.subscribeWorkers(query.after ?? 0, (event) => {
      sendSse(reply.raw, event.kind, event);
    });
    reply.raw.on("close", unsubscribe);
  });

  app.post("/api/workers/register", async (request) => {
    const payload = workerRegistrationSchema.parse(request.body);
    return threads.registerWorker(payload);
  });

  app.post("/api/workers/:workerId/heartbeat", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const payload = workerHeartbeatSchema.parse(request.body ?? {});
    const result = threads.heartbeatWorker(params.workerId, payload);
    if (!result.ok) reply.code(404);
    return result;
  });

  app.delete("/api/workers/:workerId", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const result = threads.unregisterWorker(params.workerId);
    if (!result.ok) reply.code(404);
    return result;
  });

  app.get("/api/workers/:workerId/commands", async (request) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const query = z.object({
      after: z.coerce.number().optional(),
      timeoutMs: z.coerce.number().min(0).max(60000).optional()
    }).parse(request.query);
    return threads.waitWorkerCommands(params.workerId, query.after ?? 0, query.timeoutMs ?? 25000);
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

  app.post("/api/workers/:workerId/events", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const payload = workerEventSchema.parse(request.body);
    try {
      return threads.applyWorkerEvent(params.workerId, payload);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/workers/:workerId/records", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const payload = z.object({
      threadId: z.string().min(1),
      heartbeat: z.boolean().optional(),
      records: z.array(codexRecordSchema)
    }).parse(request.body);
    try {
      return threads.applyWorkerRecords(params.workerId, payload);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
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

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    try {
      const unsubscribe = threads.subscribe(params.threadId, query.after ?? 0, (event) => {
        sendSse(reply.raw, event.kind, event);
      });
      reply.raw.on("close", unsubscribe);
    } catch (error) {
      sendSse(reply.raw, "error", { error: error instanceof Error ? error.message : String(error) });
      reply.raw.end();
    }
  });

  if (staticDirectory) registerStaticRoutes(app, staticDirectory);

  await app.listen({ host: config.host, port: config.port });

  try {
    telegramBot = await startTelegramBotFromEnv({
      apiBaseUrl: localApiBaseUrl(config.host, config.port)
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
