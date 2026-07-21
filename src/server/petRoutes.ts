import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { CodexPetStore, PetStoreError } from "../core/petStore.js";
import type { PetImportInput, PetMutationPayload, PetsPayload } from "../shared/petTypes.js";

const maxBase64Length = Math.ceil((20 * 1024 * 1024) / 3) * 4;

const manifestSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  spriteVersionNumber: z.union([z.literal(1), z.literal(2)]),
  spritesheetPath: z.string(),
}).strict();

const importSchema = z.object({
  manifest: manifestSchema,
  imageBase64: z.string().min(1).max(maxBase64Length),
  mimeType: z.union([z.literal("image/png"), z.literal("image/webp")]),
}).strict();

const petIdSchema = z.object({ id: z.string().min(1) }).strict();

const petError = (error: unknown) => error instanceof PetStoreError
  ? { status: error.statusCode, message: error.message }
  : { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, message: error instanceof Error ? error.message : String(error) };

export const registerPetRoutes = (app: FastifyInstance, store = new CodexPetStore()) => {
  app.get("/api/pets", async () => ({ pets: await store.list() } satisfies PetsPayload));

  app.post("/api/pets", async (request, reply) => {
    try {
      const pet = await store.install(importSchema.parse(request.body) satisfies PetImportInput);
      return { pet } satisfies PetMutationPayload;
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      const response = petError(error);
      return reply.code(response.status).send({ error: response.message });
    }
  });

  app.delete("/api/pets/:id", async (request, reply) => {
    const { id } = petIdSchema.parse(request.params);
    try {
      return { deleted: await store.delete(id) } satisfies PetMutationPayload;
    } catch (error) {
      const response = petError(error);
      return reply.code(response.status).send({ error: response.message });
    }
  });

  app.get("/api/pets/:id/spritesheet", async (request, reply) => {
    const { id } = petIdSchema.parse(request.params);
    try {
      const image = await store.resolveImage(id);
      reply.type(image.contentType);
      reply.header("cache-control", "private, no-cache");
      reply.header("content-length", String(image.size));
      reply.header("content-security-policy", "default-src 'none'; img-src 'self'");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(createReadStream(image.path));
    } catch (error) {
      const response = petError(error);
      return reply.code(response.status).send({ error: response.message });
    }
  });
};
