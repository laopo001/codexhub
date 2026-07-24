import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeCodexHome,
  ModelCatalogCache,
  modelCatalogCachePath
} from "../../src/core/modelCatalogCache.js";

test("model catalog cache uses the CodexHub data directory", () => {
  assert.equal(
    modelCatalogCachePath({}, "/tmp/home"),
    path.resolve("/tmp/home/.config/codexhub/model-catalog-cache.json")
  );
  assert.equal(
    modelCatalogCachePath({ CODEX_HUB_DATA_DIR: "/tmp/custom-codexhub" }, "/tmp/home"),
    path.resolve("/tmp/custom-codexhub/model-catalog-cache.json")
  );
  assert.equal(activeCodexHome({}, "/tmp/home"), path.resolve("/tmp/home/.codex"));
  assert.equal(
    activeCodexHome({ CODEX_HOME: "/tmp/custom-codex" }, "/tmp/home"),
    path.resolve("/tmp/custom-codex")
  );
});

test("model catalog cache persists normalized models and isolates CLI versions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhub-model-cache."));
  const filePath = path.join(directory, "model-catalog-cache.json");
  const cache = new ModelCatalogCache(filePath);
  const key = {
    machineId: "machine-a",
    cliVersion: "0.145.0",
    codexHome: path.join(directory, ".codex"),
    includeHidden: false
  };
  try {
    assert.equal(await cache.get(key), undefined);
    await cache.set({
      ...key,
      updatedAt: "2026-07-24T10:00:00.000Z",
      models: [{
        id: "catalog-gpt",
        model: "gpt-test",
        isDefault: true,
        supportedReasoningEfforts: [{ value: "high", label: "High" }],
        serviceTiers: [{ value: "fast", label: "Fast" }]
      }]
    });
    assert.deepEqual(await new ModelCatalogCache(filePath).get(key), {
      ...key,
      updatedAt: "2026-07-24T10:00:00.000Z",
      models: [{
        id: "catalog-gpt",
        model: "gpt-test",
        isDefault: true,
        supportedReasoningEfforts: [{ value: "high", label: "High" }],
        serviceTiers: [{ value: "fast", label: "Fast" }]
      }]
    });
    assert.equal(await cache.get({ ...key, cliVersion: "0.146.0" }), undefined);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid model catalog cache is ignored", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhub-model-cache-invalid."));
  const filePath = path.join(directory, "model-catalog-cache.json");
  try {
    await writeFile(filePath, "{\"version\":1,\"entries\":{\"bad\":{}}}");
    const cache = new ModelCatalogCache(filePath);
    assert.equal(await cache.get({
      machineId: "machine-a",
      cliVersion: "0.145.0",
      codexHome: path.join(directory, ".codex"),
      includeHidden: false
    }), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
