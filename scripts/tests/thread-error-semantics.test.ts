import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHub } from "../../src/core/threadHub.js";
import type { SessionCommand } from "../../src/shared/threadTypes.js";
import {
  appServerTurn,
  executionChanged,
  turnCompleted,
  turnSnapshot
} from "../test-support/appServerEvents.js";

const createHub = (suffix: string) => {
  const hub = new ThreadHub();
  const sessionId = `${suffix}-session`;
  const threadId = `${suffix}-thread`;
  hub.registerSession({
    sessionId,
    machineId: `${suffix}-machine`,
    workingDirectory: `/tmp/${suffix}`
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_settings_changed",
    threadId
  });
  return { hub, sessionId, threadId };
};

const nextCommand = async (hub: ThreadHub, sessionId: string, after = 0) => {
  const batch = await hub.waitSessionCommands(sessionId, after, 1);
  const command = batch.commands[0];
  assert.ok(command);
  return command;
};

const errorPayloads = (hub: ThreadHub, threadId: string) =>
  (hub.getThread(threadId)?.records ?? [])
    .filter((record) => record.type === "error")
    .map((record) => record.payload as Record<string, unknown>);

const goalStatuses = (hub: ThreadHub, threadId: string) =>
  (hub.getThread(threadId)?.records ?? [])
    .map((record) => record.payload as Record<string, unknown>)
    .filter((payload) => payload.type === "thread_goal_updated")
    .map((payload) => (payload.goal as Record<string, unknown> | undefined)?.status);

const startGoalRun = async (suffix: string) => {
  const fixture = createHub(suffix);
  const objective = "continue the active goal";
  const initialGoal = fixture.hub.setGoal(fixture.threadId, {
    objective,
    status: "active",
    runPolicy: {
      type: "consumeUntilWeeklyRemainingAtOrBelow",
      targetRemainingPercent: 1
    }
  });
  const goalCommand = await nextCommand(fixture.hub, fixture.sessionId);
  assert.equal(goalCommand.type, "set_goal");
  fixture.hub.resolveSessionCommand(fixture.sessionId, goalCommand.commandId, {});
  await initialGoal;
  const turnCommand = await nextCommand(fixture.hub, fixture.sessionId, goalCommand.seq);
  assert.equal(turnCommand.type, "turn");
  assert.equal(turnCommand.input, objective);
  fixture.hub.applySessionEvent(
    fixture.sessionId,
    executionChanged(fixture.threadId, true, "initial-goal-turn")
  );
  return { ...fixture, objective, turnCommand };
};

type GoalRunFixture = Awaited<ReturnType<typeof startGoalRun>>;

const requestGoalResume = async (fixture: GoalRunFixture) => {
  const { hub, sessionId, threadId, turnCommand } = fixture;
  const stop = hub.stopTurn(threadId);
  const stopCommand = await nextCommand(hub, sessionId, turnCommand.seq);
  hub.resolveSessionCommand(sessionId, stopCommand.commandId, {});
  await stop;
  const resume = hub.setGoal(threadId, { status: "active" });
  const resumeCommand = await nextCommand(hub, sessionId, stopCommand.seq);
  return { resume, resumeCommand };
};

for (const terminalBeforeResponse of [false, true]) {
  test(`stopped Goal resumes exactly once when ${terminalBeforeResponse
    ? "the interrupted terminal arrives before the goal response"
    : "the goal response arrives before the interrupted terminal"}`, async () => {
    const { hub, sessionId, threadId, objective, turnCommand } = await startGoalRun(
      terminalBeforeResponse ? "goal-resume-terminal-first" : "goal-resume-response-first"
    );
    const { resume, resumeCommand } = await requestGoalResume({
      hub, sessionId, threadId, objective, turnCommand
    });
    assert.equal(resumeCommand.type, "set_goal");
    if (terminalBeforeResponse) {
      hub.applySessionEvent(
        sessionId,
        turnCompleted(threadId, "initial-goal-turn", { status: "interrupted" })
      );
      hub.resolveSessionCommand(sessionId, resumeCommand.commandId, {});
      await resume;
    } else {
      hub.resolveSessionCommand(sessionId, resumeCommand.commandId, {});
      await resume;
      hub.applySessionEvent(
        sessionId,
        turnCompleted(threadId, "initial-goal-turn", { status: "interrupted" })
      );
    }

    const resumedTurn = await nextCommand(hub, sessionId, resumeCommand.seq);
    assert.equal(resumedTurn.type, "turn");
    assert.equal(resumedTurn.input, objective);
    assert.equal(resumedTurn.options?.goalMode, true);
    assert.equal(resumedTurn.options?.goalObjective, objective);
    assert.deepEqual((await hub.waitSessionCommands(sessionId, resumedTurn.seq, 20)).commands, []);
    if (!terminalBeforeResponse) assert.equal(goalStatuses(hub, threadId).includes("paused"), false);

    hub.failSessionCommand(sessionId, resumedTurn.commandId, "test cleanup");
    await Promise.resolve();
  });
}

