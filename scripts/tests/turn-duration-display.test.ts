import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { recordViewStatusDurationMs } from "../../src/core/codexRecordView.js";
import type { CodexRecord, CodexRecordView } from "../../src/shared/recordTypes.js";
import {
  formatThreadDuration,
  goalDurationMsFromProgress,
  latestGoalDurationAnchor,
  MessagesTurnLoadingFooter,
  LiveThreadRunningText,
  liveDurationMsFromAnchor,
  stableLiveDurationAnchor,
  threadExecutionTimeMode
} from "../../src/web/helpers/liveTime.js";
import {
  finalAnswerViewsWithTurnDurations,
  turnDurationMapFromRecords,
  turnDurationMsForTurn
} from "../../src/web/helpers/turnDurations.js";
import { threadExecutionMeta } from "../../src/web/helpers/threadExecution.js";

test("final answer displays the whole turn duration instead of its shorter item duration", () => {
  const turnDurations = turnDurationMapFromRecords([
    lifecycleRecord("task_started", "2026-07-19T02:00:00.000Z"),
    lifecycleRecord("task_complete", "2026-07-19T02:02:12.000Z", 132_000)
  ]);
  const [view] = finalAnswerViewsWithTurnDurations([finalAnswerView(1_000)], turnDurations);

  assert.equal(view.statusDurationMs, 132_000);
});

test("item messages keep item durations while final answer uses the Turn duration", () => {
  const tool = messageView("tool", "shell", "tool-call", 2_500);
  const commentary = messageView("codex", "commentary", "commentary", 3_000);
  const reasoning = messageView("thinking", "thinking", "reasoning", 4_000);
  const compaction = messageView("event", "context_compaction", "compaction", 5_000);
  const finalAnswer = finalAnswerView(1_000);
  const views = finalAnswerViewsWithTurnDurations(
    [tool, commentary, reasoning, compaction, finalAnswer],
    new Map([["turn-test", 132_000]])
  );

  assert.equal(views[0]?.statusDurationMs, 2_500);
  assert.equal(views[1]?.statusDurationMs, 3_000);
  assert.equal(views[2]?.statusDurationMs, 4_000);
  assert.equal(views[3]?.statusDurationMs, 5_000);
  assert.equal(views[4]?.statusDurationMs, 132_000);
});

test("final answer keeps its item duration when turn timing is unavailable", () => {
  const [view] = finalAnswerViewsWithTurnDurations([finalAnswerView(1_000)], new Map());

  assert.equal(view.statusDurationMs, 1_000);
});

test("completed duration never falls back to frontend timestamp subtraction", () => {
  const turnDurations = turnDurationMapFromRecords([
    lifecycleRecord("task_started", "2026-07-19T02:00:00.000Z"),
    lifecycleRecord("task_complete", "2026-07-19T02:02:12.000Z")
  ]);

  assert.equal(turnDurations.get("turn-test"), undefined);
  assert.equal(turnDurationMsForTurn([
    lifecycleRecord("task_started", "2026-07-19T02:00:00.000Z"),
    lifecycleRecord("task_complete", "2026-07-19T02:02:12.000Z")
  ], "turn-test"), undefined);
  assert.equal(recordViewStatusDurationMs({
    started_at: "2026-07-19T02:00:00.000Z",
    completed_at: "2026-07-19T02:02:12.000Z"
  }), undefined);
});

test("idle duration comes from the backend terminal record", () => {
  const durationMs = turnDurationMsForTurn([
    lifecycleRecord("task_started", "2026-07-19T02:00:00.000Z"),
    lifecycleRecord("task_complete", "2026-07-19T02:02:12.000Z", 132_000)
  ], "turn-test");

  assert.equal(durationMs, 132_000);
});

test("running duration uses a backend clock anchor and catches up after a background pause", () => {
  const durationMs = liveDurationMsFromAnchor({
    startedAt: "2026-07-19T02:00:00.000Z",
    observedAt: "2026-07-19T02:00:10.000Z",
    observedClientAtMs: 5_000_000,
    currentClientNowMs: 5_120_000
  });

  assert.equal(durationMs, 130_000);
});

test("running duration keeps its first observation anchor for the same Turn", () => {
  const first = stableLiveDurationAnchor(undefined, {
    startedAt: "2026-07-19T02:00:00.000Z",
    observedAt: "2026-07-19T02:00:10.000Z",
    observedClientAtMs: 5_000_000
  });
  const afterGuidance = stableLiveDurationAnchor(first, {
    startedAt: "2026-07-19T02:00:00.000Z",
    observedAt: "2026-07-19T02:00:30.000Z",
    observedClientAtMs: 5_020_000
  });
  const nextTurn = stableLiveDurationAnchor(afterGuidance, {
    startedAt: "2026-07-19T02:01:00.000Z",
    observedAt: "2026-07-19T02:01:01.000Z",
    observedClientAtMs: 5_060_000
  });

  assert.strictEqual(afterGuidance, first);
  assert.notStrictEqual(nextTurn, first);
});

test("running metadata falls back to the thread summary clock when the start record is not loaded", () => {
  const startedAt = "2026-07-19T02:00:00.000Z";
  const executionMeta = threadExecutionMeta(
    {
      status: "running",
      running: true,
      activeTurnStartedAt: startedAt
    } as Parameters<typeof threadExecutionMeta>[0],
    {
      key: "turn:turn-test",
      label: "turn status",
      records: [],
      turnId: "turn-test",
      turnStatus: null
    }
  );

  assert.equal(executionMeta.status, "running");
  assert.equal(executionMeta.startedAt, startedAt);
});

