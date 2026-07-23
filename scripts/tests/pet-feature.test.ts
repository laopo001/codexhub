import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { OpenThreadState } from "../../src/web/types.js";
import {
  petAnimationRows,
  petAtlas,
  petAtlasBackgroundPosition,
  petAtlasForVersion,
  petLookCellForVector,
} from "../../src/web/pets/petAtlas.js";
import { parsePetCommand } from "../../src/web/pets/petCommands.js";
import { clampPetPosition, defaultPetPosition } from "../../src/web/pets/petMotion.js";
import {
  derivePetActivities,
  hasRunningPetThreads,
  headlinePetStatus,
  initialPetCompletionState,
  petAnimationForPresentation,
  petAnimationForStatus,
  petCompletionJumpDurationMs,
  petStatusForThread,
  transitionPetCompletionState,
} from "../../src/web/pets/petStatus.js";
import { nextAvailablePetManifest, parsePetManifest } from "../../src/web/pets/petStore.js";
import { builtinPet, builtinPets } from "../../src/web/pets/petStore.js";

const thread = (threadId: string, records: CodexRecord[] = [], running = false): OpenThreadState => ({
  threadId,
  workingDirectory: `/tmp/${threadId}`,
  runtime: { online: true, runnable: true, machineId: "session-1" },
  status: running ? "running" : "idle",
  running,
  title: threadId,
  updatedAt: `2026-01-01T00:00:0${threadId.slice(-1)}.000Z`,
  messageCount: records.length,
  threadUsage: emptyThreadUsage(),
  records,
  lastSeq: records.length,
  composerMode: "chat",
  modelDraft: "auto",
  reasoningDraft: "auto",
  serviceTierDraft: "auto",
  approvalPolicyDraft: "auto",
  approvalsReviewerDraft: "auto",
  permissionProfileDraft: null,
  imageAttachments: [],
  textAttachments: [],
});

test("pet atlas supports the Codex V1 and V2 sprite contracts", () => {
  assert.deepEqual(
    [petAtlas.width, petAtlas.height, petAtlas.columns, petAtlas.rows, petAtlas.cellWidth, petAtlas.cellHeight],
    [1536, 1872, 8, 9, 192, 208]
  );
  assert.equal(petAnimationRows.running.durationsMs.length, 6);
  assert.equal(petAnimationRows.failed.durationsMs.length, 8);
  assert.deepEqual(petAtlasBackgroundPosition("idle", 0), { x: "0%", y: "0%" });
  assert.deepEqual(petAtlasBackgroundPosition("review", 5), { x: `${(5 / 7) * 100}%`, y: "100%" });
  const v2 = petAtlasForVersion(2);
  assert.deepEqual([v2.width, v2.height, v2.columns, v2.rows], [1536, 2288, 8, 11]);
  assert.deepEqual(petAtlasBackgroundPosition("review", 5, 2), { x: `${(5 / 7) * 100}%`, y: "80%" });
  assert.deepEqual(petLookCellForVector(0, -100), { angle: 0, column: 0, row: 9 });
  assert.deepEqual(petLookCellForVector(100, 0), { angle: 90, column: 4, row: 9 });
  assert.deepEqual(petLookCellForVector(0, 100), { angle: 180, column: 0, row: 10 });
  assert.deepEqual(petLookCellForVector(-100, 0), { angle: 270, column: 4, row: 10 });
  assert.deepEqual(
    petLookCellForVector(109, -191),
    { angle: 67.5, column: 3, row: 9 },
    "the pointer position from the top-right regression selects an unmistakable diagonal frame"
  );
  assert.deepEqual(petLookCellForVector(-109, -191), { angle: 292.5, column: 5, row: 10 });
  assert.equal(petLookCellForVector(2, 2), null);
});

test("Guga V2 is the bundled default alongside Red Spark", () => {
  assert.equal(builtinPet.id, "guga");
  assert.equal(builtinPet.spriteVersionNumber, 2);
  assert.ok(builtinPet.spriteUrl?.includes("guga.webp"));
  assert.deepEqual(builtinPets.map((pet) => pet.id), ["guga", "red-spark"]);
});

test("pet position stays inside the viewport and keeps the desktop default", () => {
  assert.deepEqual(
    clampPetPosition({ x: -20, y: 900 }, { width: 800, height: 600 }, { width: 126, height: 136 }),
    { x: 8, y: 456 }
  );
  assert.deepEqual(defaultPetPosition({ width: 800, height: 600 }, false), { x: 654, y: 358 });
});

