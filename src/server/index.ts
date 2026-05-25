import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { readCodexUsage } from "../core/codexUsage.js";
import { listLoadableCodexThreads, loadCodexThread } from "../core/codexpLog.js";
import { InstanceHub } from "../core/instanceHub.js";
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

const uploadImageSchema = z.object({
  workingDirectory: z.string().min(1),
  filename: z.string().optional(),
  contentBase64: z.string().min(1)
});

const main = async () => {
  const config = loadConfig();
  const instances = new InstanceHub(config.codexOptions, config.defaultThreadOptions);
  const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });
  const defaultWorkingDirectory = config.defaultThreadOptions.workingDirectory ?? process.cwd();
  const contextWindowTokens = Number(process.env.CODEX_CONTEXT_WINDOW_TOKENS || 0) || null;

  await app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    ok: true,
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

  app.get("/api/instances", async () => ({
    instances: instances.listInstances()
  }));

  app.get("/api/codex-threads", async (request) => {
    const query = z.object({ workingDirectory: z.string().optional() }).parse(request.query);
    const workingDirectory = query.workingDirectory ?? defaultWorkingDirectory;
    await touchWorkspace(workingDirectory);
    return {
      workingDirectory,
      threads: await listLoadableCodexThreads(workingDirectory)
    };
  });

  app.post("/api/instances", async (request) => {
    const payload = z.object({ workingDirectory: z.string().optional() }).parse(request.body ?? {});
    const workingDirectory = payload.workingDirectory ?? defaultWorkingDirectory;
    await touchWorkspace(workingDirectory);
    return instances.createInstance(workingDirectory);
  });

  app.post("/api/instances/restore", async (request, reply) => {
    const payload = z.object({
      workingDirectory: z.string().min(1),
      threadId: z.string().min(1)
    }).parse(request.body);
    await touchWorkspace(payload.workingDirectory);

    const thread = await loadCodexThread(payload.threadId, payload.workingDirectory);
    if (!thread) {
      reply.code(404);
      return { error: "thread_not_found" };
    }

    const title = thread.messages.find((message) => message.role === "user")?.text.slice(0, 80) || payload.threadId;
    return instances.restoreInstance(payload.workingDirectory, payload.threadId, thread.messages, title);
  });

  app.get("/api/instances/:instanceId", async (request, reply) => {
    const params = z.object({ instanceId: z.string().min(1) }).parse(request.params);
    const instance = instances.getInstance(params.instanceId);
    if (!instance) {
      reply.code(404);
      return { error: "instance_not_found" };
    }
    return instance;
  });

  app.post("/api/instances/:instanceId/attach", async (request, reply) => {
    const params = z.object({ instanceId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ clientId: z.string().min(1) }).parse(request.body);
    try {
      return instances.attach(params.instanceId, payload.clientId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.delete("/api/instances/:instanceId", async (request, reply) => {
    const params = z.object({ instanceId: z.string().min(1) }).parse(request.params);
    const query = z.object({ clientId: z.string().optional() }).parse(request.query);
    try {
      return instances.deleteOrDetach(params.instanceId, query.clientId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/instances/:instanceId/turn", async (request, reply) => {
    const params = z.object({ instanceId: z.string().min(1) }).parse(request.params);
    const payload = z.object({
      input: inputSchema,
      source: z.enum(["web", "telegram"]).optional()
    }).parse(request.body);

    try {
      void instances.runTurn(params.instanceId, payload.input, payload.source ?? "web");
      return { ok: true };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/instances/:instanceId/stop", async (request, reply) => {
    const params = z.object({ instanceId: z.string().min(1) }).parse(request.params);
    try {
      return instances.stopTurn(params.instanceId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/instances/:instanceId/events", async (request, reply) => {
    const params = z.object({ instanceId: z.string().min(1) }).parse(request.params);
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    try {
      const unsubscribe = instances.subscribe(params.instanceId, query.after ?? 0, (event) => {
        sendSse(reply.raw, event.kind, event);
      });
      reply.raw.on("close", unsubscribe);
    } catch (error) {
      sendSse(reply.raw, "error", { error: error instanceof Error ? error.message : String(error) });
      reply.raw.end();
    }
  });

  await app.listen({ host: config.host, port: config.port });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
