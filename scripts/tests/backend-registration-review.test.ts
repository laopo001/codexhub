import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHub } from "../../src/core/threadHub.js";
import type { RemoteBackendCommand } from "../../src/core/remoteBackend.js";
import { RemoteBackendRegistry } from "../../src/server/remoteBackendRegistry.js";
import { executionChanged, turnCompleted } from "../test-support/appServerEvents.js";
import type { ThreadStreamEvent } from "../../src/shared/threadTypes.js";

const command = (commandId: string): RemoteBackendCommand => ({
  commandId,
  type: "list_models",
  workingDirectory: "/tmp/backend-review",
  createdAt: new Date().toISOString()
});

test("remote request deduplication settles every caller", async () => {
  const registry = new RemoteBackendRegistry();
  const frames: unknown[] = [];
  registry.attach({ sessionId: "a", transportId: "wire-a", generation: "g", send: (frame) => frames.push(frame) });
  const request = command("same-request");
  const first = registry.execute("a", request);
  const second = registry.execute("a", request);
  assert.equal(frames.length, 1);
  registry.resolve("a", "wire-a", "g", request.commandId, { value: 42 });
  assert.deepEqual(await Promise.all([first, second]), [{ value: 42 }, { value: 42 }]);
});

test("duplicate remote request IDs cannot return another session's result", async () => {
  const registry = new RemoteBackendRegistry();
  registry.attach({ sessionId: "a", transportId: "wire-a", generation: "g", send: () => undefined });
  registry.attach({ sessionId: "b", transportId: "wire-b", generation: "g", send: () => undefined });
  const request = command("colliding-request");
  const first = registry.execute("a", request);
  const second = registry.execute("b", request);
  const isolated = assert.rejects(second, /session|collision|duplicate|conflict/i);
  registry.resolve("a", "wire-a", "g", request.commandId, { privateToA: true });
  await first;
  await isolated;
});

test("remote turn delivery and submission identity come from child acknowledgement", async () => {
  const hub = new ThreadHub({}, {
    remoteBackend: {
      execute: async () => ({ submissionId: "child-submission", delivery: "queued", accepted: true })
    }
  });
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review", transportRole: "backend" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  // The parent sees an idle thread, while the child has already started a turn.
  const dispatch = hub.runTurnWithDelivery("thread", "next message");
  await dispatch.completion;
  assert.equal(dispatch.delivery, "queued");
  assert.equal(dispatch.submissionId, "child-submission");
});

test("stale parent activity cannot convert a user submission into a goal mutation", async () => {
  const sent: RemoteBackendCommand[] = [];
  const hub = new ThreadHub({}, {
    remoteBackend: {
      execute: async (_sessionId, input) => {
        sent.push(input);
        return { submissionId: "child-submission", delivery: "turn", accepted: true };
      }
    }
  });
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review", transportRole: "backend" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  hub.applySessionEvent("session", executionChanged("thread", true, "old-turn"));
  const dispatch = hub.runTurnWithDelivery("thread", "new objective", "web", { goalMode: true });
  await dispatch.completion;
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0]?.type, "set_goal");
  assert.notEqual(sent[0]?.type, "steer");
  assert.equal(sent[0]?.input, "new objective");
  assert.equal(sent[0]?.options?.goalMode, true);
});

test("HTTP turn response waits for the child delivery acknowledgement", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: websocket } = await import("@fastify/websocket");
  const { registerThreadRoutes } = await import("../../src/server/threadRoutes.js");
  const hub = new ThreadHub({}, {
    remoteBackend: {
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { submissionId: "child-queued", delivery: "queued", accepted: true };
      }
    }
  });
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review", transportRole: "backend" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  const app = Fastify();
  await app.register(websocket);
  registerThreadRoutes(app, {
    threads: hub,
    retainThreadRecordSubscription: () => undefined,
    releaseThreadRecordSubscription: () => undefined
  } as unknown as Parameters<typeof registerThreadRoutes>[1]);
  try {
    const response = await app.inject({ method: "POST", url: "/api/threads/thread/turn", payload: { input: "queued input" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().delivery, "queued");
    assert.equal(response.json().submissionId, "child-queued");
    assert.equal(response.json().queued, true);
  } finally {
    await app.close();
  }
});

