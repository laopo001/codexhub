import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { readCodexUsage } from "../core/codexUsage.js";
import { recordsToViews } from "../core/codexRecordView.js";
import { listLoadableCodexThreads, loadCodexThread } from "../core/codexpLog.js";
import { TaskScheduler } from "../core/taskScheduler.js";
import { ThreadHub } from "../core/threadHub.js";
import { addWorkspace, listDirectoryChildren, listWorkspaces, touchWorkspace } from "../core/workspaceState.js";

const inputSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("local_image"), path: z.string() })
    ])
  )
]);

const threadOptionsSchema = z.object({
  model: z.string().min(1).optional(),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional()
});
const threadRunOptionsSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional()
});

const workerRegistrationSchema = z.object({
  workerId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  workingDirectory: z.string().min(1),
  appServerUrl: z.string().min(1).optional(),
  pid: z.number().int().optional(),
  hostname: z.string().min(1).optional()
});

const sendSse = (raw: NodeJS.WritableStream, event: string, data: unknown) => {
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
};

const stripDataUrl = (value: string) => {
  const commaIndex = value.indexOf(",");
  return value.startsWith("data:") && commaIndex !== -1 ? value.slice(commaIndex + 1) : value;
};

const imageExtension = (filename?: string) => {
  const extension = path.extname(filename ?? "").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension) ? extension : ".png";
};

const codexpTmpDirectory = (workingDirectory: string) => path.join(path.resolve(workingDirectory), ".codexp", "tmp");
const boolFromEnv = (value: string | undefined, fallback: boolean) => {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};
const staticRoot = () => boolFromEnv(process.env.CODEX_PROXY_SERVE_STATIC, false)
  ? path.resolve(process.env.CODEX_PROXY_STATIC_DIR ?? "dist")
  : null;
const workerOfflineTimeoutMs = () => Number(process.env.CODEX_PROXY_WORKER_OFFLINE_TIMEOUT_MS || 0) || 45_000;
const workerSweepIntervalMs = () => Number(process.env.CODEX_PROXY_WORKER_SWEEP_INTERVAL_MS || 0) || 5_000;
const uploadImageSchema = z.object({
  workingDirectory: z.string().min(1),
  filename: z.string().optional(),
  contentBase64: z.string().min(1)
});

const main = async () => {
  const config = loadConfig();
  const threads = new ThreadHub(config.defaultThreadOptions);
  const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });
  const defaultWorkingDirectory = config.defaultThreadOptions.workingDirectory ?? process.cwd();
  const contextWindowTokens = Number(process.env.CODEX_CONTEXT_WINDOW_TOKENS || 0) || null;
  const staticDirectory = staticRoot();
  const taskScheduler = new TaskScheduler(threads, defaultWorkingDirectory);
  const workerSweep = setInterval(() => {
    threads.markStaleWorkersOffline(workerOfflineTimeoutMs());
  }, workerSweepIntervalMs());
  workerSweep.unref?.();

  taskScheduler.start();
  await app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    ok: true,
    env: process.env.CODEX_PROXY_ENV ?? process.env.NODE_ENV ?? "development",
    build: process.env.CODEX_PROXY_BUILD_ID ?? null,
    host: config.host,
    port: config.port,
    staticDirectory,
    defaultWorkingDirectory,
    model: config.defaultThreadOptions.model ?? null,
    modelReasoningEffort: config.defaultThreadOptions.modelReasoningEffort ?? null,
    contextWindowTokens
  }));

  app.get("/api/workspaces", async () => ({
    workspaces: await listWorkspaces(defaultWorkingDirectory)
  }));

  app.get("/api/codex-usage", async (request) => {
    const query = z.object({ threadId: z.string().optional() }).parse(request.query);
    return readCodexUsage(query.threadId);
  });

  app.post("/api/workspaces", async (request) => {
    const payload = z.object({ path: z.string().min(1) }).parse(request.body);
    return {
      workspaces: await addWorkspace(payload.path)
    };
  });

  app.get("/api/fs/children", async (request) => {
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    return listDirectoryChildren(query.path ?? os.homedir());
  });

  app.post("/api/uploads/images", async (request) => {
    const payload = uploadImageSchema.parse(request.body);
    const directory = codexpTmpDirectory(payload.workingDirectory);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${Date.now()}-${randomUUID()}${imageExtension(payload.filename)}`);
    await writeFile(filePath, Buffer.from(stripDataUrl(payload.contentBase64), "base64"));
    return { path: filePath };
  });

  app.get("/api/uploads/images", async (request, reply) => {
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    const filePath = path.resolve(query.path);
    if (!filePath.includes(`${path.sep}.codexp${path.sep}tmp${path.sep}`)) {
      reply.code(403);
      return { error: "forbidden_path" };
    }
    return reply.send(createReadStream(filePath));
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

  app.post("/api/workers/register", async (request) => {
    const payload = workerRegistrationSchema.parse(request.body);
    await touchWorkspace(payload.workingDirectory).catch(() => undefined);
    return threads.registerWorker(payload);
  });

  app.post("/api/workers/:workerId/heartbeat", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const payload = workerRegistrationSchema.partial().parse(request.body ?? {});
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

  app.post("/api/workers/:workerId/events", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const payload = z.object({
      threadId: z.string().optional(),
      commandId: z.string().optional(),
      heartbeat: z.boolean().optional(),
      current: z.boolean().optional(),
      message: z.unknown()
    }).parse(request.body);
    try {
      return threads.applyWorkerEvent(params.workerId, payload);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/workers/:workerId/current-thread", async (request, reply) => {
    const params = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ threadId: z.string().min(1) }).parse(request.body);
    try {
      return threads.selectWorkerThread(params.workerId, payload.threadId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/codex-threads", async (request) => {
    const query = z.object({ workingDirectory: z.string().optional() }).parse(request.query);
    const workingDirectory = query.workingDirectory ?? defaultWorkingDirectory;
    await touchWorkspace(workingDirectory);
    return {
      workingDirectory,
      threads: await listLoadableCodexThreads(workingDirectory)
    };
  });

  app.post("/api/threads/restore", async (request, reply) => {
    const payload = z.object({
      workingDirectory: z.string().min(1),
      threadId: z.string().min(1),
      options: threadOptionsSchema.optional()
    }).parse(request.body);
    await touchWorkspace(payload.workingDirectory);

    const thread = await loadCodexThread(payload.threadId, payload.workingDirectory);
    if (!thread) {
      reply.code(404);
      return { error: "thread_not_found" };
    }

    const title = recordsToViews(thread.records).find((message) => message.role === "user")?.text.slice(0, 80) || payload.threadId;
    return threads.restoreThread(payload.workingDirectory, payload.threadId, thread.records, title, payload.options ?? {});
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
