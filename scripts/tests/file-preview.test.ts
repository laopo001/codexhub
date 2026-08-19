import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  maxMachineFileChunkBytes,
  normalizeMachineFilePreviewPath,
  readMachineFileChunk,
  resolveMachineFilePreview
} from "../../src/core/filePreview.js";
import { machineFilePreviewResultSchema } from "../../src/shared/apiContract.js";

test("machine file preview returns UTF-8 text and reports truncation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhub-file-preview-"));
  try {
    const filePath = path.join(directory, "example.ts");
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

    const complete = await resolveMachineFilePreview(filePath, { maxBytes: 1024 });
    assert.deepEqual(complete, {
      kind: "text",
      path: filePath,
      size: 17,
      contentType: "text/plain; charset=utf-8",
      text: "alpha\nbeta\ngamma\n",
      truncated: false
    });

    const truncated = await resolveMachineFilePreview(filePath, { maxBytes: 6 });
    assert.equal(truncated.kind, "text");
    if (truncated.kind !== "text") return;
    assert.equal(truncated.text, "alpha\n");
    assert.equal(truncated.truncated, true);
    assert.equal(machineFilePreviewResultSchema.safeParse(truncated).success, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("machine file preview uses signatures for images and rejects other binary content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhub-file-preview-"));
  try {
    const imagePath = path.join(directory, "renamed.data");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    await writeFile(imagePath, png);
    const image = await resolveMachineFilePreview(imagePath, { maxBytes: 1024 });
    assert.deepEqual(image, {
      kind: "image",
      path: imagePath,
      size: png.length,
      contentType: "image/png",
      base64: png.toString("base64")
    });

    const oversized = await resolveMachineFilePreview(imagePath, { maxBytes: 8 });
    assert.deepEqual(oversized, {
      kind: "unsupported",
      path: imagePath,
      size: png.length,
      reason: "file_too_large",
      maxBytes: 8
    });

    const binaryPath = path.join(directory, "binary.bin");
    await writeFile(binaryPath, Buffer.from([0x01, 0x02, 0x03, 0x04]));
    const binary = await resolveMachineFilePreview(binaryPath, { maxBytes: 1024 });
    assert.deepEqual(binary, {
      kind: "unsupported",
      path: binaryPath,
      size: 4,
      reason: "unsupported_type"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("machine file preview exposes MP4 metadata and reads bounded verified chunks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhub-file-preview-"));
  try {
    const filePath = path.join(directory, "video.bin");
    const mp4 = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from("ftypisom", "ascii"),
      Buffer.from([0x00, 0x00, 0x02, 0x00]),
      Buffer.from("isommp42", "ascii"),
      Buffer.from("codexhub-video-payload", "ascii")
    ]);
    await writeFile(filePath, mp4);
    const preview = await resolveMachineFilePreview(filePath, { maxBytes: 8 });
    assert.equal(preview.kind, "media");
    if (preview.kind !== "media") return;
    assert.equal(preview.path, filePath);
    assert.equal(preview.size, mp4.length);
    assert.equal(preview.contentType, "video/mp4");
    assert.equal(machineFilePreviewResultSchema.safeParse(preview).success, true);

    const chunk = await readMachineFileChunk({
      path: preview.path,
      offset: 4,
      length: 12,
      expectedSize: preview.size,
      expectedModifiedAtMs: preview.modifiedAtMs
    });
    assert.equal(Buffer.from(chunk.base64, "base64").equals(mp4.subarray(4, 16)), true);
    assert.equal(chunk.offset, 4);
    assert.equal(chunk.eof, false);

    await assert.rejects(() => readMachineFileChunk({
      path: preview.path,
      offset: 0,
      length: maxMachineFileChunkBytes + 1,
      expectedSize: preview.size,
      expectedModifiedAtMs: preview.modifiedAtMs
    }), /invalid_file_chunk_length/);
    await assert.rejects(() => readMachineFileChunk({
      path: preview.path,
      offset: 0,
      length: 8,
      expectedSize: preview.size + 1,
      expectedModifiedAtMs: preview.modifiedAtMs
    }), /file_changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("machine file preview requires a file and normalizes Windows drives only for WSL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhub-file-preview-"));
  try {
    await mkdir(path.join(directory, "nested"));
    await assert.rejects(() => resolveMachineFilePreview("relative/file.ts"), /absolute_path_required/);
    await assert.rejects(() => resolveMachineFilePreview(path.join(directory, "nested")), /file_not_found/);
    assert.equal(normalizeMachineFilePreviewPath("D:\\projects\\demo.ts", {
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" }
    }), "/mnt/d/projects/demo.ts");
    assert.equal(normalizeMachineFilePreviewPath("D:\\projects\\demo.ts", {
      platform: "win32",
      env: {}
    }), "D:\\projects\\demo.ts");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
