import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHub } from "../../src/core/threadHub.js";
import type { ThreadQueueItem, ThreadStreamEvent, ThreadSummary } from "../../src/shared/threadTypes.js";

const summary = (overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: "end-thread",
  workingDirectory: "/tmp/project",
  runtime: { machineId: "machine", online: true, runnable: true },
  status: "idle",
  running: false,
  title: "End test",
  updatedAt: new Date(0).toISOString(),
  messageCount: 0,
  threadUsage: { context: null, primaryRateLimit: null, secondaryRateLimit: null, observedAt: null },
  ...overrides
});

const queueItem: ThreadQueueItem = {
  submissionId: "queued",
  text: "queued input",
  imageCount: 0,
  source: "cli",
  createdAt: new Date(0).toISOString(),
  position: 1
};

const createHub = () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/project" });
  hub.attachSessionThread("session", "end-thread", "/tmp/project");
  return hub;
};

test("core end rejects running and queued threads before publishing lifecycle", () => {
  const runningHub = createHub();
  runningHub.applySessionEvent("session", {
    type: "thread_execution_changed",
    threadId: "end-thread",
    running: true,
    turnId: "turn"
  });
  assert.throws(() => runningHub.endThread("end-thread"), /running/);

  const queuedHub = new ThreadHub();
  queuedHub.registerSession({
    sessionId: "remote-session",
    machineId: "machine",
    workingDirectory: "/tmp/project",
    transportId: "transport",
    transportRole: "backend",
    remoteGeneration: "generation"
  });
  queuedHub.applySessionEvent("remote-session", {
    type: "thread_projection",
    event: {
      seq: 1,
      threadId: "end-thread",
      kind: "thread",
      thread: summary(),
      queue: [queueItem]
    },
    generation: "generation",
    relaySeq: 1,
    heartbeat: false
  }, "transport");
  assert.throws(() => queuedHub.endThread("end-thread"), /queued messages/);
});

test("core end publishes a live transient and never replays it in history", () => {
  const hub = createHub();
  const live: ThreadStreamEvent[] = [];
  hub.subscribe("end-thread", 0, (event) => live.push(event));

  const result = hub.endThread("end-thread");
  assert.deepEqual(result, { ended: true, lastSeq: result.lastSeq });
  const end = live.find((event) => event.lifecycle === "end");
  assert.ok(end);
  assert.equal(end.historical, undefined);
  assert.equal(end.thread.running, false);

  const history: ThreadStreamEvent[] = [];
  hub.subscribe("end-thread", 0, (event) => history.push(event));
  assert.equal(history.some((event) => event.lifecycle === "end"), false);
});
