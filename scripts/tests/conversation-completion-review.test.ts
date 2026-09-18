import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHub } from "../../src/core/threadHub.js";
import { executionChanged, turnCompleted } from "../test-support/appServerEvents.js";
import { setTimeout as delay } from "node:timers/promises";

test("waiting after a steered turn already failed preserves its failure", async () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "review", machineId: "review-machine", workingDirectory: "/tmp" });
  hub.attachSessionThread("review", "review-thread", "/tmp");
  hub.applySessionEvent("review", executionChanged("review-thread", true, "failed-turn"));
  hub.applySessionEvent("review", turnCompleted("review-thread", "failed-turn", {
    status: "failed", errorMessage: "steered turn failed before the waiter attached"
  }));

  await assert.rejects(
    hub.waitForTurnCompletion("review-thread", "failed-turn"),
    /steered turn failed before the waiter attached/
  );
});

test("child backend owns remote steer execution completion even without parent turn state", async () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "child", machineId: "child-machine", workingDirectory: "/tmp" });
  hub.attachSessionThread("child", "thread", "/tmp");
  hub.applySessionEvent("child", executionChanged("thread", true, "child-active-turn"));
  const dispatchPromise = hub.dispatchRemoteBackendCommand("child", {
    commandId: "remote-guidance", type: "turn", threadId: "thread", input: "guidance",
    workingDirectory: "/tmp", createdAt: new Date().toISOString()
  });
  const batch = await hub.waitSessionCommands("child", 0, 1);
  const steer = batch.commands.find(command => command.type === "steer");
  assert.ok(steer);
  hub.resolveSessionCommand("child", steer.commandId, { turnId: "child-active-turn" });
  const dispatch = await dispatchPromise as { result: { delivery: string }; completion: Promise<void> };
  assert.equal(dispatch.result.delivery, "steer");
  let finished = false;
  void dispatch.completion.then(() => { finished = true; });
  await delay(10);
  assert.equal(finished, false, "steer ACK must not finish the parent execution wait");
  hub.applySessionEvent("child", turnCompleted("thread", "child-active-turn"));
  await dispatch.completion;
  assert.equal(finished, true);
});