test("HTTP wait=true waits for local dispatch completion while default ack stays immediate", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: websocket } = await import("@fastify/websocket");
  const { registerThreadRoutes } = await import("../../src/server/threadRoutes.js");
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  const app = Fastify();
  await app.register(websocket);
  registerThreadRoutes(app, {
    threads: hub,
    retainThreadRecordSubscription: () => undefined,
    releaseThreadRecordSubscription: () => undefined
  } as unknown as Parameters<typeof registerThreadRoutes>[1]);
  try {
    const request = app.inject({
      method: "POST",
      url: "/api/threads/thread/turn?wait=true",
      payload: { input: "wait for completion" }
    });
    const commands = await hub.waitSessionCommands("session", 0, 1);
    const turn = commands.commands.at(-1);
    assert.equal(turn?.type, "turn");
    const returnedEarly = await Promise.race([
      request.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 30))
    ]);
    assert.equal(returnedEarly, false);
    hub.applySessionEvent("session", executionChanged("thread", true, "wait-turn"));
    hub.applySessionEvent("session", turnCompleted("thread", "wait-turn"));
    const response = await request;
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().delivery, "turn");
  } finally {
    await app.close();
  }
});

test("HTTP wait=true for steer waits past steer ACK until the targeted active turn ends", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: websocket } = await import("@fastify/websocket");
  const { registerThreadRoutes } = await import("../../src/server/threadRoutes.js");
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  hub.applySessionEvent("session", executionChanged("thread", true, "active-turn"));
  const app = Fastify();
  await app.register(websocket);
  registerThreadRoutes(app, {
    threads: hub,
    retainThreadRecordSubscription: () => undefined,
    releaseThreadRecordSubscription: () => undefined
  } as unknown as Parameters<typeof registerThreadRoutes>[1]);
  try {
    const request = app.inject({
      method: "POST",
      url: "/api/threads/thread/turn?wait=true",
      payload: { input: "steer the active turn" }
    });
    const commands = await hub.waitSessionCommands("session", 0, 1);
    const steer = commands.commands.at(-1);
    assert.equal(steer?.type, "steer");
    if (!steer) throw new Error("steer command was not queued");
    hub.resolveSessionCommand("session", steer.commandId, { ok: true });
    const returnedAfterAck = await Promise.race([
      request.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 30))
    ]);
    assert.equal(returnedAfterAck, false);
    hub.applySessionEvent("session", turnCompleted("thread", "active-turn"));
    const response = await request;
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().delivery, "steer");
  } finally {
    await app.close();
  }
});

test("HTTP wait=true follows delayed remote completion and returns remote failures", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: websocket } = await import("@fastify/websocket");
  const { registerThreadRoutes } = await import("../../src/server/threadRoutes.js");
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  const hub = new ThreadHub({}, {
    remoteBackend: {
      execute: async () => ({ submissionId: "remote-submission", delivery: "turn", accepted: true }),
      waitForCompletion: async () => completion
    }
  });
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review", transportRole: "backend" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  const app = Fastify();
  await app.register(websocket);
  registerThreadRoutes(app, {
    threads: hub,
    retainThreadRecordSubscription: () => undefined,
    releaseThreadRecordSubscription: () => undefined
  } as unknown as Parameters<typeof registerThreadRoutes>[1]);
  try {
    const request = app.inject({
      method: "POST",
      url: "/api/threads/thread/turn?wait=true",
      payload: { input: "remote delayed turn" }
    });
    const returnedEarly = await Promise.race([
      request.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 30))
    ]);
    assert.equal(returnedEarly, false);
    finish();
    const response = await request;
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().submissionId, "remote-submission");
  } finally {
    await app.close();
  }

  const failedHub = new ThreadHub({}, {
    remoteBackend: {
      execute: async () => ({ submissionId: "failed-submission", delivery: "turn", accepted: true }),
      waitForCompletion: async () => { throw new Error("remote completion failed"); }
    }
  });
  failedHub.registerSession({ sessionId: "failed-session", machineId: "machine", workingDirectory: "/tmp/backend-review", transportRole: "backend" });
  failedHub.attachSessionThread("failed-session", "failed-thread", "/tmp/backend-review");
  const failedApp = Fastify();
  await failedApp.register(websocket);
  registerThreadRoutes(failedApp, {
    threads: failedHub,
    retainThreadRecordSubscription: () => undefined,
    releaseThreadRecordSubscription: () => undefined
  } as unknown as Parameters<typeof registerThreadRoutes>[1]);
  try {
    const response = await failedApp.inject({
      method: "POST",
      url: "/api/threads/failed-thread/turn?wait=true",
      payload: { input: "remote failure" }
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /remote completion failed/);
  } finally {
    await failedApp.close();
  }
});

