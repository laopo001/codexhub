import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerServerLifecycle } from "../src/server/serverLifecycle.js";
import { ThreadHub } from "../src/core/threadHub.js";

test("shutdown releases an HTTP request waiting for runtime cleanup before draining HTTP", { timeout: 5000 }, async (t) => {
  const app = Fastify();
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "old", machineId: "machine", workingDirectory: "/tmp" });
  let entered!: () => void;
  const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
  const stopped = new Set<string>();
  let flushed = false;
  registerServerLifecycle(app, {
    intervals: [], subscriptionTimers: new Map(),
    stopTunneledSessions: async () => { stopped.add("tunnel"); },
    stopSshMachines: async () => { stopped.add("ssh"); },
    stopParentRegistration: async () => { stopped.add("parent"); },
    stopLocalMachine: async () => {
      hub.unregisterSession("old");
      stopped.add("local");
    },
    stopEmbeddedSurfaces: () => { stopped.add("surfaces"); },
    stopIntegrations: () => { stopped.add("integrations"); },
    flushState: async () => { flushed = true; }
  });
  app.get("/pending", async (_request, reply) => {
    const candidates = hub.listSessionThreadCandidates("old");
    entered();
    try {
      return await candidates;
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
  t.after(async () => { hub.unregisterSession("old"); await app.close(); });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = fetch(`${url}/pending`);
  await requestEntered;
  await app.close();
  const result = await response;
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: "Session unregistered: old" });
  assert.equal(stopped.size, 6);
  assert.equal(flushed, true);
});

test("runtime replacement terminates pending and subsequent command polls", async () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "old", machineId: "machine", workingDirectory: "/tmp" });
  const pending = hub.waitSessionCommands("old", 0, 60_000);
  const rejected = assert.rejects(pending, /Session is offline: old/);
  hub.registerSession({ sessionId: "new", machineId: "machine", workingDirectory: "/tmp" });
  await rejected;
  await assert.rejects(hub.waitSessionCommands("old", 0, 60_000), /Session is offline: old/);
  assert.deepEqual((await hub.waitSessionCommands("new", 0, 1)).commands, []);
});

test("disconnected runtime wakes and terminates its command poll", async () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "old", machineId: "machine", workingDirectory: "/tmp" });
  const rejected = assert.rejects(hub.waitSessionCommands("old", 0, 60_000), /Session is offline/);
  hub.disconnectSession("old");
  await rejected;
});
