import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHub } from "../src/core/threadHub.js";
import type { RuntimeStreamEvent } from "../src/shared/threadTypes.js";
import { appServerTurn, executionChanged, turnCompleted } from "./support/appServerEvents.js";

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

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "turn/started",
      params: {
        threadId,
        turn: appServerTurn("desktop-pet-turn", {
          status: "inProgress",
          startedAt: 1_700_000_000
        })
      }
    }
  });
  const runningWithClock = runtimeEvents.at(-1)?.runtimes[0]?.threads.find((thread) => thread.threadId === threadId);
  assert.equal(runningWithClock?.activeTurnStartedAt, "2023-11-14T22:13:20.000Z");

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "turn/plan/updated",
      params: {
        threadId,
        turnId: "desktop-pet-turn",
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "inProgress" },
          { step: "Verify", status: "pending" }
        ]
      }
    }
  });
  const runningWithPlan = runtimeEvents.at(-1)?.runtimes[0]?.threads.find((thread) => thread.threadId === threadId);
  assert.deepEqual(runningWithPlan?.activePlanProgress, { currentStep: 2, totalSteps: 3 });

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "desktop-pet-turn"));
  await completion;
  const idle = runtimeEvents.at(-1)?.runtimes[0]?.threads.find((thread) => thread.threadId === threadId);
  assert.equal(idle?.running, false);
  assert.equal(idle?.status, "idle");
  assert.equal(idle?.activePlanProgress, undefined);

  unsubscribe();
});