test("pet commands stay local and support toggle, off, and direct selection", () => {
  assert.deepEqual(parsePetCommand("/pet"), { action: "toggle" });
  assert.deepEqual(parsePetCommand("/pet off"), { action: "off" });
  assert.deepEqual(parsePetCommand("/pet Little Spud"), { action: "select", query: "Little Spud" });
  assert.equal(parsePetCommand("/pets"), null);
  assert.equal(parsePetCommand("please /pet"), null);
});

test("Codex pet manifests use safe ids and the selected spritesheet", () => {
  assert.deepEqual(parsePetManifest({
    id: "My Pet",
    displayName: "My Pet",
    description: "A helper",
    spritesheetPath: "spritesheet.webp",
  }, "spritesheet.webp"), {
    id: "my-pet",
    displayName: "My Pet",
    description: "A helper",
    spriteVersionNumber: 1,
    spritesheetPath: "spritesheet.webp",
  });
  assert.equal(parsePetManifest({
    id: "V2 Pet",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  }, "spritesheet.webp").spriteVersionNumber, 2);
  assert.throws(
    () => parsePetManifest({ id: "bad", spritesheetPath: "other.webp" }, "spritesheet.webp"),
    /expects other\.webp/
  );
  assert.throws(
    () => parsePetManifest({ id: "future", spriteVersionNumber: 3 }, "spritesheet.webp"),
    /must be 1 or 2/
  );
});

test("duplicate pet names receive the next available numeric suffix", () => {
  const manifest = {
    id: "little-spark",
    displayName: "Little Spark",
    description: "A helper",
    spriteVersionNumber: 2 as const,
    spritesheetPath: "spritesheet.webp",
  };
  assert.deepEqual(nextAvailablePetManifest(manifest, []), manifest);
  assert.deepEqual(nextAvailablePetManifest(manifest, [
    manifest,
    { id: "little-spark-1", displayName: "Little Spark 1" },
    { id: "little-spark-2", displayName: "Little Spark 2" },
  ]), {
    ...manifest,
    id: "little-spark-3",
    displayName: "Little Spark 3",
  });
  const longManifest = {
    ...manifest,
    id: "a".repeat(64),
    displayName: "A".repeat(120),
  };
  const numbered = nextAvailablePetManifest(longManifest, [longManifest]);
  assert.equal(numbered.id.length, 64);
  assert.equal(numbered.displayName.length, 120);
  assert.match(numbered.id, /-1$/);
  assert.match(numbered.displayName, / 1$/);
});

test("pet status prioritizes input, failure, and running", () => {
  const pendingApproval: CodexRecord = {
    id: "approval",
    type: "response_item",
    payload: { type: "local_shell_call", approval: { status: "pending" } },
  };
  const failed: CodexRecord = {
    id: "failure",
    type: "event_msg",
    payload: { type: "turn_aborted", status: "failed" },
  };
  const failedTool: CodexRecord = {
    id: "failed-tool",
    type: "response_item",
    payload: { type: "local_shell_call", status: "failed", exit_code: 1 },
  };
  const completedTurn: CodexRecord = {
    id: "completed-turn",
    type: "event_msg",
    payload: { type: "task_complete", status: "completed" },
  };
  assert.equal(petStatusForThread(thread("thread-1", [pendingApproval], true)), "needs_input");
  assert.equal(petStatusForThread(thread("thread-2", [failed])), "blocked");
  assert.equal(petStatusForThread(thread("thread-3")), "idle");
  assert.equal(petStatusForThread(thread("thread-4", [], true)), "running");
  assert.equal(petStatusForThread(thread("thread-5")), "idle");
  assert.equal(petStatusForThread(thread("thread-6", [failedTool, completedTurn])), "idle");
  assert.equal(petStatusForThread(thread("thread-7", [failedTool])), "idle");
  assert.equal(petAnimationForStatus("needs_input"), "waiting");
  assert.equal(petAnimationForStatus("blocked"), "failed");
  assert.equal(petAnimationForStatus("running"), "running");
  assert.equal(petAnimationForStatus("idle"), "idle");
  assert.equal(petAnimationForPresentation("idle", { composerRecentlyChanged: true }), "waiting");
  assert.equal(petAnimationForPresentation("running", { composerRecentlyChanged: true }), "waiting");
  assert.equal(petAnimationForPresentation("running", { completionPhase: "jumping" }), "jumping");
  assert.equal(petAnimationForPresentation("running", { completionPhase: "waving" }), "waving");
  assert.equal(
    petAnimationForPresentation("running", { composerRecentlyChanged: true, dragDirection: "left" }),
    "running-left"
  );
});