test("child acknowledges a remote turn before execution completes", async () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "local", machineId: "machine", workingDirectory: "/tmp/backend-review" });
  hub.attachSessionThread("local", "thread", "/tmp/backend-review");
  const acknowledgement = hub.dispatchRemoteBackendCommand("local", {
    ...command("submission-request"), type: "turn", threadId: "thread", input: "long running work", submissionId: "original-submission"
  });
  const commands = await hub.waitSessionCommands("local", 0, 1);
  assert.equal(commands.commands.at(-1)?.type, "turn");
  const acknowledgedBeforeDone = await Promise.race([
    acknowledgement.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 30))
  ]);
  // Finish the simulated turn even when the assertion will fail.
  hub.applySessionEvent("local", executionChanged("thread", true, "actual-turn"));
  hub.applySessionEvent("local", turnCompleted("thread", "actual-turn"));
  const dispatch = await acknowledgement as { result: { submissionId?: string; delivery?: string }; completion: Promise<void> };
  assert.equal(acknowledgedBeforeDone, true, "an executing turn must not block its acknowledgement, stop or approval commands");
  assert.equal(dispatch.result.submissionId, "original-submission");
  await dispatch.completion;
});

test("remote task completion remains pending after delivery acknowledgement", async () => {
  let finish: () => void = () => undefined;
  const execution = new Promise<void>((resolve) => { finish = resolve; });
  const hub = new ThreadHub({}, {
    remoteBackend: {
      execute: async () => ({ submissionId: "task-submission", delivery: "queued", accepted: true }),
      waitForCompletion: async () => execution
    }
  });
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review", transportRole: "backend" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  const dispatch = hub.runTurnWithDelivery("thread", "background task", "task");
  let completed = false;
  const completion = dispatch.completion.then(() => { completed = true; });
  try {
    await dispatch.deliveryAcknowledgement;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatch.delivery, "queued");
    assert.equal(completed, false, "acknowledgement must not finish the task scheduler's execution promise");
  } finally {
    finish();
    await completion;
  }
});

test("the first backend command uses the generation negotiated during registration", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { MachineHub } = await import("../../src/core/machineHub.js");
  const { startParentBackendRegistration } = await import("../../src/server/parentBackendRegistration.js");
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let complete: (value: unknown) => void = () => undefined;
  const result = new Promise<unknown>((resolve) => { complete = resolve; });
  sockets.on("connection", (socket) => {
    let generation: string;
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "backend_register") {
        generation = frame.generation;
        socket.send(JSON.stringify({ type: "registered", machineId: "exported" }));
      } else if (frame.type === "session_register") {
        socket.send(JSON.stringify({ type: "session_registered", sessionId: frame.sessionId }));
        socket.send(JSON.stringify({
          type: "backend_command", protocolVersion: 1, generation,
          sessionId: frame.sessionId, commandId: "first-command", command: command("first-command")
        }));
      } else if (frame.type === "backend_command_result") {
        complete(frame.result);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const threads = new ThreadHub();
  threads.registerSession({ sessionId: "local-session", machineId: "local", workingDirectory: "/tmp/backend-review" });
  threads.dispatchRemoteBackendCommand = async (sessionId) => ({ executedBy: sessionId });
  const machines = new MachineHub();
  machines.registerMachine({ machineId: "local", type: "local", hostname: "fixture", cwd: "/tmp/backend-review" });
  const runner = startParentBackendRegistration({
    apiBase: `http://127.0.0.1:${address.port}`, machineId: "exported", name: "fixture",
    localMachineId: "local", threads, machines, projects: () => [], activities: () => [],
    retainThreadRecordSubscription: () => undefined, releaseThreadRecordSubscription: () => undefined
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await runner.start();
    const actual = await Promise.race([
      result,
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("command was silently dropped"), 500); })
    ]);
    assert.deepEqual(actual, { executedBy: "local-session" });
  } finally {
    clearTimeout(timer);
    await runner.stop();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("backend submissions preserve local slash commands instead of starting a model turn", async () => {
  for (const input of ["/status", "/unsupported-command"]) {
    const hub = new ThreadHub();
    hub.registerSession({ sessionId: "local", machineId: "machine", workingDirectory: "/tmp/backend-review" });
    hub.attachSessionThread("local", "thread", "/tmp/backend-review");
    const dispatched = await hub.dispatchRemoteBackendCommand("local", {
      ...command("slash-request"), type: "turn", threadId: "thread", input, source: "web"
    }) as { completion?: Promise<void> };
    const pending = await hub.waitSessionCommands("local", 0, 1);
    const modelTurns = pending.commands.filter((item) => item.type === "turn");
    if (modelTurns.length) {
      hub.applySessionEvent("local", executionChanged("thread", true, "actual-turn"));
      hub.applySessionEvent("local", turnCompleted("thread", "actual-turn"));
    }
    await dispatched.completion;
    assert.equal(modelTurns.length, 0, `${input} must stay a CodexHub command on the child`);
    assert.ok(hub.getThread("thread")?.records.some((record) => JSON.stringify(record.payload).includes(
      input === "/status" ? "Codex Hub Status" : "Unsupported slash command"
    )));
  }
});

test("a completed head snapshot can still have older remote history pages", async () => {
  let fetched = 0;
  const hub = new ThreadHub({}, {
    remoteBackend: {
      execute: async () => {
        fetched += 1;
        project({
          seq: 2, kind: "thread", historical: true,
          records: [{ id: "older", order: 1, type: "event_msg", payload: { type: "user_message", message: "older message" } }],
          snapshot: { snapshotId: "history", page: 1, reset: false, complete: true, history: { hasOlder: false, loadedRecordCount: 2 } }
        }, 2);
        return { loaded: true, snapshotId: "history", page: 1, complete: true };
      }
    }
  });
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review", transportRole: "backend", remoteGeneration: "generation" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  const project = (event: Omit<ThreadStreamEvent, "thread" | "threadId">, relaySeq: number) => hub.applySessionEvent("session", {
    type: "thread_projection", generation: "generation", relaySeq,
    event: { ...event, threadId: "thread", thread: hub.getThread("thread")! }
  });
  project({
    seq: 1, kind: "thread", historical: true,
    records: [{ id: "newest", order: 2, type: "event_msg", payload: { type: "user_message", message: "latest message" } }],
    snapshot: { snapshotId: "history", page: 0, reset: true, complete: true, history: { hasOlder: true, loadedRecordCount: 1 } }
  }, 1);
  const page = await hub.loadThreadHistoryPage("thread", { before: "newest", limit: 1 });
  assert.equal(fetched, 1, "complete marks the delivered snapshot, not the end of all official history");
  assert.deepEqual(page.records.map((record) => record.id), ["older"]);
});

