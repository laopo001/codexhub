import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHub } from "../src/core/threadHub.js";
import type { SessionCommand, ThreadStreamEvent } from "../src/shared/threadTypes.js";
import {
  appServerTurn,
  executionChanged,
  turnCompleted,
  turnSnapshot
} from "./support/appServerEvents.js";

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

const contextCompactionEvent = (
  threadId: string,
  turnId: string,
  method: "item/started" | "item/completed",
  status?: "inProgress" | "completed"
) => ({
  type: "thread_event" as const,
  threadId,
  message: {
    method,
    params: {
      threadId,
      turnId,
      item: {
        id: `context-compaction-${turnId}`,
        type: "contextCompaction",
        ...(status ? { status } : {})
      }
    }
  }
});

test("new Turn is Waiting until app-server confirms its turnId", async () => {
  const { hub, sessionId, threadId } = createHub("waiting-turn");
  const running = hub.runTurn(threadId, "wait for app-server");
  const command = await nextCommand(hub, sessionId);

  assert.equal(hub.getThread(threadId)?.running, true);
  assert.equal(hub.getThread(threadId)?.status, "waiting");
  assert.equal(hub.getThread(threadId)?.activeTurnId, undefined);

  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "confirmed-turn"));
  assert.equal(hub.getThread(threadId)?.status, "running");
  assert.equal(hub.getThread(threadId)?.activeTurnId, "confirmed-turn");

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "turn/started",
      params: {
        threadId,
        turn: appServerTurn("confirmed-turn", {
          status: "inProgress",
          startedAt: 1_700_000_000
        })
      }
    }
  });
  const startedRecord = hub.getThread(threadId)?.records.find((record) =>
    (record.payload as Record<string, unknown>).type === "task_started"
  );
  assert.equal(startedRecord?.timestamp, "2023-11-14T22:13:20.000Z");
  assert.equal(hub.getThread(threadId)?.activeTurnStartedAt, "2023-11-14T22:13:20.000Z");

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "confirmed-turn"));
  await running;
  assert.equal(command.type, "turn");
  assert.equal(hub.getThread(threadId)?.status, "idle");
  assert.equal(hub.getThread(threadId)?.activeTurnStartedAt, undefined);
});

test("Submission ids stay provisional and cannot overwrite the authoritative Turn id", async () => {
  const { hub, sessionId, threadId } = createHub("provisional-submission");
  const running = hub.runTurn(threadId, "keep the real turn id");
  await nextCommand(hub, sessionId);

  hub.applySessionEvent(
    sessionId,
    executionChanged(threadId, true, "submission-before-start", { provisional: true })
  );
  assert.equal(hub.getThread(threadId)?.status, "waiting");
  assert.equal(hub.getThread(threadId)?.activeTurnId, undefined);

  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "real-turn"));
  assert.equal(hub.getThread(threadId)?.status, "running");
  assert.equal(hub.getThread(threadId)?.activeTurnId, "real-turn");

  hub.applySessionEvent(
    sessionId,
    executionChanged(threadId, true, "late-submission-response", { provisional: true })
  );
  assert.equal(hub.getThread(threadId)?.activeTurnId, "real-turn");

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "real-turn"));
  await running;
  assert.equal(hub.getThread(threadId)?.status, "idle");
  assert.equal(hub.getThread(threadId)?.activeTurnId, undefined);

  hub.applySessionEvent(
    sessionId,
    executionChanged(threadId, true, "submission-after-completion", { provisional: true })
  );
  assert.equal(hub.getThread(threadId)?.status, "idle");
  assert.equal(hub.getThread(threadId)?.running, false);
  assert.equal(hub.getThread(threadId)?.activeTurnId, undefined);
});

test("reconnected active Turn keeps the app-server lifecycle timestamp as its clock source", () => {
  const { hub, sessionId, threadId } = createHub("recovered-turn-clock");
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "recovered-current-turn"));
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [
    appServerTurn("recovered-current-turn", {
      status: "inProgress",
      startedAt: 1_700_000_020
    })
  ]));

  const recovered = hub.getThread(threadId);
  const startedRecord = recovered?.records.find((record) =>
    (record.payload as Record<string, unknown>).type === "task_started"
  );
  assert.equal(recovered?.status, "running");
  assert.equal(recovered?.activeTurnId, "recovered-current-turn");
  assert.equal(startedRecord?.timestamp, "2023-11-14T22:13:40.000Z");
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

