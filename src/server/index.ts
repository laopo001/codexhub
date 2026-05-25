import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
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

const main = async () => {
  const config = loadConfig();
  const instances = new InstanceHub(config.codexOptions, config.defaultThreadOptions);
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

  app.get("/api/instances", async () => ({
    instances: instances.listInstances()
  }));

  app.post("/api/instances", async (request) => {
    const payload = z.object({ workingDirectory: z.string().optional() }).parse(request.body ?? {});
    const workingDirectory = payload.workingDirectory ?? defaultWorkingDirectory;
    await touchWorkspace(workingDirectory);
    return instances.createInstance(workingDirectory);
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
