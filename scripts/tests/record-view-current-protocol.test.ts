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
