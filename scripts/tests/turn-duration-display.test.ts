import assert from "node:assert/strict";
import test from "node:test";
import type { CodexRecord, CodexRecordView } from "../../src/shared/recordTypes.js";
import {
  finalAnswerViewsWithTurnDurations,
  turnDurationMapFromRecords
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

test("turn duration falls back to backend lifecycle timestamps", () => {
  const turnDurations = turnDurationMapFromRecords([
    lifecycleRecord("task_started", "2026-07-19T02:00:00.000Z"),
    lifecycleRecord("task_complete", "2026-07-19T02:02:12.000Z")
  ]);

  assert.equal(turnDurations.get("turn-test"), 132_000);
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