test("Goal clear rollback after terminal does not restore an idle resume marker", async () => {
  const fixture = await startGoalRun("goal-clear-rollback");
  const { hub, sessionId, threadId } = fixture;
  const { resume, resumeCommand } = await requestGoalResume(fixture);
  hub.resolveSessionCommand(sessionId, resumeCommand.commandId, {});
  await resume;

  const clear = hub.clearGoal(threadId);
  const clearCommand = await nextCommand(hub, sessionId, resumeCommand.seq);
  hub.applySessionEvent(
    sessionId,
    turnCompleted(threadId, "initial-goal-turn", { status: "interrupted" })
  );
  hub.failSessionCommand(sessionId, clearCommand.commandId, "clear rejected");
  await assert.rejects(clear, /clear rejected/);

  const ordinary = hub.runTurn(threadId, "ordinary follow-up", "task");
  const ordinaryCommand = await nextCommand(hub, sessionId, clearCommand.seq);
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "ordinary-turn"));
  hub.applySessionEvent(sessionId, turnCompleted(threadId, "ordinary-turn"));
  await ordinary;
  assert.deepEqual((await hub.waitSessionCommands(sessionId, ordinaryCommand.seq, 30)).commands, []);
});

test("control RPC failures reject locally without fabricating transcript errors", async () => {
  const { hub, sessionId, threadId } = createHub("control-errors");

  const compact = hub.compactThread(threadId);
  const compactCommand = await nextCommand(hub, sessionId);
  assert.equal(compactCommand.type, "compact_thread");
  hub.failSessionCommand(sessionId, compactCommand.commandId, "compact unavailable");
  await assert.rejects(compact, /compact unavailable/);
  assert.deepEqual(errorPayloads(hub, threadId), []);

  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "active-turn"));
  const stop = hub.stopTurn(threadId);
  const stopCommand = await nextCommand(hub, sessionId, compactCommand.seq);
  assert.equal(stopCommand.type, "stop");
  hub.failSessionCommand(sessionId, stopCommand.commandId, "interrupt rejected");
  await assert.rejects(stop, /interrupt rejected/);
  assert.equal(hub.getThread(threadId)?.running, true);
  assert.deepEqual(errorPayloads(hub, threadId), []);

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "active-turn", { status: "interrupted" }));
  const review = hub.reviewThread(threadId);
  const reviewCommand = await nextCommand(hub, sessionId, stopCommand.seq);
  assert.equal(reviewCommand.type, "review_thread");
  hub.failSessionCommand(sessionId, reviewCommand.commandId, "review unavailable");
  await assert.rejects(review, /review unavailable/);
  assert.equal(hub.getThread(threadId)?.running, false);
  assert.deepEqual(errorPayloads(hub, threadId), []);
});

test("turn and steer delivery failures are conversation-local submission records", async () => {
  const { hub, sessionId, threadId } = createHub("submission-errors");

  const turn = hub.runTurn(threadId, "send me");
  const turnCommand = await nextCommand(hub, sessionId);
  assert.equal(turnCommand.type, "turn");
  hub.failSessionCommand(sessionId, turnCommand.commandId, "turn/start rejected");
  await assert.rejects(turn, /turn\/start rejected/);
  assert.equal(hub.getThread(threadId)?.running, false);
  assert.deepEqual(errorPayloads(hub, threadId), [{
    type: "submission_failed",
    source: "codexhub",
    message: "turn/start rejected",
    input_text: "send me",
    image_count: 0
  }]);

  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "steer-active-turn"));
  const steer = hub.runTurn(threadId, "steer me", "web");
  const steerCommand = await nextCommand(hub, sessionId, turnCommand.seq);
  assert.equal(steerCommand.type, "steer");
  hub.failSessionCommand(sessionId, steerCommand.commandId, "turn/steer rejected");
  await assert.rejects(steer, /turn\/steer rejected/);
  assert.equal(hub.getThread(threadId)?.running, true);
  assert.equal(errorPayloads(hub, threadId).at(-1)?.type, "submission_failed");
  assert.equal(errorPayloads(hub, threadId).at(-1)?.input_text, "steer me");
});

