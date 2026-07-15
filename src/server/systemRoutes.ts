import type { FastifyInstance, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import type {
  AuthStatusPayload,
  HealthPayload,
  ServerConfigPayload,
  ServerConfigUpdateInput
} from "../shared/apiContract.js";
import { previewImageErrorStatus, resolvePreviewImage } from "./serverFiles.js";

export type SystemRoutesContext = {
  authRequired: boolean;
  isAuthorized: (request: FastifyRequest) => boolean;
  healthPayload: () => Omit<HealthPayload, "authRequired" | "authenticated">;
  configPayload: () => ServerConfigPayload;
  updateUiConfig: (ui: NonNullable<ServerConfigUpdateInput["ui"]>) => void;
};

const serverConfigUpdateSchema = z.object({
  ui: z.object({
    taskCompleteSystemNotifications: z.boolean().optional()
  }).strict().optional()
}).strict();

export const registerSystemRoutes = (app: FastifyInstance, ctx: SystemRoutesContext) => {
  app.get("/api/auth/status", async (request) => ({
    authRequired: ctx.authRequired,
    authenticated: !ctx.authRequired || ctx.isAuthorized(request)
  } satisfies AuthStatusPayload));

  app.get("/api/health", async (request) => ({
    ...ctx.healthPayload(),
    authRequired: ctx.authRequired,
    authenticated: !ctx.authRequired || ctx.isAuthorized(request)
  } satisfies HealthPayload));

  app.get("/api/config", async () => ctx.configPayload());

  app.patch("/api/config", async (request) => {
    const payload = serverConfigUpdateSchema.parse(request.body);
    if (payload.ui) ctx.updateUiConfig(payload.ui);
    return ctx.configPayload();
  });

  app.get("/api/file", async (request, reply) => {
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    try {
      const image = await resolvePreviewImage(query.path);
      reply.type(image.contentType);
      reply.header("cache-control", "private, max-age=60");
      reply.header("content-length", String(image.size));
      reply.header("content-security-policy", "default-src 'none'; img-src 'self' data: blob:");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(createReadStream(image.path));
    } catch (error) {
      reply.code(previewImageErrorStatus(error));
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
};
