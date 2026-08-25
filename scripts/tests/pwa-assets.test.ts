import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { contentType } from "../../src/server/serverFiles.js";

const projectRoot = path.resolve(import.meta.dirname, "../..");

test("PWA manifest declares an installable standalone app and required icons", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "public/manifest.webmanifest"), "utf8")) as {
    id?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    icons?: Array<{ src?: string; sizes?: string; type?: string }>;
  };

  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons?.map(({ src, sizes, type }) => ({ src, sizes, type })), [
    {
      src: "/icons/codexhub-192.png",
      sizes: "192x192",
      type: "image/png"
    },
    {
      src: "/icons/codexhub-512.png",
      sizes: "512x512",
      type: "image/png"
    }
  ]);
  for (const icon of manifest.icons ?? []) {
    const image = await readFile(path.join(projectRoot, "public", icon.src?.replace(/^\//, "") ?? ""));
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const [width, height] = [image.readUInt32BE(16), image.readUInt32BE(20)];
    assert.equal(`${width}x${height}`, icon.sizes);
  }
});

test("production static serving uses the manifest MIME type", () => {
  assert.equal(contentType("manifest.webmanifest"), "application/manifest+json; charset=utf-8");
});
