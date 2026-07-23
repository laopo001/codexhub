import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import {
  appServerGoalUpdate,
  appServerThreadGoalFromValue,
  formatThreadGoalMessage,
  goalUpdateFromInput,
  normalizeThreadGoalRunPolicy,
  threadGoalsEqual,
  threadGoalThreadId,
  threadGoalTimestamp
} from "../../src/core/threadGoalPolicy.js";
import { localCommandMessage, parseLocalSlashCommand } from "../../src/core/threadLocalCommands.js";
import { ThreadHub } from "../../src/core/threadHub.js";
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
    { online: true, runnable: true, machineId: "session-1" },
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
    threadGoalTimestamp({ updatedAt: 1_700_000_000 }),
    "2023-11-14T22:13:20.000Z"
  );
});

test("goal records only consume current camelCase ThreadGoal fields", () => {
  assert.deepEqual(appServerThreadGoalFromValue({
    threadId: "thread-current",
    thread_id: "thread-old",
    objective: "finish",
    status: "active",
    tokenBudget: 1000,
    token_budget: 2000,
    tokensUsed: 100,
    timeUsedSeconds: 30,
    createdAt: 1,
    created_at: 2,
    updatedAt: 3,
    updated_at: 4
  }), {
    threadId: "thread-current",
    objective: "finish",
    status: "active",
    tokenBudget: 1000,
    tokensUsed: 100,
    timeUsedSeconds: 30,
    createdAt: 1,
    updatedAt: 3
  });
  assert.equal(appServerThreadGoalFromValue({ status: "paused" }), null);
  assert.equal(formatThreadGoalMessage({ objective: "finish", status: "active", token_budget: 2000 }), "Goal active: finish");
  assert.equal(threadGoalThreadId({ thread_id: "thread-old" }, { thread_id: "thread-old" }), undefined);
  assert.equal(
    threadGoalTimestamp({ createdAt: 1, updatedAt: 3 }),
    "1970-01-01T00:00:03.000Z"
  );
  assert.equal(
    threadGoalTimestamp({ createdAt: 1, updatedAt: "2026-01-01T00:00:00.000Z" }),
    "1970-01-01T00:00:01.000Z"
  );
  assert.equal(threadGoalsEqual(
    { objective: "finish", status: "active", token_budget: 1000 },
    { objective: "finish", status: "active", token_budget: 2000 }
  ), true);
  assert.equal(threadGoalsEqual(
    { objective: "finish", status: "active", tokensUsed: 1, updatedAt: 2 },
    { objective: "finish", status: "active", tokensUsed: 2, updatedAt: 3 }
  ), false);
});

test("ThreadHub stores goal notifications with only current camelCase fields", () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId: "session-1", machineId: "machine-1", workingDirectory: "/tmp/project" });
  hub.applySessionEvent("session-1", {
    type: "thread_event",
    threadId: "thread-1",
    message: {
      method: "thread/goal/updated",
      params: {
        threadId: "thread-1",
        thread_id: "old-thread",
        timestamp: 1_700_000_000_000,
        createdAt: 100,
        updatedAt: 200,
        goal: {
          threadId: "thread-1",
          thread_id: "old-thread",
          objective: "finish",
          status: "active",
          tokenBudget: 1000,
          token_budget: 2000,
          tokensUsed: 100,
          timeUsedSeconds: 30,
          createdAt: 1,
          created_at: 2,
          updatedAt: 3,
          updated_at: 4
        }
      }
    }
  });

  const record = hub.getThread("thread-1")?.records.at(-1);
  const payload = record?.payload as Record<string, unknown>;
  assert.equal(record?.timestamp, "1970-01-01T00:00:03.000Z");
  assert.equal("thread_id" in payload, false);
  assert.deepEqual(payload.goal, {
    threadId: "thread-1",
    objective: "finish",
    status: "active",
    tokenBudget: 1000,
    tokensUsed: 100,
    timeUsedSeconds: 30,
    createdAt: 1,
    updatedAt: 3
  });

  hub.applySessionEvent("session-1", {
    type: "thread_event",
    threadId: "thread-1",
    message: {
      method: "thread/goal/cleared",
      params: { threadId: "thread-1", turnId: "removed-clear-turn" }
    }
  });
  const clearedPayload = hub.getThread("thread-1")?.records.at(-1)?.payload as Record<string, unknown>;
  assert.equal(clearedPayload.type, "thread_goal_cleared");
  assert.equal("turnId" in clearedPayload, false);
});

test("ThreadHub keeps one runtime per machine and rebinds threads to its latest process", async () => {
  const hub = new ThreadHub();
  hub.registerSession({
    sessionId: "runtime-process-a",
    machineId: "machine-stable",
    name: "stable machine",
    workingDirectory: "/tmp/project-a"
  });
  hub.attachSessionThread("runtime-process-a", "thread-stable", "/tmp/project-a");

  hub.registerSession({
    sessionId: "runtime-process-b",
    machineId: "machine-stable",
    name: "stable machine",
    workingDirectory: "/tmp/project-b"
  });

  assert.deepEqual(hub.listSessions().map((session) => session.sessionId), ["runtime-process-b"]);
  const runtimes = hub.listRuntimes();
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0]?.machineId, "machine-stable");
  assert.equal("sessionId" in (runtimes[0] ?? {}), false);
  const projectedThread = hub.getThread("thread-stable");
  assert.equal(projectedThread?.runtime.machineId, "machine-stable");
  assert.equal("sessionId" in (projectedThread?.runtime ?? {}), false);

  const candidatesPromise = hub.listMachineThreadCandidates("machine-stable", 10, "/tmp/project-a");
  const batch = await hub.waitSessionCommands("runtime-process-b", 0, 10);
  assert.equal(batch.commands.length, 1);
  assert.equal(batch.commands[0]?.type, "list_threads");
  assert.equal(batch.commands[0]?.workingDirectory, "/tmp/project-a");
  hub.resolveSessionCommand("runtime-process-b", batch.commands[0]!.commandId, { threads: [] });
  assert.deepEqual(await candidatesPromise, { threads: [] });
});

test("ThreadHub projects goal/get snapshots and ignores removed Thread.goal", () => {
  const hub = new ThreadHub();
  const sessionId = "goal-snapshot-session";
  const threadId = "goal-snapshot-thread";
  hub.registerSession({ sessionId, workingDirectory: "/tmp/project" });
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      result: {
        thread: {
          id: threadId,
          cwd: "/tmp/project",
          goal: {
            threadId,
            objective: "removed thread field",
            status: "active"
          }
        }
      }
    }
  });
  assert.equal(hub.getThread(threadId)?.records.length, 0);

  const events: Array<{ historical?: boolean; record?: { payload?: unknown } }> = [];
  const unsubscribe = hub.subscribe(threadId, hub.getThread(threadId)?.lastSeq ?? 0, (event) => events.push(event));
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    historical: true,
    message: {
      result: {
        goal: {
          threadId,
          objective: "goal/get snapshot",
          status: "active",
          tokenBudget: null,
          tokensUsed: 10,
          timeUsedSeconds: 20,
          createdAt: 1,
          updatedAt: 2
        }
      }
    }
  });
  assert.equal(events.at(-1)?.historical, true);
  assert.equal((events.at(-1)?.record?.payload as { type?: string })?.type, "thread_goal_updated");

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    historical: true,
    message: { result: { goal: null } }
  });
  assert.equal(events.at(-1)?.historical, true);
  assert.equal((events.at(-1)?.record?.payload as { type?: string })?.type, "thread_goal_cleared");
  unsubscribe();
});