test("inactive steer rejection resumes the same input as the next Turn", async () => {
  for (const completionFirst of [false, true]) {
    const suffix = completionFirst ? "inactive-steer-completed" : "inactive-steer-running";
    const { hub, sessionId, threadId } = createHub(suffix);
    const oldTurnId = `${suffix}-old-turn`;
    hub.applySessionEvent(sessionId, executionChanged(threadId, true, oldTurnId));

    const dispatch = hub.runTurnWithDelivery(threadId, "run me next", "web", { model: "queued-model" });
    assert.equal(dispatch.delivery, "steer");
    const steerCommand = await nextCommand(hub, sessionId);
    assert.equal(steerCommand.type, "steer");

    if (completionFirst) hub.applySessionEvent(sessionId, turnCompleted(threadId, oldTurnId));
    hub.failSessionCommand(sessionId, steerCommand.commandId, "no active turn to steer");
    if (!completionFirst) {
      assert.deepEqual(hub.queuedTurnItems(threadId).map((item) => ({
        submissionId: item.submissionId,
        text: item.text,
        position: item.position
      })), [{
        submissionId: dispatch.submissionId,
        text: "run me next",
        position: 1
      }]);
    }
    if (!completionFirst) hub.applySessionEvent(sessionId, turnCompleted(threadId, oldTurnId));

    const turnCommand = await nextCommand(hub, sessionId, steerCommand.seq);
    assert.equal(turnCommand.type, "turn");
    assert.equal(turnCommand.input, "run me next");
    assert.equal(turnCommand.options?.model, "queued-model");
    assert.deepEqual(errorPayloads(hub, threadId), []);

    const nextTurnId = `${suffix}-next-turn`;
    hub.applySessionEvent(sessionId, executionChanged(threadId, true, nextTurnId));
    hub.applySessionEvent(sessionId, turnCompleted(threadId, nextTurnId));
    await dispatch.completion;
  }
});

test("known context compaction queues messages and dispatches them once in FIFO order", async () => {
  const { hub, sessionId, threadId } = createHub("known-compaction");
  const compactingTurnId = "known-compaction-turn";
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, compactingTurnId));
  hub.applySessionEvent(sessionId, contextCompactionEvent(threadId, compactingTurnId, "item/started"));

  const first = hub.runTurnWithDelivery(
    threadId,
    "first after compaction",
    "web",
    { model: "first-model" },
    "compaction-submission-1"
  );
  const second = hub.runTurnWithDelivery(
    threadId,
    "second after compaction",
    "web",
    { model: "second-model" },
    "compaction-submission-2"
  );
  assert.equal(first.delivery, "queued");
  assert.equal(second.delivery, "queued");
  assert.deepEqual(hub.queuedTurnItems(threadId).map((item) => item.submissionId), [
    "compaction-submission-1",
    "compaction-submission-2"
  ]);

  hub.applySessionEvent(sessionId, contextCompactionEvent(threadId, compactingTurnId, "item/completed", "completed"));
  assert.equal(hub.getThread(threadId)?.running, true);
  assert.equal(hub.getThread(threadId)?.activeTurnId, compactingTurnId);

  const sameTurn = hub.runTurnWithDelivery(threadId, "still in the same turn", "web");
  assert.equal(sameTurn.delivery, "steer");
  const sameTurnCommand = await nextCommand(hub, sessionId);
  assert.equal(sameTurnCommand.type, "steer");
  assert.equal(sameTurnCommand.turnId, compactingTurnId);
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    commandId: sameTurnCommand.commandId,
    message: { id: sameTurnCommand.commandId, result: { turnId: compactingTurnId } }
  });
  await sameTurn.completion;

  hub.applySessionEvent(sessionId, turnCompleted(threadId, compactingTurnId));
  const firstCommand = await nextCommand(hub, sessionId, sameTurnCommand.seq);
  assert.equal(firstCommand.type, "turn");
  assert.equal(firstCommand.input, "first after compaction");
  assert.equal(firstCommand.submissionId, "compaction-submission-1");
  assert.equal(firstCommand.options?.model, "first-model");

  // A duplicate terminal/idle signal for the old Turn cannot dispatch the
  // queued successor a second time.
  hub.applySessionEvent(sessionId, turnCompleted(threadId, compactingTurnId));
  hub.applySessionEvent(sessionId, executionChanged(threadId, false));
  assert.equal(hub.getThread(threadId)?.activeTurnId, undefined);

  const firstTurnId = "known-compaction-next-1";
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, firstTurnId));
  hub.applySessionEvent(sessionId, turnCompleted(threadId, firstTurnId));
  const secondCommand = await nextCommand(hub, sessionId, firstCommand.seq);
  assert.equal(secondCommand.type, "turn");
  assert.equal(secondCommand.input, "second after compaction");
  assert.equal(secondCommand.submissionId, "compaction-submission-2");
  assert.equal(secondCommand.options?.model, "second-model");

  const secondTurnId = "known-compaction-next-2";
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, secondTurnId));
  hub.applySessionEvent(sessionId, turnCompleted(threadId, secondTurnId));
  await Promise.all([first.completion, second.completion]);
  assert.equal(hub.getThread(threadId)?.running, false);
  assert.equal(hub.getThread(threadId)?.activeTurnId, undefined);
  assert.deepEqual(hub.queuedTurnItems(threadId), []);
  assert.deepEqual(errorPayloads(hub, threadId), []);
});

