import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import {
  appServerGoalUpdate,
  goalUpdateFromInput,
  normalizeThreadGoalRunPolicy,
  threadGoalTimestamp
} from "../../src/core/threadGoalPolicy.js";
import { localCommandMessage, parseLocalSlashCommand } from "../../src/core/threadLocalCommands.js";
import type { ThreadState } from "../../src/core/threadHubState.js";

const thread = (): ThreadState => ({
  threadId: "thread-1",
  workingDirectory: "/tmp/project",
  threadOptions: {},
  running: false,
  title: "Test",
  updatedAt: "2026-01-01T00:00:00.000Z",
  records: [],
  recordSeq: 0,
  threadUsage: emptyThreadUsage(),
  events: [],
  subscribers: new Set(),
  seq: 0
});

test("local command parser and fast mode policy stay outside ThreadHub state orchestration", () => {
  assert.deepEqual(parseLocalSlashCommand(" /FAST on "), { command: "fast", args: ["on"] });
  assert.equal(parseLocalSlashCommand([{ type: "text", text: "/status" }]), null);

  const state = thread();
  const enabled = localCommandMessage(
    state,
    { online: true, runnable: true, sessionId: "session-1" },
    null,
    "fast",
    ["on"]
  );
  assert.match(enabled, /Fast mode enabled/);
  assert.equal(state.threadOptions.serviceTier, "priority");
  localCommandMessage(state, { online: true, runnable: true }, null, "fast", ["off"]);
  assert.equal(state.threadOptions.serviceTier, undefined);
});

test("goal policy normalization strips local run policy from app-server payload", () => {
  assert.deepEqual(goalUpdateFromInput("finish refactor", { goalMode: true, goalTokenBudget: 1000 }), {
    objective: "finish refactor",
    status: "active",
    tokenBudget: 1000
  });
  assert.deepEqual(normalizeThreadGoalRunPolicy({
    type: "consumeUntilWeeklyRemainingAtOrBelow",
    targetRemainingPercent: 20
  }), {
    type: "consumeUntilWeeklyRemainingAtOrBelow",
    targetRemainingPercent: 20
  });
  assert.equal(normalizeThreadGoalRunPolicy({
    type: "consumeUntilWeeklyRemainingAtOrBelow",
    targetRemainingPercent: 100
  }), null);
  assert.deepEqual(appServerGoalUpdate({
    objective: "finish",
    status: "active",
    runPolicy: { type: "consumeUntilWeeklyRemainingAtOrBelow", targetRemainingPercent: 20 }
  }), { objective: "finish", status: "active" });
  assert.equal(
    threadGoalTimestamp({ timestamp: 1_700_000_000_000 }, null),
    "2023-11-14T22:13:20.000Z"
  );
});
