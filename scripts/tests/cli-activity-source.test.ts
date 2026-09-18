import assert from "node:assert/strict";
import test from "node:test";
import { runConversation } from "../../src/cli/conversation.js";
import { ThreadHub } from "../../src/core/threadHub.js";
import {
  machineRegistrationSchema,
  remoteBackendCommandSchema,
  sessionEventSchema,
  threadInputSourceSchema
} from "../../src/shared/apiContract.js";
import type {
  ThreadInputSource,
  ThreadStreamEvent,
  ThreadSummary
} from "../../src/shared/threadTypes.js";
import {
  apiJson,
  createBackendRegistrationFixture,
  waitFor,
  type BackendRegistrationFixture
} from "../test-support/backendRegistrationFixture.js";

const threadId = "thread-source-test";
const sessionId = "session-source-test";
const transportId = "transport-source-test";

const baseThreadSummary = (source?: ThreadInputSource): ThreadSummary => ({
  threadId,
  workingDirectory: "/tmp/project",
  runtime: { machineId: "machine-source-test", online: true, runnable: true },
  status: "idle",
  running: false,
  title: "Source test",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  threadUsage: { context: null, primaryRateLimit: null, secondaryRateLimit: null, observedAt: null },
  ...(source === undefined ? {} : { source })
});

const createLocalHub = () => {
  const hub = new ThreadHub();
  hub.registerSession({
    sessionId,
    machineId: "machine-source-test",
    workingDirectory: "/tmp/project",
    transportId,
    transportRole: "machine"
  });
  hub.attachSessionThread(sessionId, threadId, "/tmp/project");
  return hub;
};

const applySessionMessage = (
  hub: ThreadHub,
  message: unknown,
  commandId?: string
) => hub.applySessionEvent(sessionId, {
  type: "thread_event",
  threadId,
  ...(commandId ? { commandId } : {}),
  heartbeat: false,
  message
}, transportId);

const nextCommand = async (hub: ThreadHub, cursor: number) => {
  const result = await hub.waitSessionCommands(sessionId, cursor, 1_000);
  const command = result.commands.at(-1);
  assert.ok(command);
  return { command, cursor: result.cursor };
};

const markTurnStarted = (hub: ThreadHub, activeTurnId: string) => {
  hub.applySessionEvent(sessionId, {
    type: "thread_execution_changed",
    threadId,
    running: true,
    turnId: activeTurnId,
    heartbeat: false
  }, transportId);
};

const completeTurn = async (hub: ThreadHub, dispatch: { completion: Promise<void> }, activeTurnId: string) => {
  applySessionMessage(hub, {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: activeTurnId,
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        items: []
      }
    }
  });
  await dispatch.completion;
};

test("source schemas accept cli and reject unknown values across request and response projections", () => {
  assert.equal(threadInputSourceSchema.safeParse("cli").success, true);
  assert.equal(threadInputSourceSchema.safeParse("desktop").success, false);

  const command = {
    commandId: "command-source-test",
    type: "turn" as const,
    workingDirectory: "/tmp/project",
    createdAt: "2026-01-01T00:00:00.000Z",
    threadId,
    input: "hello",
    source: "cli"
  };
  assert.equal(remoteBackendCommandSchema.safeParse(command).success, true);
  assert.equal(remoteBackendCommandSchema.safeParse({ ...command, source: "desktop" }).success, false);

  const projectionEvent: ThreadStreamEvent = {
    seq: 1,
    threadId,
    kind: "thread",
    thread: baseThreadSummary("cli")
  };
  const invalidProjectionEvent = {
    ...projectionEvent,
    thread: { ...baseThreadSummary(), source: "desktop" }
  };
  assert.equal(sessionEventSchema.safeParse({
    type: "thread_projection",
    event: projectionEvent,
    generation: "generation-source-test",
    relaySeq: 1,
    heartbeat: false
  }).success, true);
  assert.equal(sessionEventSchema.safeParse({
    type: "thread_projection",
    event: invalidProjectionEvent,
    generation: "generation-source-test",
    relaySeq: 2,
    heartbeat: false
  }).success, false);

  const registration = {
    hostname: "source-test",
    activities: [{
      threadId,
      title: "Source test",
      source: "cli",
      workingDirectory: "/tmp/project",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "running" as const
    }]
  };
  assert.equal(machineRegistrationSchema.safeParse(registration).success, true);
  assert.equal(machineRegistrationSchema.safeParse({
    ...registration,
    activities: [{ ...registration.activities[0], source: "desktop" }]
  }).success, false);
});

