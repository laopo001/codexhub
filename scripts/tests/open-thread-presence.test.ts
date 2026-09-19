import assert from "node:assert/strict";
import test from "node:test";
import { OpenThreadPresenceHub } from "../../src/core/openThreadPresenceHub.js";
import { webEventsMessageSchema } from "../../src/shared/apiContract.js";

test("authority open threads deduplicate windows and retain a tab until its last owner closes", () => {
  const hub = new OpenThreadPresenceHub();
  const windowA = {}, windowB = {}, reconnectedB = {};
  const local = { machineId: "local", threadId: "a", workingDirectory: "/workspace" };
  const ssh = { machineId: "ssh", threadId: "b", workingDirectory: "/remote" };
  const registered = { machineId: "registered", threadId: "c", workingDirectory: "/remote" };
  const snapshots: string[][] = [];
  const unsubscribe = hub.subscribe((threads) => snapshots.push(threads.map((thread) => thread.threadId)));
  hub.set(windowA, [local, ssh]);
  hub.set(windowB, [local, registered]);
  assert.deepEqual(hub.list(), [local, ssh, registered]);
  hub.set(windowA, []);
  assert.deepEqual(hub.list(), [local, registered]);
  hub.set(reconnectedB, [local, registered]);
  hub.remove(windowB);
  assert.deepEqual(hub.list(), [local, registered]);
  hub.remove(reconnectedB);
  assert.deepEqual(hub.list(), []);
  assert.deepEqual(snapshots.at(-1), []);
  unsubscribe();
});

test("authority presence keeps the newest open time for a shared thread", () => {
  const hub = new OpenThreadPresenceHub();
  const firstWindow = {};
  const secondWindow = {};
  const older = {
    threadId: "thread",
    machineId: "machine",
    workingDirectory: "/older",
    lastOpenedAt: "2026-09-02T00:01:00.000Z"
  };
  const newer = {
    threadId: "thread",
    machineId: "machine",
    workingDirectory: "/newer",
    lastOpenedAt: "2026-09-02T00:02:00.000Z"
  };

  hub.set(firstWindow, [newer]);
  hub.set(secondWindow, [older]);

  assert.deepEqual(hub.list(), [newer]);
});

test("open thread presence rejects cross-machine project targets and non-public fields", () => {
  const entry = { machineId: "ssh", threadId: "a", workingDirectory: "/workspace" };
  assert.equal(webEventsMessageSchema.safeParse({ type: "set_open_threads", threads: [entry] }).success, true);
  assert.equal(webEventsMessageSchema.safeParse({ type: "set_open_threads", threads: [{ ...entry, projectTarget: { machineId: "local", path: "/workspace" } }] }).success, false);
  assert.equal(webEventsMessageSchema.safeParse({ type: "set_open_threads", threads: [{ ...entry, sessionId: "internal" }] }).success, false);
  assert.equal(webEventsMessageSchema.safeParse({ type: "set_open_threads", threads: [{ ...entry, lastOpenedAt: "2026-09-02T00:02:00.000Z" }] }).success, true);
});

test("WebSocket control plane broadcasts exact open sets across windows and removes only the closed owner", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: websocket } = await import("@fastify/websocket");
  const { registerThreadRoutes } = await import("../../src/server/threadRoutes.js");
  const app = Fastify();
  await app.register(websocket);
  registerThreadRoutes(app, {
    markStaleSessions: () => ({ offline: 0, removed: 0 }),
    threads: { subscribeRuntimes: () => () => undefined },
    projectSnapshotEvent: () => ({ kind: "projects", seq: 1 }),
    taskSnapshotEvent: () => ({ kind: "tasks", seq: 1 }),
    connectionSnapshotEvent: () => ({ kind: "connections", seq: 1 }),
    projectSubscribers: new Set(), taskSubscribers: new Set(), connectionSubscribers: new Set()
  } as unknown as Parameters<typeof registerThreadRoutes>[1]);
  const { default: WebSocket } = await import("ws");
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as import("node:net").AddressInfo;
  const a = new WebSocket(`ws://127.0.0.1:${address.port}/api/events/ws`);
  const b = new WebSocket(`ws://127.0.0.1:${address.port}/api/events/ws`);
  await Promise.all([a, b].map((socket) => new Promise<void>((resolve, reject) => {
    socket.once("open", resolve); socket.once("error", reject);
  })));
  const snapshots: Array<Array<{ threadId: string }>> = [];
  a.on("message", (data) => { const message = JSON.parse(String(data)); if (message.type === "open_threads") snapshots.push(message.threads); });
  const waitFor = async (expected: string[]) => {
    for (let i = 0; i < 100; i++) {
      if (JSON.stringify(snapshots.at(-1)?.map((entry) => entry.threadId)) === JSON.stringify(expected)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(snapshots.at(-1)?.map((entry) => entry.threadId), expected);
  };
  try {
    a.send(JSON.stringify({ type: "hello" }));
    b.send(JSON.stringify({ type: "hello" }));
    await waitFor([]);
    const local = { threadId: "local", machineId: "m-local", workingDirectory: "/local" };
    const ssh = { threadId: "ssh", machineId: "m-ssh", workingDirectory: "/ssh" };
    a.send(JSON.stringify({ type: "set_open_threads", threads: [local] }));
    await waitFor(["local"]);
    b.send(JSON.stringify({ type: "set_open_threads", threads: [local, ssh] }));
    await waitFor(["local", "ssh"]);
    b.close();
    await waitFor(["local"]);
    a.send(JSON.stringify({ type: "set_open_threads", threads: [] }));
    await waitFor([]);
  } finally {
    a.terminate(); b.terminate(); await app.close();
  }
});
