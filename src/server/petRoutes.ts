import type { FastifyInstance, FastifyRequest } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { CodexPetStore, maxPetImageBytes, PetStoreError } from "../core/petStore.js";
import type { PetMutationPayload, PetsPayload } from "../shared/petTypes.js";

const petIdSchema = z.object({ id: z.string().min(1) }).strict();
const maxManifestBytes = 32 * 1024;

const petError = (error: unknown) => {
  if (error instanceof PetStoreError) return { status: error.statusCode, message: error.message };
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 600) {
    return { status: statusCode, message: error instanceof Error ? error.message : String(error) };
  }
  return {
    status: (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500,
    message: error instanceof Error ? error.message : String(error),
  };
};

const replacementRequested = (requestUrl: string) => {
  const value = new URL(requestUrl, "http://codexhub.local").searchParams.get("replace");
  if (value !== null && value !== "true") throw new PetStoreError("replace must be omitted or set to true.");
  return value === "true";
};

const readMultipartPet = async (request: FastifyRequest) => {
  if (!request.isMultipart()) throw new PetStoreError("Pet imports must use multipart/form-data.", 415);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhub-pet-upload-"));
  const imagePath = path.join(temporaryDirectory, "spritesheet.upload");
  let manifest: unknown = null;
  let hasImage = false;
  try {
    const parts = request.parts({
      limits: { fieldSize: maxManifestBytes, fields: 1, fileSize: maxPetImageBytes, files: 1, parts: 2 },
    });
    for await (const part of parts) {
      if (part.type === "file") {
        if (part.fieldname !== "spritesheet" || hasImage) {
          part.file.resume();
          throw new PetStoreError("The multipart upload must contain one spritesheet file.");
        }
        hasImage = true;
        await pipeline(part.file, createWriteStream(imagePath, { flags: "wx", mode: 0o600 }));
        if (part.file.truncated) throw new PetStoreError("Pet spritesheets must be 20 MiB or smaller.", 413);
      } else {
        if (part.fieldname !== "manifest" || manifest !== null || typeof part.value !== "string") {
          throw new PetStoreError("The multipart upload must contain one manifest field.");
        }
        try {
          manifest = JSON.parse(part.value);
        } catch {
          throw new PetStoreError("pet.json is not valid JSON.");
        }
      }
    }
    if (!hasImage || manifest === null) throw new PetStoreError("Select pet.json and its PNG or WebP spritesheet.");
    return { imagePath, manifest, temporaryDirectory };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
};

export const registerPetRoutes = (app: FastifyInstance, store = new CodexPetStore()) => {
  app.get("/api/pets", async () => await store.list() satisfies PetsPayload);

  app.post("/api/pets", async (request, reply) => {
    let temporaryDirectory: string | null = null;
    try {
      const upload = await readMultipartPet(request);
      temporaryDirectory = upload.temporaryDirectory;
      const pet = await store.installFromFile({
        imagePath: upload.imagePath,
        manifest: upload.manifest,
        replace: replacementRequested(request.url),
      });
      return { pet } satisfies PetMutationPayload;
    } catch (error) {
      const response = petError(error);
      return reply.code(response.status).send({ error: response.message });
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  app.delete("/api/pets/:id", async (request, reply) => {
    const { id } = petIdSchema.parse(request.params);
    try {
      const deleted = await store.delete(id);
      return { deleted, trashed: deleted } satisfies PetMutationPayload;
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