test("pet activities sort using the official attention priority", () => {
  const pendingInput: CodexRecord = {
    id: "input",
    type: "response_item",
    payload: { type: "user_input_request", status: "pending_user_input", userInput: { status: "pending" } },
  };
  const failed: CodexRecord = { id: "failed", type: "error", payload: { message: "boom" } };
  const activities = derivePetActivities([
    thread("thread-4", [], true),
    thread("thread-3"),
    thread("thread-2", [failed]),
    thread("thread-1", [pendingInput], true),
  ]);
  assert.deepEqual(activities.map((activity) => activity.status), ["needs_input", "blocked", "running", "idle"]);
});

test("single-thread completion runs jumping for three seconds before idle", () => {
  const completedTurn: CodexRecord = {
    id: "completed-a",
    type: "event_msg",
    payload: { type: "task_complete", status: "completed" },
  };
  const runningThreads = [thread("thread-a", [], true)];
  const completedThreads = [thread("thread-a", [completedTurn])];
  let state = initialPetCompletionState();
  const animation = (threads: OpenThreadState[]) => petAnimationForPresentation(
    headlinePetStatus(derivePetActivities(threads)),
    { completionPhase: state.phase }
  );

  assert.equal(animation(runningThreads), "running");
  state = transitionPetCompletionState(state, { type: "completed", nowMs: 1_000 });
  assert.equal(animation(completedThreads), "jumping");
  state = transitionPetCompletionState(state, {
    type: "sync",
    nowMs: 1_000 + petCompletionJumpDurationMs - 1,
    hasRunningThreads: hasRunningPetThreads(completedThreads),
  });
  assert.equal(animation(completedThreads), "jumping");
  state = transitionPetCompletionState(state, {
    type: "sync",
    nowMs: 1_000 + petCompletionJumpDurationMs,
    hasRunningThreads: hasRunningPetThreads(completedThreads),
  });
  assert.equal(animation(completedThreads), "idle");
});

test("multi-thread completion waves until every running thread completes", () => {
  const completedA: CodexRecord = {
    id: "completed-a",
    type: "event_msg",
    payload: { type: "task_complete", status: "completed" },
  };
  const completedB: CodexRecord = {
    id: "completed-b",
    type: "event_msg",
    payload: { type: "task_complete", status: "completed" },
  };
  const partialThreads = [
    thread("thread-a", [completedA]),
    thread("thread-b", [], true),
  ];
  const completedThreads = [
    thread("thread-a", [completedA]),
    thread("thread-b", [completedB]),
  ];
  let state = transitionPetCompletionState(initialPetCompletionState(), {
    type: "completed",
    nowMs: 1_000,
  });
  const animation = (threads: OpenThreadState[]) => petAnimationForPresentation(
    headlinePetStatus(derivePetActivities(threads)),
    { completionPhase: state.phase }
  );

  assert.equal(animation(partialThreads), "jumping");
  state = transitionPetCompletionState(state, {
    type: "sync",
    nowMs: 1_000 + petCompletionJumpDurationMs,
    hasRunningThreads: hasRunningPetThreads(partialThreads),
  });
  assert.equal(animation(partialThreads), "waving");

  state = transitionPetCompletionState(state, { type: "completed", nowMs: 5_000 });
  assert.equal(animation(completedThreads), "jumping");
  state = transitionPetCompletionState(state, {
    type: "sync",
    nowMs: 5_000 + petCompletionJumpDurationMs,
    hasRunningThreads: hasRunningPetThreads(completedThreads),
  });
  assert.equal(animation(completedThreads), "idle");
});

test("a completion during jumping restarts the three-second deadline", () => {
  let state = transitionPetCompletionState(initialPetCompletionState(), {
    type: "completed",
    nowMs: 1_000,
  });
  state = transitionPetCompletionState(state, { type: "completed", nowMs: 2_500 });
  assert.equal(state.jumpingUntilMs, 2_500 + petCompletionJumpDurationMs);
  state = transitionPetCompletionState(state, {
    type: "sync",
    nowMs: 1_000 + petCompletionJumpDurationMs,
    hasRunningThreads: false,
  });
  assert.equal(state.phase, "jumping");
  state = transitionPetCompletionState(state, {
    type: "sync",
    nowMs: 2_500 + petCompletionJumpDurationMs,
    hasRunningThreads: false,
  });
  assert.equal(state.phase, "none");
});
