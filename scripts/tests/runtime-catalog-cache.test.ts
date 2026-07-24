import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeCodexHome,
  RuntimeCatalogCache,
  runtimeCatalogCachePath
} from "../../src/core/runtimeCatalogCache.js";

test("runtime catalog cache uses the CodexHub data directory", () => {
  assert.equal(
    runtimeCatalogCachePath({}, "/tmp/home"),
    path.resolve("/tmp/home/.config/codexhub/runtime-catalog-cache")
  );
  assert.equal(
    runtimeCatalogCachePath({ CODEX_HUB_DATA_DIR: "/tmp/custom-codexhub" }, "/tmp/home"),
    path.resolve("/tmp/custom-codexhub/runtime-catalog-cache")
  );
  assert.equal(activeCodexHome({}, "/tmp/home"), path.resolve("/tmp/home/.codex"));
  assert.equal(
    activeCodexHome({ CODEX_HOME: "/tmp/custom-codex" }, "/tmp/home"),
    path.resolve("/tmp/custom-codex")
  );
});

test("runtime catalog cache persists models, permission profiles, and command palette plugins in one store", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhub-runtime-catalog-cache."));
  const cacheDirectory = path.join(directory, "runtime-catalog-cache");
  const baseKey = {
    machineId: "machine-a",
    cliVersion: "0.145.0",
    codexHome: path.join(directory, ".codex")
  };
  let modelFetches = 0;
  let permissionFetches = 0;
  let commandPaletteFetches = 0;
  try {
    const cache = new RuntimeCatalogCache(cacheDirectory);
    const liveModels = await cache.resolve({
      ...baseKey,
      kind: "models",
      includeHidden: false
    }, {
      ttlMs: 60_000,
      fetch: async () => {
        modelFetches += 1;
        return [{
          id: "catalog-gpt",
          model: "gpt-test",
          isDefault: true,
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
          serviceTiers: [{ value: "fast", label: "Fast" }]
        }];
      }
    });
    assert.equal(liveModels.source, "live");

    const livePermissions = await cache.resolve({
      ...baseKey,
      kind: "permission_profiles",
      cwd: "/tmp/project-a"
    }, {
      ttlMs: 60_000,
      fetch: async () => {
        permissionFetches += 1;
        return [{ id: "team-safe", description: "Team policy", allowed: true }];
      }
    });
    assert.equal(livePermissions.source, "live");

    const liveCommandPalette = await cache.resolve({
      ...baseKey,
      kind: "command_palette_plugins",
      cwd: "/tmp/project-a"
    }, {
      ttlMs: 60_000,
      fetch: async () => {
        commandPaletteFetches += 1;
        return [{
          id: "plugin:demo",
          kind: "plugin",
          name: "demo",
          title: "Demo",
          description: "Demo plugin",
          enabled: true,
          source: "plugin"
        }];
      }
    });
    assert.equal(liveCommandPalette.source, "live");

    const reloaded = new RuntimeCatalogCache(cacheDirectory);
    const cachedModels = await reloaded.resolve({
      ...baseKey,
      kind: "models",
      includeHidden: false
    }, {
      ttlMs: 60_000,
      fetch: async () => {
        modelFetches += 1;
        return [];
      }
    });
    const cachedPermissions = await reloaded.resolve({
      ...baseKey,
      kind: "permission_profiles",
      cwd: "/tmp/project-a"
    }, {
      ttlMs: 60_000,
      fetch: async () => {
        permissionFetches += 1;
        return [];
      }
    });
    const cachedCommandPalette = await reloaded.resolve({
      ...baseKey,
      kind: "command_palette_plugins",
      cwd: "/tmp/project-a"
    }, {
      ttlMs: 60_000,
      fetch: async () => {
        commandPaletteFetches += 1;
        return [];
      }
    });
    assert.equal(cachedModels.source, "cache");
    assert.equal(cachedPermissions.source, "cache");
    assert.equal(cachedCommandPalette.source, "cache");
    assert.equal(cachedModels.items[0]?.model, "gpt-test");
    assert.equal(cachedPermissions.items[0]?.id, "team-safe");
    assert.equal(cachedCommandPalette.items[0]?.name, "demo");
    assert.equal(modelFetches, 1);
    assert.equal(permissionFetches, 1);
    assert.equal(commandPaletteFetches, 1);

    const otherCwd = await reloaded.resolve({
      ...baseKey,
      kind: "permission_profiles",
      cwd: "/tmp/project-b"
    }, {
      ttlMs: 60_000,
      fetch: async () => {
        permissionFetches += 1;
        return [{ id: "project-b", description: null, allowed: false }];
      }
    });
    assert.equal(otherCwd.source, "live");
    assert.equal(permissionFetches, 2);
    assert.equal((await stat(cacheDirectory)).mode & 0o777, 0o700);
    const entryPaths = (await readdir(cacheDirectory)).map((name) => path.join(cacheDirectory, name));
    assert.equal(entryPaths.length, 4);
    for (const entryPath of entryPaths) {
      assert.equal((await stat(entryPath)).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      await Promise.all(entryPaths.map(async (entryPath) => {
        const stored = JSON.parse(await readFile(entryPath, "utf8")) as {
          version?: number;
          entry?: { kind?: string };
        };
        assert.equal(stored.version, 1);
        return stored.entry?.kind;
      })).then((kinds) => kinds.sort()),
      ["command_palette_plugins", "models", "permission_profiles", "permission_profiles"]
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime catalog cache coalesces concurrent live refreshes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhub-runtime-catalog-refresh."));
  const cacheDirectory = path.join(directory, "runtime-catalog-cache");
  let fetches = 0;
  const key = {
    machineId: "machine-a",
    cliVersion: "0.145.0",
    codexHome: path.join(directory, ".codex"),
    kind: "permission_profiles" as const,
    cwd: "/tmp/project"
  };
  try {
    const cache = new RuntimeCatalogCache(cacheDirectory);
    const fetch = async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ id: "team-safe", description: null, allowed: true }];
    };
    const [first, second] = await Promise.all([
      cache.resolve(key, { ttlMs: 60_000, refresh: true, fetch }),
      cache.resolve(key, { ttlMs: 60_000, refresh: true, fetch })
    ]);
    assert.equal(first.source, "live");
    assert.deepEqual(second, first);
    assert.equal(fetches, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid runtime catalog cache is ignored", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhub-runtime-catalog-invalid."));
  const cacheDirectory = path.join(directory, "runtime-catalog-cache");
  const key = {
    machineId: "machine-a",
    cliVersion: "0.145.0",
    codexHome: path.join(directory, ".codex"),
    kind: "models" as const,
    includeHidden: false
  };
  try {
    const cache = new RuntimeCatalogCache(cacheDirectory);
    await cache.resolve(key, {
      ttlMs: 60_000,
      fetch: async () => []
    });
    const [entryName] = await readdir(cacheDirectory);
    assert.ok(entryName);
    await writeFile(path.join(cacheDirectory, entryName), "{\"version\":1,\"entry\":{}}");
    const result = await new RuntimeCatalogCache(cacheDirectory).resolve(key, {
      ttlMs: 60_000,
      fetch: async () => []
    });
    assert.equal(result.source, "live");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
