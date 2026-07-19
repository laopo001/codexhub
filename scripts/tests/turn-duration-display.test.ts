import assert from "node:assert/strict";
import test from "node:test";
import { recordViewStatusDurationMs } from "../../src/core/codexRecordView.js";
import type { CodexRecord, CodexRecordView } from "../../src/shared/recordTypes.js";
import { liveDurationMsFromAnchor } from "../../src/web/helpers/liveTime.js";
import {
  finalAnswerViewsWithTurnDurations,
  turnDurationMapFromRecords,
  turnDurationMsForTurn
} from "../../src/web/helpers/turnDurations.js";

test("final answer displays the whole turn duration instead of its shorter item duration", () => {
  const turnDurations = turnDurationMapFromRecords([
    lifecycleRecord("task_started", "2026-07-19T02:00:00.000Z"),
    lifecycleRecord("task_complete", "2026-07-19T02:02:12.000Z", 132_000)
  ]);
  const [view] = finalAnswerViewsWithTurnDurations([finalAnswerView(1_000)], turnDurations);

  assert.equal(view.statusDurationMs, 132_000);
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