test("local CLI source survives app-server snapshots, steer and Goal, then a Web turn replaces it", async () => {
  const hub = createLocalHub();
  let cursor = 0;
  const first = hub.runTurnWithDelivery(threadId, "first", "cli");
  const firstCommandResult = await nextCommand(hub, cursor);
  cursor = firstCommandResult.cursor;
  assert.equal(firstCommandResult.command.type, "turn");
  assert.equal(firstCommandResult.command.source, "cli");
  markTurnStarted(hub, "turn-cli-1");
  assert.equal(hub.getThreadPage(threadId).source, "cli");

  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    heartbeat: false,
    turns: [],
    head: true,
    complete: true,
    snapshotId: "snapshot-source-test",
    page: 0
  }, transportId);
  assert.equal(hub.getThreadPage(threadId).source, "cli");

  const goal = hub.runTurnWithDelivery(threadId, "set a goal", "cli", { goalMode: true });
  const goalCommandResult = await nextCommand(hub, cursor);
  cursor = goalCommandResult.cursor;
  assert.equal(goal.delivery, "goal");
  assert.equal(goalCommandResult.command.type, "set_goal");
  applySessionMessage(hub, {
    result: { goal: { objective: "set a goal", status: "active" } }
  }, goalCommandResult.command.commandId);
  await goal.completion;
  assert.equal(hub.getThreadPage(threadId).source, "cli");

  const steer = hub.runTurnWithDelivery(threadId, "continue", "cli", undefined, "steer-source-test");
  const steerCommandResult = await nextCommand(hub, cursor);
  cursor = steerCommandResult.cursor;
  assert.equal(steer.delivery, "steer");
  assert.equal(steerCommandResult.command.type, "steer");
  assert.equal(steerCommandResult.command.source, "cli");
  applySessionMessage(hub, { result: { turnId: "turn-cli-1" } }, steerCommandResult.command.commandId);
  await steer.completion;
  assert.equal(hub.getThreadPage(threadId).source, "cli");

  await completeTurn(hub, first, "turn-cli-1");
  const web = hub.runTurnWithDelivery(threadId, "web round", "web");
  const webCommandResult = await nextCommand(hub, cursor);
  cursor = webCommandResult.cursor;
  assert.equal(webCommandResult.command.type, "turn");
  assert.equal(webCommandResult.command.source, "web");
  assert.equal(hub.getThreadPage(threadId).source, "web");
  markTurnStarted(hub, "turn-web-1");
  await completeTurn(hub, web, "turn-web-1");
});

test("queued source is retained until the queued turn starts", async () => {
  const hub = createLocalHub();
  let cursor = 0;
  const first = hub.runTurnWithDelivery(threadId, "first", "cli");
  const firstCommandResult = await nextCommand(hub, cursor);
  cursor = firstCommandResult.cursor;
  markTurnStarted(hub, "turn-queue-1");

  const queued = hub.runTurnWithDelivery(threadId, "scheduled", "task", undefined, "queued-source-test");
  assert.equal(queued.delivery, "queued");
  assert.equal(hub.queuedTurnItems(threadId)[0]?.source, "task");
  assert.equal(hub.getThreadPage(threadId).source, "cli");

  await completeTurn(hub, first, "turn-queue-1");
  const queuedCommandResult = await nextCommand(hub, cursor);
  assert.equal(queuedCommandResult.command.type, "turn");
  assert.equal(queuedCommandResult.command.source, "task");
  assert.equal(hub.getThreadPage(threadId).source, "task");
  markTurnStarted(hub, "turn-queue-2");
  await completeTurn(hub, queued, "turn-queue-2");
});

