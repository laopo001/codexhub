import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MachineHub } from "../core/machineHub.js";
import type { EmbeddedSurfaceHub } from "../core/vscodeSurfaceHub.js";
import {
  embeddedSurfaceHeartbeatSchema,
  embeddedSurfaceRegistrationSchema,
  type EmbeddedSurfacePayload
} from "../shared/apiContract.js";

export type EmbeddedSurfaceRoutesContext = {
  enabled: boolean;
  protocolVersion: number;
  machines: MachineHub;
  surfaces: EmbeddedSurfaceHub;
};

export const registerEmbeddedSurfaceRoutes = (app: FastifyInstance, ctx: EmbeddedSurfaceRoutesContext) => {
  app.post("/api/embedded/surfaces", async (request, reply) => {
    if (!ctx.enabled) {
      reply.code(409);
      return { error: "This CodexHub server is not an embedded authority service." };
    }
    const input = embeddedSurfaceRegistrationSchema.parse(request.body);
    if (input.protocolVersion !== ctx.protocolVersion) {
      reply.code(409);
      return { error: `Unsupported embedded surface protocol: ${input.protocolVersion}.` };
    }

    try {
      const machine = ctx.machines.listMachines().find((item) =>
        item.type === "local"
        && item.online
        && item.capabilities.projectLauncher !== false
      );
      if (!machine) throw new Error("Local project launcher is still starting.");

      const current = ctx.surfaces.get(input.surfaceId, input.leaseId);
      if (
        current
        && current.surface === input.surface
        && current.machineId === machine.machineId
        && current.label === input.label
        && current.buildId === input.buildId
        && current.vscodeChannel === input.vscodeChannel
        && samePaths(current.workspacePaths, input.workspacePaths)
        && current.activeWorkspacePath === normalizedActivePath(input.activeWorkspacePath, input.workspacePaths)
      ) {
        return { ok: true, surface: ctx.surfaces.touch(input.surfaceId, input.leaseId) ?? undefined } satisfies EmbeddedSurfacePayload;
      }

      const listings = await Promise.all(input.workspacePaths.map((workspacePath) =>
        ctx.machines.listDirectory(machine.machineId, { cwd: workspacePath }).promise
      ));
      const workspacePaths = [...new Set(listings.map((listing) => listing.cwd))];
      const activeWorkspacePath = input.activeWorkspacePath
        ? listings.find((_, index) => input.workspacePaths[index] === input.activeWorkspacePath)?.cwd
        : workspacePaths[0];
      const surface = ctx.surfaces.upsert({
        surface: input.surface,
        surfaceId: input.surfaceId,
        leaseId: input.leaseId,
        machineId: machine.machineId,
        workspacePaths,
        activeWorkspacePath,
        label: input.label,
        buildId: input.buildId,
        vscodeChannel: input.vscodeChannel
      });
      return { ok: true, surface } satisfies EmbeddedSurfacePayload;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/embedded/surfaces/:surfaceId/heartbeat", async (request, reply) => {
    if (!ctx.enabled) {
      reply.code(409);
      return { error: "This CodexHub server is not an embedded authority service." };
    }
    const params = z.object({ surfaceId: z.string().trim().min(1).max(200) }).parse(request.params);
    const input = embeddedSurfaceHeartbeatSchema.parse(request.body);
    if (input.protocolVersion !== ctx.protocolVersion) {
      reply.code(409);
      return { error: `Unsupported embedded surface protocol: ${input.protocolVersion}.` };
    }
    const surface = ctx.surfaces.touch(params.surfaceId, input.leaseId);
    if (!surface) {
      reply.code(404);
      return { error: "Embedded surface lease was not found." };
    }
    return { ok: true, surface } satisfies EmbeddedSurfacePayload;
  });

  app.delete("/api/embedded/surfaces/:surfaceId/:leaseId", async (request, reply) => {
    if (!ctx.enabled) {
      reply.code(409);
      return { error: "This CodexHub server is not an embedded authority service." };
    }
    const params = z.object({
      surfaceId: z.string().trim().min(1).max(200),
      leaseId: z.string().trim().min(1).max(200)
    }).parse(request.params);
    ctx.surfaces.remove(params.surfaceId, params.leaseId);
    return { ok: true } satisfies EmbeddedSurfacePayload;
  });
};

const samePaths = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const normalizedActivePath = (active: string | undefined, workspacePaths: string[]) =>
  active && workspacePaths.includes(active) ? active : workspacePaths[0];