test("remote command output deltas reach the parent WebSocket subscribers", () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review", transportRole: "backend", remoteGeneration: "generation" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  const project = (event: Omit<ThreadStreamEvent, "thread" | "threadId">, relaySeq: number) => hub.applySessionEvent("session", {
    type: "thread_projection", generation: "generation", relaySeq,
    event: { ...event, threadId: "thread", thread: hub.getThread("thread")! }
  });
  project({ seq: 1, kind: "record", record: { id: "tool", type: "event_msg", payload: { type: "exec_command_end", aggregated_output: "initial" } } }, 1);
  const events: ThreadStreamEvent[] = [];
  const unsubscribe = hub.subscribe("thread", hub.getThread("thread")!.lastSeq, (event) => events.push(event));
  try {
    project({ seq: 2, kind: "record_delta", delta: { recordId: "tool", field: "aggregated_output", append: " output" } }, 2);
    assert.deepEqual(events.at(-1)?.delta, { recordId: "tool", field: "aggregated_output", append: " output" });
    assert.equal((hub.getThread("thread")!.records.find((record) => record.id === "tool")!.payload as { aggregated_output: string }).aggregated_output, "initial output");
  } finally {
    unsubscribe();
  }
});

test("remote runtime summaries preserve activity without a transcript subscription", () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/backend-review", transportRole: "backend", remoteGeneration: "generation" });
  hub.attachSessionThread("session", "thread", "/tmp/backend-review");
  const childSummary = {
    ...hub.getThread("thread")!, running: true, status: "running" as const,
    activeTurnId: "turn", activeTurnStartedAt: "2026-09-08T00:00:00.000Z",
    activePlanProgress: { currentStep: 2, totalSteps: 3 },
    activityTitle: "current objective", latestAgentMessage: "current progress", messageCount: 42
  };
  hub.applySessionEvent("session", {
    type: "runtime_projection", generation: "generation", relaySeq: 1,
    runtime: { ...hub.runtimeForMachine("machine")!, threads: [childSummary] }, threads: [childSummary]
  });
  const actual = hub.runtimeForMachine("machine")!.threads[0]!;
  assert.equal(actual.activeTurnStartedAt, childSummary.activeTurnStartedAt);
  assert.deepEqual(actual.activePlanProgress, childSummary.activePlanProgress);
  assert.equal(actual.activityTitle, childSummary.activityTitle);
  assert.equal(actual.latestAgentMessage, childSummary.latestAgentMessage);
  assert.equal(actual.messageCount, childSummary.messageCount);
  assert.equal(hub.getThread("thread")!.records.length, 0);
});