test("tab execution time prioritizes Waiting, then Goal total, then Turn", () => {
  const running = {
    status: "running",
    label: "Running",
    duration: "",
    text: "Running",
    startedAt: "2026-07-19T03:00:00.000Z"
  } as const;
  const goal = {
    objective: "Finish the project",
    status: "active",
    timeUsedSeconds: 30_957,
    updatedAt: "2026-07-19T03:00:00.000Z"
  } as const;

  assert.equal(threadExecutionTimeMode({ ...running, status: "waiting", label: "Waiting" }, goal), "waiting");
  assert.equal(threadExecutionTimeMode(running, goal), "goal");
  assert.equal(threadExecutionTimeMode(running, null), "turn");
  assert.equal(threadExecutionTimeMode(running, { ...goal, timeUsedSeconds: undefined }), "turn");
});

test("compact Running text keeps only the prioritized clock", () => {
  const executionMeta = {
    status: "running",
    label: "Running",
    duration: "",
    text: "Running",
    startedAt: new Date(Date.now() - 5_000).toISOString()
  } as const;
  const activeGoal = {
    objective: "Finish the project",
    status: "active",
    timeUsedSeconds: 120,
    updatedAt: new Date().toISOString()
  } as const;
  const compact = renderToStaticMarkup(createElement(LiveThreadRunningText, {
    executionMeta,
    activeGoal
  }));

  assert.doesNotMatch(compact, /Turn/);
  assert.match(compact, /Running/);
  assert.match(compact, /2m0s/);
});

test("middle execution display separates Waiting, Turn, and Goal clocks", () => {
  const running = {
    status: "running",
    label: "Running",
    duration: "",
    text: "Running",
    startedAt: new Date(Date.now() - 5_000).toISOString()
  } as const;
  const goal = {
    objective: "Finish the project",
    status: "active",
    timeUsedSeconds: 120,
    updatedAt: new Date().toISOString()
  } as const;
  const visibleText = (context: Parameters<typeof MessagesTurnLoadingFooter>[0]["context"]) =>
    renderToStaticMarkup(createElement(MessagesTurnLoadingFooter, { context }))
      .replace(/<[^>]+>/g, "");

  const waitingText = visibleText({
    executionMeta: { ...running, status: "waiting", label: "Waiting" },
    activeGoal: goal
  });
  const turnText = visibleText({ executionMeta: running, activeGoal: null });
  const goalText = visibleText({ executionMeta: running, activeGoal: goal });

  assert.equal(waitingText, "Waiting");
  assert.match(turnText, /^Turn· \d+s$/);
  assert.doesNotMatch(turnText, /Goal/);
  assert.match(goalText, /^Turn· \d+sGoal · 2m0s$/);
});

test("active Goal duration advances from the app-server accumulated time", () => {
  const durationMs = goalDurationMsFromProgress({
    status: "active",
    running: true,
    timeUsedSeconds: 30_957,
    liveElapsedMs: 3_000
  });

  assert.equal(durationMs, 30_960_000);
  assert.equal(formatThreadDuration(durationMs), "8h36m0s");
});

test("paused Goal duration freezes at the app-server accumulated time", () => {
  const durationMs = goalDurationMsFromProgress({
    status: "paused",
    running: true,
    timeUsedSeconds: 30_957,
    liveElapsedMs: 30_000
  });

  assert.equal(durationMs, 30_957_000);
  assert.equal(formatThreadDuration(durationMs), "8h35m57s");
});

test("idle active Goal duration freezes at the app-server accumulated time", () => {
  assert.equal(goalDurationMsFromProgress({
    status: "active",
    running: false,
    timeUsedSeconds: 30_957,
    liveElapsedMs: 30_000
  }), 30_957_000);
});

test("Goal live duration starts after an idle gap instead of the older Goal update", () => {
  assert.equal(latestGoalDurationAnchor(
    "2026-07-19T02:00:00.000Z",
    "2026-07-19T03:00:00.000Z"
  ), "2026-07-19T03:00:00.000Z");
  assert.equal(latestGoalDurationAnchor(
    "2026-07-19T04:00:00.000Z",
    "2026-07-19T03:00:00.000Z"
  ), "2026-07-19T04:00:00.000Z");
});

const lifecycleRecord = (
  type: "task_started" | "task_complete",
  timestamp: string,
  durationMs?: number
): CodexRecord => ({
  id: `app:thread-test:turn-test:event:${type}`,
  timestamp,
  type: "event_msg",
  payload: {
    type,
    turn_id: "turn-test",
    ...(durationMs == null ? {} : { duration_ms: durationMs })
  }
});

const finalAnswerView = (statusDurationMs: number): CodexRecordView => ({
  id: "app:thread-test:turn-test:agent:message",
  role: "codex",
  label: "final_answer",
  text: "Done",
  status: "completed",
  statusDurationMs,
  record: {
    id: "app:thread-test:turn-test:agent:message",
    timestamp: "2026-07-19T02:02:11.000Z",
    type: "event_msg",
    payload: {
      type: "agent_message",
      phase: "final_answer",
      status: "completed",
      duration_ms: statusDurationMs
    }
  }
});

const messageView = (
  role: CodexRecordView["role"],
  label: string,
  itemId: string,
  statusDurationMs: number
): CodexRecordView => ({
  id: `app:thread-test:turn-test:item:${itemId}`,
  role,
  label,
  text: label,
  status: "completed",
  statusDurationMs,
  record: {
    id: `app:thread-test:turn-test:item:${itemId}`,
    timestamp: "2026-07-19T02:01:00.000Z",
    type: role === "tool" ? "response_item" : "event_msg",
    payload: {
      type: role === "tool" ? "local_shell_call" : "agent_message",
      phase: role === "tool" ? undefined : label,
      status: "completed",
      duration_ms: statusDurationMs
    }
  }
});