test("cannot steer a compact Turn falls back to a queued delivery acknowledgement", async () => {
  const { hub, sessionId, threadId } = createHub("compact-steer-race");
  const compactingTurnId = "compact-steer-race-turn";
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, compactingTurnId));

  const dispatch = hub.runTurnWithDelivery(
    threadId,
    "race-safe input",
    "web",
    { model: "race-model" },
    "race-submission"
  );
  assert.equal(dispatch.delivery, "steer");
  const steerCommand = await nextCommand(hub, sessionId);
  assert.equal(steerCommand.type, "steer");

  hub.applySessionEvent(sessionId, contextCompactionEvent(threadId, compactingTurnId, "item/started"));
  hub.failSessionCommand(sessionId, steerCommand.commandId, "cannot steer a compact turn");
  await dispatch.deliveryAcknowledgement;
  assert.equal(dispatch.delivery, "queued");
  assert.equal(hub.getThread(threadId)?.running, true);
  assert.equal(hub.getThread(threadId)?.activeTurnId, compactingTurnId);
  assert.deepEqual(hub.queuedTurnItems(threadId).map((item) => item.submissionId), ["race-submission"]);
  assert.deepEqual(errorPayloads(hub, threadId), []);

  hub.applySessionEvent(sessionId, turnCompleted(threadId, compactingTurnId));
  const turnCommand = await nextCommand(hub, sessionId, steerCommand.seq);
  assert.equal(turnCommand.type, "turn");
  assert.equal(turnCommand.input, "race-safe input");
  assert.equal(turnCommand.submissionId, "race-submission");
  assert.equal(turnCommand.options?.model, "race-model");

  const nextTurnId = "compact-steer-race-next";
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, nextTurnId));
  hub.applySessionEvent(sessionId, turnCompleted(threadId, nextTurnId));
  await dispatch.completion;
  assert.equal(hub.getThread(threadId)?.running, false);
  assert.equal(hub.getThread(threadId)?.activeTurnId, undefined);
  assert.deepEqual(errorPayloads(hub, threadId), []);
});

