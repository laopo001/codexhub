import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { probeEmbeddedAuthorityWithRetry } from "../../src/core/embeddedAuthority.js";

test("embedded authority probe tolerates a transient health connection failure", async () => {
  const authorityId = "authority-probe-retry";
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    if (requests === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      version: "test",
      env: "test",
      host: "127.0.0.1",
      port: 0,
      surface: "default",
      authority: {
        authorityId,
        kind: "linux",
        surfaceProtocolVersion: 2
      },
      features: {
        localMachine: true,
        ssh: true,
        tasks: true,
        integrations: true
      },
      model: null,
      modelReasoningEffort: null,
      serviceTier: null,
      contextWindowTokens: null,
      ssh: { connections: [] },
      telegram: { started: false },
      authRequired: false,
      authenticated: true
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const health = await probeEmbeddedAuthorityWithRetry(
      `http://127.0.0.1:${address.port}`,
      authorityId,
      false,
      { attempts: 2, retryDelayMs: 1 }
    );
    assert.equal(health?.authority?.authorityId, authorityId);
    assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
