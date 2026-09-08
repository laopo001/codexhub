import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ensureLocalServer } from "../../src/cli/localServerBootstrap.js";
import { codexhubVersion } from "../../src/shared/version.js";

test("a default-port HTTP URL reuses the matching port 80 backend", async () => {
  const dataDir = path.resolve("/tmp/codexhub-port-80-profile");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1");
    requests.push(url.pathname);
    const body = url.pathname === "/api/health" ? {
      ok: true, version: codexhubVersion, serverInstanceId: "port-80-instance",
      configPath: path.join(dataDir, "config.yaml"), port: 80, authRequired: false, authenticated: true,
      features: { localMachine: true }
    } : url.pathname === "/api/machines" ? {
      machines: [{ machineId: "m", type: "local", online: true, capabilities: { projectLauncher: true } }]
    } : { runtimes: [{ machineId: "m", online: true }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const result = await ensureLocalServer({ baseUrl: "http://127.0.0.1:80", dataDir, timeoutMs: 500 });
    assert.equal(result.status, "reused");
    assert.equal(result.machineId, "m");
    assert.deepEqual(requests, ["/api/health", "/api/machines", "/api/runtimes"]);
  } finally { globalThis.fetch = originalFetch; }
});
