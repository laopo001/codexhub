import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectPetImage, PetImageValidationError } from "../../src/core/petImage.js";
import { CodexPetStore, PetStoreError, resolveCodexPetsRoot } from "../../src/core/petStore.js";

const redSparkPath = fileURLToPath(new URL("../../src/web/pets/assets/red-spark.webp", import.meta.url));

test("pet image validation reads complete PNG data and CRCs", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  assert.deepEqual(inspectPetImage(png), { contentType: "image/png", width: 1, height: 1 });
  const corrupted = Buffer.from(png);
  corrupted[45] = corrupted[45]! ^ 0xff;
  assert.throws(() => inspectPetImage(corrupted), PetImageValidationError);
});

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
    assert.deepEqual(await store.install({ manifest, image }), manifest);
    assert.deepEqual(await store.list(), { pets: [manifest], invalidPets: [] });
    await assert.rejects(
      store.install({ manifest, image }),
      (error: unknown) => error instanceof PetStoreError && error.statusCode === 409
    );
    const replacement = { ...manifest, displayName: "Test Spark Replacement" };
    assert.deepEqual(await store.install({ manifest: replacement, image, replace: true }), replacement);
    assert.deepEqual((await store.list()).pets, [replacement]);
    const resolved = await store.resolveImage(manifest.id);
    assert.equal(resolved.contentType, "image/webp");
    assert.deepEqual([resolved.width, resolved.height], [1536, 2288]);
    assert.equal(resolved.path, path.join(root, manifest.id, manifest.spritesheetPath));
    assert.equal(await store.delete(manifest.id), true);
    assert.equal(await store.delete(manifest.id), false);
    const trashEntries = await readdir(path.join(root, ".trash"));
    assert.equal(trashEntries.length, 2);
    assert.ok(trashEntries.some((entry) => entry.includes("-replaced-")));
    assert.ok(trashEntries.some((entry) => entry.includes("-deleted-")));
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
    for (const id of ["guga", "red-spark"]) {
      await assert.rejects(
        store.install({
          manifest: {
            id,
            displayName: "Override",
            description: "Must not shadow a bundled pet",
            spriteVersionNumber: 2,
            spritesheetPath: "spritesheet.webp",
          },
          image: Buffer.from("AAAA"),
        }),
        (error: unknown) => error instanceof PetStoreError && error.statusCode === 409
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex pet store rejects truncated images and reports invalid packages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-pets-invalid."));
  const store = new CodexPetStore(root);
  try {
    const image = await readFile(redSparkPath);
    const manifest = {
      id: "broken-spark",
      displayName: "Broken Spark",
      description: "Must fail complete WebP validation",
      spriteVersionNumber: 2 as const,
      spritesheetPath: "spritesheet.webp",
    };
    await assert.rejects(
      store.install({ manifest, image: image.subarray(0, 32) }),
      (error: unknown) => error instanceof PetStoreError && /length|chunk|incomplete/i.test(error.message)
    );

    const invalidDirectory = path.join(root, manifest.id);
    await mkdir(invalidDirectory, { recursive: true });
    await writeFile(path.join(invalidDirectory, "pet.json"), JSON.stringify(manifest));
    await writeFile(path.join(invalidDirectory, manifest.spritesheetPath), image.subarray(0, 32));
    assert.deepEqual(await store.list(), {
      pets: [],
      invalidPets: [{ id: manifest.id, error: "The WebP RIFF length does not match the file size." }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
