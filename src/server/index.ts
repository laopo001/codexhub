import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { CodexProxy } from "../core/codexProxy.js";
import { loadConfig } from "../core/config.js";
import { listLoadableCodexThreads, loadCodexThread } from "../core/codexpLog.js";
import { addWorkspace, listDirectoryChildren, listWorkspaces, touchWorkspace } from "../core/workspaceState.js";

const turnSchema = z.object({
  input: z.union([
    z.string(),
    z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("local_image"), path: z.string() })
      ])
    )
  ]),
  threadId: z.string().optional(),
  workingDirectory: z.string().optional(),
  skipGitRepoCheck: z.boolean().optional(),
  options: z.record(z.string(), z.unknown()).optional()
});

const sendSse = (raw: NodeJS.WritableStream, event: string, data: unknown) => {
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
};

const main = async () => {
  const config = loadConfig();
  const proxy = new CodexProxy(config.codexOptions, config.defaultThreadOptions);
  const app = Fastify({ logger: true });
  const defaultWorkingDirectory = config.defaultThreadOptions.workingDirectory ?? process.cwd();

  await app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    ok: true,
    defaultWorkingDirectory
  }));

  app.get("/api/workspaces", async () => ({
    workspaces: await listWorkspaces(defaultWorkingDirectory)
  }));

  app.post("/api/workspaces", async (request) => {
    const payload = z.object({ path: z.string().min(1) }).parse(request.body);
    return {
      workspaces: await addWorkspace(payload.path)
    };
  });

  app.get("/api/fs/children", async (request) => {
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    return listDirectoryChildren(query.path ?? defaultWorkingDirectory);
  });

  app.post("/api/turn", async (request) => {
    const payload = turnSchema.parse(request.body);
    return proxy.run(payload);
  });

  app.get("/api/threads", async (request) => {
    const query = z.object({ workingDirectory: z.string().optional() }).parse(request.query);
    const workingDirectory = query.workingDirectory ?? defaultWorkingDirectory;
    await touchWorkspace(workingDirectory);
    return {
      workingDirectory,
      threads: await listLoadableCodexThreads(workingDirectory)
    };
  });

  app.get("/api/threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const query = z.object({ workingDirectory: z.string().optional() }).parse(request.query);
    const workingDirectory = query.workingDirectory ?? defaultWorkingDirectory;
    await touchWorkspace(workingDirectory);
    const thread = await loadCodexThread(params.threadId, workingDirectory);
    if (!thread) {
      reply.code(404);
      return { error: "thread_not_found" };
    }
    return thread;
  });

  app.delete("/api/threads/:threadId/cache", async (request) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const query = z.object({ workingDirectory: z.string().optional() }).parse(request.query);
    const workingDirectory = query.workingDirectory ?? defaultWorkingDirectory;
    return {
      released: proxy.releaseThread(params.threadId, { workingDirectory })
    };
  });

  app.post("/api/turn/stream", async (request, reply) => {
    const payload = turnSchema.parse(request.body);
    const abortController = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });
    await touchWorkspace(payload.workingDirectory ?? defaultWorkingDirectory);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    try {
      for await (const event of proxy.runStream({ ...payload, signal: abortController.signal })) {
        sendSse(reply.raw, event.type, event);
      }
      sendSse(reply.raw, "done", { ok: true });
    } catch (error) {
      sendSse(reply.raw, "error", {
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      reply.raw.end();
    }
  });

  await app.listen({ host: config.host, port: config.port });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
