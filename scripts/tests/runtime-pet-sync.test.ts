import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHub } from "../../src/core/threadHub.js";
import type { RuntimeStreamEvent } from "../../src/shared/threadTypes.js";
import { executionChanged, turnCompleted } from "../test-support/appServerEvents.js";

test("runtime stream mirrors thread execution state for detached consumers", async () => {
  const hub = new ThreadHub();
  const sessionId = "desktop-pet-session";
  const threadId = "desktop-pet-thread";
  hub.registerSession({
    sessionId,
    machineId: "desktop-pet-machine",
    workingDirectory: "/tmp/desktop-pet"
  });
  hub.attachSessionThread(sessionId, threadId, "/tmp/desktop-pet");

  const runtimeEvents: RuntimeStreamEvent[] = [];
  const unsubscribe = hub.subscribeRuntimes(0, (event) => runtimeEvents.push(event));
  runtimeEvents.length = 0;

  const completion = hub.runTurn(threadId, "exercise the desktop pet activity stream");
  const commands = await hub.waitSessionCommands(sessionId, 0, 1000);
  assert.equal(commands.commands[0]?.type, "turn");

  const waiting = runtimeEvents.at(-1)?.runtimes[0]?.threads.find((thread) => thread.threadId === threadId);
  assert.equal(waiting?.running, true);
  assert.equal(waiting?.status, "waiting");

  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "desktop-pet-turn"));
  const running = runtimeEvents.at(-1)?.runtimes[0]?.threads.find((thread) => thread.threadId === threadId);
  assert.equal(running?.running, true);
  assert.equal(running?.status, "running");

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "desktop-pet-turn"));
  await completion;
  const idle = runtimeEvents.at(-1)?.runtimes[0]?.threads.find((thread) => thread.threadId === threadId);
  assert.equal(idle?.running, false);
  assert.equal(idle?.status, "idle");

  unsubscribe();
});
