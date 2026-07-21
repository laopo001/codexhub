import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexPetStore, PetStoreError, resolveCodexPetsRoot } from "../../src/core/petStore.js";

const redSparkPath = fileURLToPath(new URL("../../src/web/pets/assets/red-spark.webp", import.meta.url));

test("Codex pet store persists V2 packages outside browser storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-pets."));
  const store = new CodexPetStore(root);
  try {
    const image = await readFile(redSparkPath);
    const manifest = {
      id: "test-spark",
      displayName: "Test Spark",
      description: "Filesystem-backed test pet",
      spriteVersionNumber: 2 as const,
      spritesheetPath: "spritesheet.webp",
    };
    assert.deepEqual(await store.install({
      manifest,
      imageBase64: image.toString("base64"),
      mimeType: "image/webp",
    }), manifest);
    assert.deepEqual(await store.list(), [manifest]);
    const resolved = await store.resolveImage(manifest.id);
    assert.equal(resolved.contentType, "image/webp");
    assert.deepEqual([resolved.width, resolved.height], [1536, 2288]);
    assert.equal(resolved.path, path.join(root, manifest.id, manifest.spritesheetPath));
    assert.equal(await store.delete(manifest.id), true);
    assert.equal(await store.delete(manifest.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex pet store reserves bundled ids and resolves CODEX_HOME", async () => {
  assert.equal(
    resolveCodexPetsRoot({ CODEX_HOME: "/tmp/custom-codex-home" }, "/unused"),
    "/tmp/custom-codex-home/pets"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-pets-reserved."));
  try {
    const store = new CodexPetStore(root);
    await assert.rejects(
      store.install({
        manifest: {
          id: "red-spark",
          displayName: "Override",
          description: "Must not shadow the bundled default",
          spriteVersionNumber: 2,
          spritesheetPath: "spritesheet.webp",
        },
        imageBase64: "AAAA",
        mimeType: "image/webp",
      }),
      (error: unknown) => error instanceof PetStoreError && error.statusCode === 409
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