test("thread queue exposes stable FIFO identities and cancels only queued submissions", async () => {
  const { hub, sessionId, threadId } = createHub("cancel-queue");
  const streamEvents: ThreadStreamEvent[] = [];
  const unsubscribe = hub.subscribe(threadId, -1, (event) => streamEvents.push(event));
  hub.applySessionEvent(sessionId, executionChanged(threadId, true));
  const first = hub.runTurnWithDelivery(threadId, "first queued", "web", undefined, "submission-1");
  const second = hub.runTurnWithDelivery(threadId, "second queued", "web", undefined, "submission-2");
  assert.equal(first.delivery, "queued");
  assert.equal(second.delivery, "queued");
  assert.deepEqual(hub.queuedTurnItems(threadId).map((item) => ({
    submissionId: item.submissionId,
    text: item.text,
    position: item.position
  })), [
    { submissionId: "submission-1", text: "first queued", position: 1 },
    { submissionId: "submission-2", text: "second queued", position: 2 }
  ]);
  assert.deepEqual(streamEvents.at(-1)?.queue?.map((item) => ({
    submissionId: item.submissionId,
    position: item.position
  })), [
    { submissionId: "submission-1", position: 1 },
    { submissionId: "submission-2", position: 2 }
  ]);

  hub.cancelQueuedTurn(threadId, "submission-1");
  await assert.rejects(first.completion, /Queued submission cancelled: submission-1/);
  assert.deepEqual(hub.queuedTurnItems(threadId).map((item) => ({
    submissionId: item.submissionId,
    position: item.position
  })), [{ submissionId: "submission-2", position: 1 }]);
  assert.deepEqual(streamEvents.at(-1)?.queue?.map((item) => ({
    submissionId: item.submissionId,
    position: item.position
  })), [{ submissionId: "submission-2", position: 1 }]);
  assert.throws(
    () => hub.cancelQueuedTurn(threadId, "submission-1"),
    /not found or already dispatching/
  );

  hub.disconnectSession(sessionId);
  await assert.rejects(second.completion, /transport disconnected/);
  unsubscribe();
});

test("running Web input remains guidance for the same app-server Turn", async () => {
  const { hub, sessionId, threadId } = createHub("steer-running-state");
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, "active-turn"));
  const before = hub.getThread(threadId);
  assert.equal(before?.status, "running");
  assert.equal(before?.activeTurnId, "active-turn");

  const first = hub.runTurnWithDelivery(threadId, "first guidance", "web");
  assert.equal(first.delivery, "steer");
  const firstCommand = await nextCommand(hub, sessionId);
  assert.equal(firstCommand.type, "steer");
  assert.equal(firstCommand.turnId, "active-turn");
  assert.equal(hub.getThread(threadId)?.activeTurnId, before.activeTurnId);
  assert.equal(hub.getThread(threadId)?.updatedAt, before.updatedAt);
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    commandId: firstCommand.commandId,
    message: { id: firstCommand.commandId, result: { turnId: "active-turn" } }
  });
  await first.completion;

  hub.applySessionEvent(sessionId, executionChanged(threadId, true));
  assert.equal(hub.getThread(threadId)?.activeTurnId, before.activeTurnId);

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
  assert.equal(hub.getThread(threadId)?.status, "idle");
  assert.equal(hub.getThread(threadId)?.activeTurnId, undefined);
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

test("live completion finishes an unbound local Turn after a terminal snapshot without ending its queued successor", async () => {
  const { hub, sessionId, threadId } = createHub("snapshot-unbound-local");
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [
    appServerTurn("previous-turn")
  ]));

  const running = hub.runTurn(threadId, "finish from snapshot", "task");
  const firstCommand = await nextCommand(hub, sessionId);
  const queued = hub.runTurn(threadId, "keep running after duplicate completion", "task");
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [
    appServerTurn("previous-turn"),
    appServerTurn("snapshot-only-turn")
  ]));
  assert.equal(hub.getThread(threadId)?.running, true);

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "snapshot-only-turn"));
  await running;
  const secondCommand = await nextCommand(hub, sessionId, firstCommand.seq);
  assert.equal(hub.getThread(threadId)?.running, true);
  assert.equal(secondCommand.type, "turn");
  assert.equal(secondCommand.input, "keep running after duplicate completion");

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "snapshot-only-turn"));
  assert.equal(hub.getThread(threadId)?.running, true);

  hub.failSessionCommand(sessionId, secondCommand.commandId, "cleanup");
  await assert.rejects(queued, /cleanup/);
});

test("an unbound local Turn ignores older terminal records while a newer snapshot Turn is active", async () => {
  const { hub, sessionId, threadId } = createHub("snapshot-unbound-active");
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [
    appServerTurn("previous-turn")
  ]));

  const running = hub.runTurn(threadId, "wait for the active snapshot Turn", "task");
  await nextCommand(hub, sessionId);
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [
    appServerTurn("previous-turn"),
    appServerTurn("unseen-terminal-turn"),
    appServerTurn("current-turn", { status: "inProgress" })
  ]));
  assert.equal(hub.getThread(threadId)?.running, true);

  hub.applySessionEvent(sessionId, turnCompleted(threadId, "current-turn"));
  await running;
  assert.equal(hub.getThread(threadId)?.running, false);
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
