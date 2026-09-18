import assert from "node:assert/strict";
import test from "node:test";
import { machineTransportMessageSchema } from "../src/shared/apiContract.js";
import { RemoteBackendRegistry } from "../src/server/remoteBackendRegistry.js";
import { ThreadHub } from "../src/core/threadHub.js";
import type { ThreadSummary, ThreadStreamEvent } from "../src/shared/threadTypes.js";

const threadSummary = (overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: "thread-1",
  workingDirectory: "/child/project",
  runtime: { machineId: "parent-machine", online: true, runnable: true },
  status: "idle",
  running: false,
  title: "Initial title",
  updatedAt: new Date(0).toISOString(),
  messageCount: 0,
  threadUsage: { context: null, primaryRateLimit: null, secondaryRateLimit: null, observedAt: null },
  ...overrides
});

const projection = (summary: ThreadSummary, seq: number): ThreadStreamEvent => ({
  seq,
  threadId: summary.threadId,
  kind: "thread",
  thread: summary
});

test("backend registration is strict and keeps registered machine type", () => {
  const parsed = machineTransportMessageSchema.parse({
    type: "backend_register",
    protocolVersion: 1,
    generation: "generation-1",
    commandCursor: 4,
    registration: {
      machineId: "parent-machine",
      type: "registered",
      hostname: "child",
      capabilities: { projectLauncher: true },
      projects: [{ path: "/child/project" }]
    }
  });
  assert.equal(parsed.type, "backend_register");
  assert.equal(parsed.registration.type, "registered");
});

test("remote ThreadHub semantic turn routes without creating parent pending command state", async () => {
  const commands: Array<{ sessionId: string; type?: string }> = [];
  const hub = new ThreadHub({}, {
    remoteBackend: {
      execute: async (sessionId, command) => {
        commands.push({ sessionId, type: command.type });
        return { accepted: true };
      }
    }
  });
  hub.registerSession({
    sessionId: "remote-session",
    machineId: "parent-machine",
    workingDirectory: "/child/project",
    transportId: "transport-1",
    transportRole: "backend",
    remoteGeneration: "generation-1"
  });
  hub.attachSessionThread("remote-session", "thread-1", "/child/project");

  const dispatch = hub.runTurnWithDelivery("thread-1", "hello", "web");
  await dispatch.completion;

  assert.equal(dispatch.delivery, "turn");
  assert.deepEqual(commands, [{ sessionId: "remote-session", type: "turn" }]);
  assert.equal(hub.getThreadPage("thread-1")?.records.length, 0);
});

test("remote projection owns child summary while parent stream sequence stays local", () => {
  const hub = new ThreadHub();
  hub.registerSession({
    sessionId: "remote-session",
    machineId: "parent-machine",
    workingDirectory: "/child/project",
    transportId: "transport-1",
    transportRole: "backend",
    remoteGeneration: "generation-1"
  });

  const first = threadSummary({ title: "first", updatedAt: "2026-01-01T00:00:00.000Z" });
  hub.applySessionEvent("remote-session", {
    type: "thread_projection",
    event: projection(first, 7),
    generation: "generation-1",
    relaySeq: 1,
    heartbeat: false
  }, "transport-1");
  assert.equal(hub.getThread("thread-1")?.title, "first");

  hub.applySessionEvent("remote-session", {
    type: "thread_projection",
    event: projection(threadSummary({ title: "stale" }), 8),
    generation: "generation-1",
    relaySeq: 1,
    heartbeat: false
  }, "transport-1");
  assert.equal(hub.getThread("thread-1")?.title, "first");

  hub.applySessionEvent("remote-session", {
    type: "thread_projection",
    event: projection(threadSummary({ title: "new runtime" }), 1),
    generation: "generation-2",
    relaySeq: 1,
    heartbeat: false
  }, "transport-1");
  assert.equal(hub.getThread("thread-1")?.title, "first");
});

test("remote command registry resends pending command after reconnect and rejects stale result", async () => {
  const sent: unknown[] = [];
  const registry = new RemoteBackendRegistry();
  registry.attach({ sessionId: "remote-session", transportId: "transport-1", generation: "generation-1", send: (message) => sent.push(message) });
  const command = {
    commandId: "command-1",
    type: "list_models" as const,
    workingDirectory: "/child/project",
    createdAt: new Date().toISOString(),
    includeHidden: false,
    refresh: false
  };
  const resultPromise = registry.execute("remote-session", command);
  assert.equal(sent.length, 1);

  registry.detach("remote-session", "transport-1");
  registry.attach({ sessionId: "remote-session", transportId: "transport-2", generation: "generation-2", send: (message) => sent.push(message) });
  assert.equal(sent.length, 2);
  assert.equal(registry.resolve("remote-session", "transport-1", "generation-1", "command-1", { stale: true }), false);
  assert.equal(registry.resolve("remote-session", "transport-2", "generation-2", "command-1", { ok: true }), true);
  assert.deepEqual(await resultPromise, { ok: true });
});