test("running Web input remains guidance for the same Turn and clock", async () => {
  const { hub, sessionId, threadId } = createHub("steer-running-state");
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "active-turn"));
  const before = hub.getThread(threadId);
  assert.ok(before?.activeTurnStartedAt);

  const first = hub.runTurnWithDelivery(threadId, "first guidance", "web");
  assert.equal(first.delivery, "steer");
  const firstCommand = await nextCommand(hub, sessionId);
  assert.equal(firstCommand.type, "steer");
  assert.equal(firstCommand.turnId, "active-turn");
  assert.equal(hub.getThread(threadId)?.activeTurnStartedAt, before.activeTurnStartedAt);
  assert.equal(hub.getThread(threadId)?.updatedAt, before.updatedAt);
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    commandId: firstCommand.commandId,
    message: { id: firstCommand.commandId, result: { turnId: "active-turn" } }
  });
  await first.completion;

  hub.applySessionEvent(sessionId, executionChanged(threadId, true));
  assert.equal(hub.getThread(threadId)?.activeTurnStartedAt, before.activeTurnStartedAt);

  const second = hub.runTurnWithDelivery(threadId, "second guidance", "web");
  assert.equal(second.delivery, "steer");
  const secondCommand = await nextCommand(hub, sessionId, firstCommand.seq);
  assert.equal(secondCommand.type, "steer");
  assert.equal(secondCommand.turnId, "active-turn");
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    commandId: secondCommand.commandId,
    message: { id: secondCommand.commandId, result: { turnId: "active-turn" } }
  });
  await second.completion;
});

test("an interrupted accepted Turn rejects its caller without fabricating a transcript error", async () => {
  const { hub, sessionId, threadId } = createHub("interrupted-outcome");
  const turn = hub.runTurn(threadId, "long-running task", "task");
  await nextCommand(hub, sessionId);
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "interrupted-turn"));
  hub.applySessionEvent(sessionId, turnCompleted(threadId, "interrupted-turn", { status: "interrupted" }));

  await assert.rejects(turn, /Turn interrupted/);
  assert.equal(hub.getThread(threadId)?.running, false);
  assert.deepEqual(errorPayloads(hub, threadId), []);
});

test("app-server error notifications remain transcript records but never finish the Turn", () => {
  const { hub, sessionId, threadId } = createHub("app-error");
  const turnId = "app-error-turn";
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, turnId));
  const notifyError = (willRetry: boolean) => hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "error",
      params: {
        threadId,
        turnId,
        willRetry,
        error: {
          message: willRetry ? "temporary overload" : "retry exhausted",
          additionalDetails: "upstream"
        }
      }
    }
  });

  notifyError(true);
  assert.equal(hub.getThread(threadId)?.running, true);
  notifyError(false);
  assert.equal(hub.getThread(threadId)?.running, true);
  assert.equal(errorPayloads(hub, threadId).length, 1);
  assert.deepEqual(errorPayloads(hub, threadId)[0], {
    type: "app_server_error",
    turn_id: turnId,
    will_retry: false,
    status: "failed",
    error: { message: "retry exhausted", additionalDetails: "upstream" },
    message: "retry exhausted",
    additional_details: "upstream"
  });

  hub.applySessionEvent(sessionId, turnCompleted(threadId, turnId, {
    status: "failed",
    errorMessage: "quota exhausted"
  }));
  const records = hub.getThread(threadId)?.records ?? [];
  assert.equal(hub.getThread(threadId)?.running, false);
  assert.equal(errorPayloads(hub, threadId).length, 1);
  assert.equal(records.some((record) =>
    (record.payload as Record<string, unknown>).type === "task_complete"
  ), false);
  assert.deepEqual(
    records.find((record) =>
      (record.payload as Record<string, unknown>).type === "turn_aborted"
    )?.payload,
    {
      type: "turn_aborted",
      turn_id: turnId,
      status: "failed",
      reason: "quota exhausted",
      error: { message: "quota exhausted" },
      duration_ms: 1000
    }
  );
});

test("terminal snapshots finish the matching active Turn after reconnect", async () => {
  const { hub, sessionId, threadId } = createHub("snapshot-terminal");
  const running = hub.runTurn(threadId, "resume safely", "task");
  const command = await nextCommand(hub, sessionId);
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "snapshot-turn"));
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [appServerTurn("snapshot-turn")]));
  await running;
  assert.equal(hub.getThread(threadId)?.running, false);
  assert.equal(command.type, "turn");
});