test("remote projection source is forwarded and clears when the newer summary omits it", () => {
  const hub = new ThreadHub();
  hub.registerSession({
    sessionId: "remote-source-session",
    machineId: "remote-source-machine",
    workingDirectory: "/tmp/project",
    transportId: "remote-source-transport",
    transportRole: "backend",
    remoteGeneration: "remote-source-generation"
  });
  hub.attachSessionThread("remote-source-session", threadId, "/tmp/project");

  const projection = (source: ThreadInputSource | undefined, seq: number): ThreadStreamEvent => ({
    seq,
    threadId,
    kind: "thread",
    thread: {
      ...baseThreadSummary(source),
      runtime: { machineId: "remote-source-machine", online: true, runnable: true },
      updatedAt: `2026-01-01T00:00:0${seq}.000Z`
    }
  });
  hub.applySessionEvent("remote-source-session", {
    type: "thread_projection",
    event: projection("cli", 1),
    generation: "remote-source-generation",
    relaySeq: 1,
    heartbeat: false
  }, "remote-source-transport");
  assert.equal(hub.getThreadPage(threadId).source, "cli");

  hub.applySessionEvent("remote-source-session", {
    type: "thread_projection",
    event: projection(undefined, 2),
    generation: "remote-source-generation",
    relaySeq: 2,
    heartbeat: false
  }, "remote-source-transport");
  assert.equal(hub.getThreadPage(threadId).source, undefined);
});

test("CLI conversation source reaches child thread, parent projection, and registered activity", { timeout: 60_000 }, async () => {
  const fixture = await createBackendRegistrationFixture();
  try {
    await registerChildBackend(fixture);
    await waitFor(
      async () => (await apiJson<{ machines?: Array<{ machineId: string; online: boolean }> }>(
        fixture.parentUrl,
        "/api/machines",
        fixture.parentAuthToken
      )).body.machines,
      (machines) => machines?.some((machine) => machine.machineId === "backend-registration-child" && machine.online) === true,
      "registered source test machine"
    );

    const result = await runConversation({
      baseUrl: fixture.parentUrl,
      authToken: fixture.parentAuthToken,
      operation: "start",
      input: "CLI source through registered backend",
      name: "CLI source test",
      machineId: "backend-registration-child",
      cwd: process.cwd(),
      timeoutSeconds: 20
    });
    assert.equal(result.delivery, "turn");

    const parentThread = await waitFor(
      async () => apiJson<ThreadSummary>(
        fixture.parentUrl,
        `/api/threads/${encodeURIComponent(result.threadId)}`,
        fixture.parentAuthToken
      ),
      (response) => response.status === 200 && response.body.source === "cli",
      "parent CLI thread source"
    );
    assert.equal(parentThread.body.source, "cli");

    const childThread = await waitFor(
      async () => apiJson<ThreadSummary>(
        fixture.childUrl,
        `/api/threads/${encodeURIComponent(result.threadId)}`,
        fixture.childAuthToken
      ),
      (response) => response.status === 200 && response.body.source === "cli",
      "child CLI thread source"
    );
    assert.equal(childThread.body.source, "cli");

    const activity = await waitFor(
      async () => (await apiJson<{ machines?: Array<{ machineId: string; activities?: Array<{ threadId: string; source?: ThreadInputSource }> }> }>(
        fixture.parentUrl,
        "/api/machines",
        fixture.parentAuthToken
      )).body.machines,
      (machines) => machines?.some((machine) => machine.machineId === "backend-registration-child"
        && machine.activities?.some((item) => item.threadId === result.threadId && item.source === "cli")) === true,
      "registered CLI activity source",
      20_000
    );
    assert.equal(activity?.find((machine) => machine.machineId === "backend-registration-child")?.activities?.find((item) => item.threadId === result.threadId)?.source, "cli");
  } finally {
    await fixture.stop();
  }
});

const registerChildBackend = async (fixture: BackendRegistrationFixture) => {
  const response = await apiJson(
    fixture.childUrl,
    "/api/registered/parent",
    fixture.childAuthToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: fixture.parentUrl,
        authToken: fixture.parentAuthToken
      })
    }
  );
  assert.equal(response.status, 200);
  await waitFor(
    async () => (await apiJson<{ registration?: { status?: string } }>(
      fixture.childUrl,
      "/api/registered/parent",
      fixture.childAuthToken
    )).body.registration,
    (registration) => registration?.status === "online",
    "child parent registration"
  );
};
