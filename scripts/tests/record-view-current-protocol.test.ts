import assert from "node:assert/strict";
import test from "node:test";
import { recordToView } from "../../src/core/codexRecordView.js";
import { compactToolViews } from "../../src/shared/compactRecordViews.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import { recordsToDetailedViews } from "../../src/web/detailedRecordViews.js";

const compactionRecord = (id: string, type: string): CodexRecord => ({
  id,
  type: "event_msg",
  payload: { type, status: "completed" }
});

test("record views only special-case the normalized context_compaction event", () => {
  const current = compactionRecord("current", "context_compaction");
  const oldAliases = [
    compactionRecord("old-context-compacted", "context_compacted"),
    compactionRecord("old-compacted", "compacted")
  ];

  assert.equal(recordToView(current)?.label, "context_compaction");
  assert.equal(recordsToDetailedViews([current])[0]?.label, "context_compaction");

  for (const record of oldAliases) {
    const type = (record.payload as { type: string }).type;
    assert.equal(recordToView(record)?.label, type);
    assert.equal(recordsToDetailedViews([record])[0]?.label, type);
  }
});

test("compact views only coalesce normalized context_compaction events", () => {
  const currentViews = [
    recordToView(compactionRecord("current-1", "context_compaction")),
    recordToView(compactionRecord("current-2", "context_compaction"))
  ].filter((view) => view !== null);
  assert.equal(compactToolViews(currentViews).length, 1);

  const mixedViews = [
    recordToView(compactionRecord("current", "context_compaction")),
    recordToView(compactionRecord("old", "compacted"))
  ].filter((view) => view !== null);
  assert.equal(compactToolViews(mixedViews).length, 2);
});

test("Plan mode output renders as the final Codex answer in both message modes", async () => {
  const plan: CodexRecord = {
    id: "app:thread-1:turn-1:item:plan:plan-1",
    timestamp: "2026-07-24T07:23:18.397Z",
    type: "event_msg",
    payload: {
      type: "plan",
      message: "# Implementation plan\n\n- Fix the projection.",
      status: "completed"
    },
    sourceThreadId: "thread-1"
  };
  const expected = {
    role: "codex",
    label: "final_answer",
    text: "# Implementation plan\n\n- Fix the projection.",
    status: "completed",
    canFork: true
  };

  assert.deepEqual(recordToView(plan), {
    id: plan.id,
    at: plan.timestamp,
    statusText: "completed",
    record: plan,
    ...expected
  });
  assert.deepEqual(recordsToDetailedViews([plan])[0], {
    id: plan.id,
    at: plan.timestamp,
    statusText: "completed",
    record: plan,
    ...expected
  });

  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { isSimpleRecord } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  assert.equal(isSimpleRecord(plan), true);
});

test("interrupted turns render as a neutral terminal state rather than a failure", () => {
  const records: CodexRecord[] = [{
    id: "turn-start",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1" }
  }, {
    id: "turn-interrupted",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1", status: "interrupted" }
  }];
  const views = records.map(recordToView).filter((view) => view !== null);
  const [turn] = compactToolViews(views);

  assert.equal(turn?.text, "Turn interrupted");
  assert.equal(turn?.status, undefined);
});

test("interrupted turns use a neutral Web activity status", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { activityStatusFromRecord } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  assert.deepEqual(activityStatusFromRecord({
    id: "turn-interrupted",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1", status: "interrupted" }
  }), {
    key: "turn",
    label: "Interrupted",
    status: undefined,
    at: undefined,
    text: "Turn interrupted"
  });
});

test("guidance messages stay inside the existing Turn activity scope", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { latestTurnActivityScope } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  const records: CodexRecord[] = [{
    id: "turn-started",
    timestamp: "2026-07-19T02:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1" }
  }, {
    id: "initial-input",
    timestamp: "2026-07-19T02:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", turn_id: "turn-1", content: [] }
  }, {
    id: "activity-before-guidance",
    timestamp: "2026-07-19T02:00:02.000Z",
    type: "event_msg",
    payload: { type: "agent_message", turn_id: "turn-1", message: "working" }
  }, {
    id: "guidance-input",
    timestamp: "2026-07-19T02:00:03.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", turn_id: "turn-1", content: [] }
  }];

  const scope = latestTurnActivityScope(records);
  assert.equal(scope.key, "turn:turn-1");
  assert.equal(scope.startedAt, "2026-07-19T02:00:00.000Z");
  assert.equal(scope.userRecordId, "initial-input");
  assert.equal(scope.records.some((record) => record.id === "activity-before-guidance"), true);
});

test("web goal extraction only consumes current camelCase ThreadGoal fields", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { latestThreadGoalFromRecords } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  assert.deepEqual(latestThreadGoalFromRecords([{
    id: "current-goal",
    type: "event_msg",
    payload: {
      type: "thread_goal_updated",
      threadId: "thread-1",
      goal: {
        threadId: "thread-1",
        objective: "finish",
        status: "active",
        tokenBudget: 1000,
        updatedAt: 3
      }
    }
  }], "thread-1"), {
    objective: "finish",
    status: "active",
    tokenBudget: 1000,
    updatedAt: "1970-01-01T00:00:03.000Z"
  });

  assert.deepEqual(latestThreadGoalFromRecords([{
    id: "old-goal-fields",
    type: "event_msg",
    payload: {
      type: "thread_goal_updated",
      goal: {
        objective: "finish",
        status: "active",
        token_budget: 1000,
        updated_at: 3
      }
    }
  }]), {
    objective: "finish",
    status: "active",
    tokenBudget: undefined,
    updatedAt: undefined
  });
});