test("terminal snapshots also finish externally active Turns whose id was not observed", () => {
  const { hub, sessionId, threadId } = createHub("snapshot-external-terminal");
  hub.applySessionEvent(sessionId, executionChanged(threadId, true));
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [
    appServerTurn("external-terminal-turn", { status: "interrupted" })
  ]));
  assert.equal(hub.getThread(threadId)?.running, false);
  assert.equal((hub.getThread(threadId)?.records ?? []).some((record) =>
    (record.payload as Record<string, unknown>).type === "turn_aborted"
  ), true);
});

test("an in-progress snapshot never clears an externally active Turn", () => {
  const { hub, sessionId, threadId } = createHub("snapshot-external-active");
  hub.applySessionEvent(sessionId, executionChanged(threadId, true));
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [
    appServerTurn("external-active-turn", { status: "inProgress" })
  ]));
  assert.equal(hub.getThread(threadId)?.running, true);
});

test("late completion and idle signals cannot finish the next queued Turn", async () => {
  const { hub, sessionId, threadId } = createHub("queued-race");
  const first = hub.runTurn(threadId, "first", "task");
  const firstCommand = await nextCommand(hub, sessionId);
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "first-turn"));
  const queued = hub.runTurn(threadId, "second", "task");

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "first-turn"));
  await first;
  const secondCommand = await nextCommand(hub, sessionId, firstCommand.seq);
  assert.equal(secondCommand.type, "turn");
  assert.equal((secondCommand as SessionCommand).input, "second");

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "first-turn"));
  hub.applySessionEvent(sessionId, executionChanged(threadId, false));
  assert.equal(hub.getThread(threadId)?.running, true);

  hub.failSessionCommand(sessionId, secondCommand.commandId, "cleanup");
  await assert.rejects(queued, /cleanup/);
});

test("accepted queued messages become submission failures if the runtime disconnects", async () => {
  const { hub, sessionId, threadId } = createHub("queued-disconnect");
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "external-active-turn"));
  const queued = hub.runTurn(threadId, "queued while busy", "task");
  hub.disconnectSession(sessionId);
  await assert.rejects(queued, /transport disconnected/);
  const failures = errorPayloads(hub, threadId).filter((payload) => payload.type === "submission_failed");
  assert.deepEqual(failures, [{
    type: "submission_failed",
    source: "codexhub",
    message: `Session transport disconnected: ${sessionId}`,
    input_text: "queued while busy",
    image_count: 0
  }]);
});

test("disconnect classifies provisional and accepted Turns by whether app-server acknowledged them", async () => {
  const provisional = createHub("disconnect-provisional");
  const provisionalTurn = provisional.hub.runTurn(provisional.threadId, "not acknowledged");
  await nextCommand(provisional.hub, provisional.sessionId);
  provisional.hub.disconnectSession(provisional.sessionId);
  await assert.rejects(provisionalTurn, /transport disconnected/);
  assert.deepEqual(errorPayloads(provisional.hub, provisional.threadId).map((payload) => payload.type), [
    "submission_failed"
  ]);

  const accepted = createHub("disconnect-accepted");
  const acceptedTurn = accepted.hub.runTurn(accepted.threadId, "already running");
  await nextCommand(accepted.hub, accepted.sessionId);
  accepted.hub.applySessionEvent(
    accepted.sessionId,
    executionChanged(accepted.threadId, true, "accepted-turn")
  );
  accepted.hub.disconnectSession(accepted.sessionId);
  await assert.rejects(acceptedTurn, /transport disconnected/);
  assert.deepEqual(errorPayloads(accepted.hub, accepted.threadId).map((payload) => payload.type), [
    "turn_transport_failed"
  ]);
});

test("disconnect preserves a failed steer submission before ending its active Turn", async () => {
  const { hub, sessionId, threadId } = createHub("disconnect-steer");
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "steer-active-turn"));
  const steer = hub.runTurn(threadId, "steer before disconnect", "web");
  await nextCommand(hub, sessionId);
  hub.disconnectSession(sessionId);
  await assert.rejects(steer, /transport disconnected/);
  assert.deepEqual(errorPayloads(hub, threadId).map((payload) => payload.type), [
    "submission_failed",
    "turn_transport_failed"
  ]);
});
