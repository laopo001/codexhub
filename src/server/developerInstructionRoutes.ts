import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CodexhubServerState } from "../core/serverState.js";
import {
  developerInstructionCreateSchema,
  developerInstructionIdSchema,
  developerInstructionUpdateSchema,
  type DeveloperInstructionMutationPayload,
  type DeveloperInstructionsPayload
} from "../shared/apiContract.js";

export type DeveloperInstructionRoutesContext = {
  state: CodexhubServerState;
};

export const registerDeveloperInstructionRoutes = (
  app: FastifyInstance,
  ctx: DeveloperInstructionRoutesContext
) => {
  app.get("/api/developer-instructions", async () => {
    return {
      templates: ctx.state.listDeveloperInstructions()
    } satisfies DeveloperInstructionsPayload;
  });

  app.post("/api/developer-instructions", async (request, reply) => {
    const payload = developerInstructionCreateSchema.parse(request.body);
    try {
      const template = ctx.state.createDeveloperInstruction({
        name: payload.name,
        description: payload.description,
        instructions: payload.instructions
      });
      return {
        ok: true,
        template
      } satisfies DeveloperInstructionMutationPayload;
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to create developer instruction template"
      };
    }
  });

  app.patch("/api/developer-instructions/:id", async (request, reply) => {
    const params = z.object({ id: developerInstructionIdSchema }).strict().parse(request.params);
    const payload = developerInstructionUpdateSchema.parse(request.body);
    const existing = ctx.state.getDeveloperInstruction(params.id);
    if (!existing) {
      reply.code(404);
      return { error: `Developer instruction template not found: ${params.id}` };
    }
    const updated = ctx.state.updateDeveloperInstruction(existing.id, {
      name: payload.name ?? existing.name,
      description: payload.description === null ? undefined : (payload.description ?? existing.description),
      instructions: payload.instructions ?? existing.instructions
    });
    return {
      ok: true,
      template: updated ?? undefined
    } satisfies DeveloperInstructionMutationPayload;
  });

  app.delete("/api/developer-instructions/:id", async (request, reply) => {
    const params = z.object({ id: developerInstructionIdSchema }).strict().parse(request.params);
    const deleted = ctx.state.deleteDeveloperInstruction(params.id);
    if (!deleted) {
      reply.code(404);
      return { error: `Developer instruction template not found: ${params.id}` };
    }
    return {
      ok: true,
      deleted: true
    } satisfies DeveloperInstructionMutationPayload;
  });
};
