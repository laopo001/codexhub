import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLocalServer } from "../src/cli/localServerBootstrap.js";
import { codexhubVersion } from "../src/shared/version.js";

test("a default-port HTTP URL reuses the matching port 80 backend", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-port-80-profile."));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "authority-id"), "authority-port-800\n");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1");
    requests.push(url.pathname);
    const body = url.pathname === "/api/health" ? {
      ok: true, version: codexhubVersion, serverInstanceId: "port-80-instance",
      configPath: path.join(dataDir, "config.yaml"), host: "127.0.0.1", port: 80, authRequired: false, authenticated: true,
      features: { localMachine: true },
      authority: {
        authorityId: "authority-port-800",
        kind: "linux",
        surfaceProtocolVersion: 2
      }
    } : url.pathname === "/api/machines" ? {
      machines: [{ machineId: "m", type: "local", online: true, capabilities: { projectLauncher: true }, runtime: { machineId: "m", online: true } }]
    } : { machines: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const result = await ensureLocalServer({ baseUrl: "http://127.0.0.1:80", dataDir, host: "127.0.0.1", authToken: "", timeoutMs: 500 });
    assert.equal(result.status, "reused");
    assert.equal(result.machineId, "m");
    assert.deepEqual(requests, ["/api/health", "/api/machines"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
