import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { CodexProxy } from "../core/codexProxy.js";
import { loadConfig } from "../core/config.js";

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

  await app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    ok: true,
    defaultWorkingDirectory: config.defaultThreadOptions.workingDirectory
  }));

  app.post("/api/turn", async (request) => {
    const payload = turnSchema.parse(request.body);
    return proxy.run(payload);
  });

  app.post("/api/turn/stream", async (request, reply) => {
    const payload = turnSchema.parse(request.body);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    try {
      for await (const event of proxy.runStream(payload)) {
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
