import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { MachineSummary, OpenThreadState, RuntimeSummary } from "../../src/web/types.js";
import {
  petAnimationRows,
  petAtlas,
  petAtlasBackgroundPosition,
  petAtlasForVersion,
  petLookCellForVector,
} from "../../src/web/pets/petAtlas.js";
import { parsePetCommand } from "../../src/web/pets/petCommands.js";
import { calculatePetTrayLayout, clampPetPosition, defaultPetPosition } from "../../src/web/pets/petMotion.js";
import {
  derivePetActivities,
  hasRunningPetThreads,
  headlinePetStatus,
  initialPetCompletionState,
  petAnimationForPresentation,
  petAnimationForStatus,
  petCompletionJumpDurationMs,
  petStatusForThread,
  sortPetActivities,
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
  queuedTurns: [],
  pendingUserMessages: [],
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
  const interrupted: CodexRecord = {
    id: "interrupted",
    type: "event_msg",
    payload: { type: "turn_aborted", status: "interrupted" },
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
  assert.equal(petStatusForThread(thread("thread-8", [interrupted])), "idle");
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

test("pet activities do not use updatedAt to reorder rows within a status group", () => {
  const activities = derivePetActivities([
    thread("thread-1", [], true),
    thread("thread-2", [], true),
  ]);

  assert.deepEqual(activities.map((activity) => activity.threadId), ["thread-1", "thread-2"]);
});

test("pet activity order can preserve the UI-assigned order across snapshots", () => {
  const activities = derivePetActivities([
    thread("thread-2", [], true),
    thread("thread-1", [], true),
  ]);
  const order = new Map([
    ["thread-1", 0],
    ["thread-2", 1],
  ]);

  assert.deepEqual(
    sortPetActivities(activities, order).map((activity) => activity.threadId),
    ["thread-1", "thread-2"]
  );
});

test("pet activities include running threads from registered runtimes", () => {
  const runtime: RuntimeSummary = {
    machineId: "machine-wsl",
    name: "CodexHub Authority · WSL Ubuntu · jx",
    workingDirectory: "/home/laop/projects/codexhub",
    online: true,
    status: "online",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    threads: [{
      threadId: "wsl-thread",
      workingDirectory: "/home/laop/projects/codexhub",
      runtime: { machineId: "machine-wsl", online: true, runnable: true },
      status: "running",
      running: true,
      title: "WSL work",
      updatedAt: "2026-01-01T00:00:01.000Z",
      messageCount: 1,
      threadUsage: emptyThreadUsage()
    }]
  };
  const machine: MachineSummary = {
    machineId: "machine-wsl",
    type: "registered",
    name: "CodexHub Authority · WSL Ubuntu · jx",
    hostname: "wsl-host",
    online: true,
    status: "online",
    lastSeenAt: runtime.lastSeenAt,
    capabilities: { projectLauncher: true },
    activities: [{
      threadId: "wsl-thread",
      title: "WSL work",
      workingDirectory: "/home/laop/projects/codexhub",
      updatedAt: "2026-01-01T00:00:01.000Z",
      status: "running"
    }]
  };
  const activities = derivePetActivities([], [runtime], [machine]);
  const machineActivities = derivePetActivities([], [], [machine]);

  assert.equal(hasRunningPetThreads([], [runtime]), true);
  assert.equal(machineActivities[0]?.status, "running");
  assert.deepEqual(activities.map((activity) => ({
    threadId: activity.threadId,
    status: activity.status,
    machineId: activity.machineId,
    machineLabel: activity.machineLabel,
    machineLabelParts: activity.machineLabelParts
  })), [{
    threadId: "wsl-thread",
    status: "running",
    machineId: "machine-wsl",
    machineLabel: "reg · codexhub · WSL Ubuntu · jx",
    machineLabelParts: {
      type: "reg",
      directoryName: "codexhub",
      machineContext: "WSL Ubuntu · jx"
    }
  }]);
});

test("open pet activities expose the same turn start used by the tab timer", () => {
  const startedAt = "2026-01-01T00:00:05.000Z";
  const runningThread = {
    ...thread("thread-timer", [{
      id: "turn-started",
      timestamp: startedAt,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-timer" }
    }], true),
    activeTurnId: "turn-timer"
  };

  assert.deepEqual(derivePetActivities([runningThread])[0]?.executionMeta, {
    status: "running",
    label: "Running",
    duration: "",
    text: "Running",
    startedAt
  });
});

test("open pet activities expose current Plan progress alongside the shared timer", () => {
  const threadId = "thread-plan";
  const turnId = "turn-plan";
  const planRecord: CodexRecord = {
    id: `app:${threadId}:${turnId}:event:turn_plan_updated`,
    timestamp: "2026-01-01T00:00:06.000Z",
    type: "event_msg",
    sourceThreadId: threadId,
    payload: {
      type: "turn_plan_updated",
      turn_id: turnId,
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "in_progress" },
        { step: "Verify", status: "pending" },
        { step: "Report", status: "pending" }
      ]
    }
  };
  const activity = derivePetActivities([{
    ...thread(threadId, [planRecord], true),
    activeTurnId: turnId
  }])[0];

  assert.deepEqual(activity?.activePlanProgress, { currentStep: 2, totalSteps: 4 });
});

test("summary-only pet activities expose the runtime turn start for a live timer", () => {
  const startedAt = "2026-01-01T00:00:05.000Z";
  const runtime: RuntimeSummary = {
    machineId: "machine-summary-timer",
    workingDirectory: "/home/laop/projects/codexhub",
    online: true,
    status: "online",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    threads: [{
      threadId: "summary-timer-thread",
      workingDirectory: "/home/laop/projects/codexhub",
      runtime: { machineId: "machine-summary-timer", online: true, runnable: true },
      status: "running",
      running: true,
      activeTurnId: "summary-timer-turn",
      activeTurnStartedAt: startedAt,
      activePlanProgress: { currentStep: 1, totalSteps: 3 },
      title: "Summary timer",
      updatedAt: "2026-01-01T00:00:10.000Z",
      messageCount: 1,
      threadUsage: emptyThreadUsage()
    }]
  };

  assert.deepEqual(derivePetActivities([], [runtime])[0]?.executionMeta, {
    status: "running",
    label: "Running",
    duration: "",
    text: "Running",
    startedAt
  });
  assert.deepEqual(derivePetActivities([], [runtime])[0]?.activePlanProgress, {
    currentStep: 1,
    totalSteps: 3
  });
});

test("machine-only pet activities expose the registered turn start and Agent message", () => {
  const startedAt = "2026-01-01T00:00:05.000Z";
  const machine: MachineSummary = {
    machineId: "machine-activity-only",
    type: "registered",
    name: "Authority · Remote authority",
    hostname: "remote",
    online: true,
    status: "online",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    capabilities: { projectLauncher: true },
    activities: [{
      threadId: "activity-only-thread",
      title: "Activity only",
      activityTitle: "检查注册机器",
      activeTurnStartedAt: startedAt,
      activePlanProgress: { currentStep: 3, totalSteps: 4 },
      latestAgentMessage: "正在检查第二排时间",
      workingDirectory: "/home/laop/projects/codexhub",
      updatedAt: "2026-01-01T00:00:10.000Z",
      status: "running"
    }]
  };

  assert.deepEqual(derivePetActivities([], [], [machine])[0], {
    threadId: "activity-only-thread",
    title: "检查注册机器",
    workingDirectory: "/home/laop/projects/codexhub",
    updatedAt: "2026-01-01T00:00:10.000Z",
    status: "running",
    machineId: "machine-activity-only",
    machineHostname: "remote",
    machineLabel: "reg · codexhub · Remote authority",
    machineLabelParts: {
      type: "reg",
      directoryName: "codexhub",
      machineContext: "Remote authority"
    },
    latestAgentMessage: "正在检查第二排时间",
    executionMeta: {
      status: "running",
      label: "Running",
      duration: "",
      text: "Running",
      startedAt
    },
    activePlanProgress: { currentStep: 3, totalSteps: 4 },
    activeGoal: null
  });
});

test("pet activity titles prefer Goal, then the latest user-input hint", () => {
  const runtime: RuntimeSummary = {
    machineId: "machine-title",
    workingDirectory: "/home/laop/projects/codexhub",
    online: true,
    status: "online",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    threads: [{
      threadId: "goal-thread",
      workingDirectory: "/home/laop/projects/codexhub",
      runtime: { machineId: "machine-title", online: true, runnable: true },
      status: "running",
      running: true,
      title: "Old thread title",
      activityTitle: "Goal: finish the smoke tests",
      updatedAt: "2026-01-01T00:00:01.000Z",
      messageCount: 2,
      threadUsage: emptyThreadUsage()
    }, {
      threadId: "input-thread",
      workingDirectory: "/home/laop/projects/codexhub",
      runtime: { machineId: "machine-title", online: true, runnable: true },
      status: "idle",
      running: false,
      title: "Old input thread title",
      activityTitle: "帮我检查最后一条输入",
      updatedAt: "2026-01-01T00:00:02.000Z",
      messageCount: 2,
      threadUsage: emptyThreadUsage()
    }]
  };

  assert.deepEqual(
    derivePetActivities([], [runtime]).map((activity) => [activity.threadId, activity.title]),
    [
      ["goal-thread", "Goal: finish the smoke tests"],
      ["input-thread", "帮我检查最后一条输入"]
    ]
  );
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

test("derivePetActivities routes explicit project origin to its workspace", () => {
  const machineId = "machine-authority-00ad99e0-a745-4ce9-9a10-fb5620893367";
  const projectList: import("../../src/shared/projectTypes.js").ProjectSummary[] = [
    {
      projectId: "p-root",
      machineId,
      path: "/home/laop/projects",
      name: "projects",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      machineOnline: true,
      running: false,
      source: { kind: "vscode", groupId: "parent-surface", label: "VSCode: parent [WSL: Ubuntu]" }
    },
    {
      projectId: "p-specific",
      machineId,
      path: "/home/laop/projects/codexhub",
      name: "codexhub",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      machineOnline: true,
      running: false,
      source: {
        kind: "vscode",
        groupId: "registered:machine-authority-00ad99e0-a745-4ce9-9a10-fb5620893367:vscode-93ed5dee",
        label: "VSCode: codexhub [WSL: Ubuntu]",
        vscodeChannel: "insiders"
      }
    },
    {
      projectId: "p-sibling",
      machineId,
      path: "/home/laop/projects/other",
      name: "other",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      machineOnline: true,
      running: false,
      source: {
        kind: "vscode",
        groupId: "registered:machine-authority-00ad99e0-a745-4ce9-9a10-fb5620893367:vscode-93ed5dee",
        label: "VSCode: codexhub [WSL: Ubuntu]",
        vscodeChannel: "insiders"
      }
    }
  ];

  const threadState = {
    ...thread("wsl-thread-1", [], true),
    workingDirectory: "/home/laop/projects/codexhub/src/web",
    runtime: { online: true, runnable: true, machineId }
  };

  const machines: import("../../src/web/types.js").MachineSummary[] = [
    {
      machineId,
      name: "jx-workstation",
      hostname: "jx",
      platform: "linux-x64",
      type: "registered",
      online: true,
      status: "online",
      capabilities: { projectLauncher: true },
      lastSeenAt: "2026-01-01T00:00:00.000Z"
    }
  ];

  const projectTarget = { machineId, path: "/home/laop/projects/codexhub" };
  const activities = derivePetActivities(
    [threadState],
    [],
    machines,
    [],
    projectList,
    { "wsl-thread-1": projectTarget }
  );
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.projectPath, "/home/laop/projects/codexhub");
  assert.equal(activities[0]?.machineHostname, "jx");
  assert.deepEqual(activities[0]?.projectSource, {
    kind: "vscode",
    groupId: "registered:machine-authority-00ad99e0-a745-4ce9-9a10-fb5620893367:vscode-93ed5dee",
    label: "VSCode: codexhub [WSL: Ubuntu]",
    vscodeChannel: "insiders"
  });
  assert.equal(activities[0]?.projectSource?.vscodeChannel, "insiders");
  assert.deepEqual(activities[0]?.projectTarget, projectTarget);
  assert.deepEqual(activities[0]?.workspaceTarget, {
    machineId,
    kind: "vscode",
    groupId: "registered:machine-authority-00ad99e0-a745-4ce9-9a10-fb5620893367:vscode-93ed5dee",
    workspacePaths: ["/home/laop/projects/codexhub", "/home/laop/projects/other"],
    label: "VSCode: codexhub [WSL: Ubuntu]",
    vscodeChannel: "insiders"
  });
  assert.equal(activities[0]?.machineLabelParts?.type, "vsc-i");
  assert.equal(activities[0]?.machineLabelParts?.directoryName, "web");
  assert.equal(activities[0]?.machineLabel, "vsc-i · web");
});

test("derivePetActivities leaves a thread without explicit origin unresolved", () => {
  const activities = derivePetActivities([thread("unknown-origin", [], true)], [], [], [], [], {});
  assert.equal(activities[0]?.projectTarget, undefined);
  assert.equal(activities[0]?.workspaceTarget, undefined);
  assert.equal(activities[0]?.projectPath, undefined);
});

test("PetFeature openActivity retains tray expansion without closing it and has no focusMainWindow fallback", async () => {
  const { readFile } = await import("node:fs/promises");
  const petFeatureCode = await readFile(
    new URL("../../src/web/pets/PetFeature.tsx", import.meta.url),
    "utf8"
  );
  const openActivityMatch = petFeatureCode.match(/const openActivity = \(activity: PetActivity\) => \{([\s\S]*?)\};/);
  assert.ok(openActivityMatch, "openActivity definition must exist");
  assert.ok(
    !openActivityMatch[1].includes("setTrayOpen(false)"),
    "clicking an activity must NOT call setTrayOpen(false) to keep the tray open"
  );
  assert.ok(
    openActivityMatch[1].includes("openPetActivity"),
    "openActivity must dispatch structured openPetActivity payload"
  );
  assert.ok(
    !openActivityMatch[1].includes("focusMainWindow"),
    "openActivity must NOT contain any legacy focusMainWindow fallback"
  );
});

test("pet activity labels only explicit CLI sources and does not infer from names or projects", () => {
  const cli = { ...thread("thread-1", [], true), source: "cli" as const };
  const web = { ...thread("thread-2", [], true), source: "web" as const };
  const unknown = { ...thread("thread-3", [], true), title: "CLI task" };
  const rows = derivePetActivities([cli, web, unknown]);
  assert.deepEqual(rows.map(row => row.source), ["cli", undefined, undefined]);
});

test("detached desktop feed preserves CLI source from runtime and registered activity snapshots", () => {
  const runtime: RuntimeSummary = { machineId: "session-1", online: true, status: "online", workingDirectory: "/tmp", lastSeenAt: "2026-01-01T00:00:00Z", threads: [{ ...thread("thread-1", [], true), source: "cli" }] };
  const machine: MachineSummary = { machineId: "registered", type: "registered", hostname: "remote-host", capabilities: { projectLauncher: false }, online: true, status: "online", lastSeenAt: runtime.lastSeenAt, activities: [{ threadId: "remote-cli", title: "Remote", source: "cli", workingDirectory: "/remote", updatedAt: runtime.lastSeenAt, status: "running" }] };
  assert.equal(derivePetActivities([], [runtime])[0]?.source, "cli");
  assert.equal(derivePetActivities([], [], [machine])[0]?.source, "cli");
  assert.equal(derivePetActivities([{ ...thread("thread-1", [], true), source: "web" }], [runtime])[0]?.source, undefined);
});

test("pet activity markup adds only a CLI badge while preserving state indicators", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PetOverlay } = await import("../../src/web/pets/PetFeature.js");
  const activities = derivePetActivities([{ ...thread("thread-1", [], true), source: "cli" }, { ...thread("thread-2", [], true), source: "web" }]);
  const controller = { enabled: true, selectedPet: builtinPet, status: "running", activities, trayOpen: true, completionPhase: "none", position: { x: 100, y: 300 }, setTrayOpen: () => {}, setPosition: () => {}, openPicker: () => {} } as unknown as Parameters<typeof PetOverlay>[0]["controller"];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 800, innerHeight: 600, location: { search: "" }, matchMedia: () => ({ matches: true }) } });
  let html: string;
  try {
    html = renderToStaticMarkup(createElement(PetOverlay, { controller, composerRecentlyChanged: false, onOpenThread: () => {} }));
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
  assert.equal((html.match(/\[cli\]/g) ?? []).length, 1);
  assert.equal((html.match(/petActivityDot running/g) ?? []).length, 2);
  assert.doesNotMatch(html, /\[web\]/);
});

test("calculatePetTrayLayout centers the tray under the pet and clamps at viewport edges", () => {
  const viewport = { width: 1280, height: 800 };
  const petSize = { width: 126, height: 136 };

  // 1. In normal position, tray is centered under pet: center offset = (126 - 310) / 2 = -92
  const centeredLayout = calculatePetTrayLayout({ x: 500, y: 300 }, viewport, petSize);
  assert.equal(centeredLayout.horizontal, "center");
  assert.equal(centeredLayout.width, 310);
  assert.equal(centeredLayout.offsetLeft, -92);
  const petCenter = 500 + petSize.width / 2;
  const trayCenter = 500 + centeredLayout.offsetLeft + centeredLayout.width / 2;
  assert.equal(petCenter, trayCenter);

  // 2. Near left edge: tray clamped to viewport margin (12px), does not overflow left
  const leftClamped = calculatePetTrayLayout({ x: 8, y: 300 }, viewport, petSize);
  assert.equal(leftClamped.horizontal, "left");
  assert.equal(leftClamped.offsetLeft, 4); // 8 + 4 = 12px (left margin)
  assert.equal(8 + leftClamped.offsetLeft, 12);

  // 3. Near right edge: tray clamped to viewport right edge margin
  const petRightEdgeX = viewport.width - petSize.width - 8;
  const rightClamped = calculatePetTrayLayout({ x: petRightEdgeX, y: 300 }, viewport, petSize);
  assert.equal(rightClamped.horizontal, "right");
  const trayRight = petRightEdgeX + rightClamped.offsetLeft + rightClamped.width;
  assert.equal(trayRight, viewport.width - 12);

  // 4. Narrow viewport: width adapts to viewport.width - 32
  const narrowViewport = { width: 300, height: 600 };
  const compactPet = { width: 96, height: 104 };
  const narrowLayout = calculatePetTrayLayout({ x: 100, y: 200 }, narrowViewport, compactPet);
  assert.equal(narrowLayout.width, 268);
});

test("desktop pet tray stays within the display containing the pet", () => {
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 2560, height: 1440 },
  ];
  const petSize = { width: 126, height: 136 };
  const petPosition = { x: 1790, y: 300 };
  const layout = calculatePetTrayLayout(
    petPosition,
    { width: 4480, height: 1440 },
    petSize,
    310,
    12,
    displays
  );

  assert.equal(layout.horizontal, "right");
  assert.equal(layout.vertical, "below");
  assert.equal(petPosition.x + layout.offsetLeft + layout.width, 1908);
});

test("pet activity tray renders centered with inline offset", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PetOverlay } = await import("../../src/web/pets/PetFeature.js");
  const activities = derivePetActivities([thread("thread-1", [], true)]);
  const controller = {
    enabled: true,
    selectedPet: builtinPet,
    status: "running",
    activities,
    trayOpen: true,
    completionPhase: "none",
    position: { x: 500, y: 300 },
    setTrayOpen: () => {},
    setPosition: () => {},
    openPicker: () => {},
  } as unknown as Parameters<typeof PetOverlay>[0]["controller"];

  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { innerWidth: 1280, innerHeight: 800, location: { search: "" }, matchMedia: () => ({ matches: true }) }
  });
  let html: string;
  try {
    html = renderToStaticMarkup(createElement(PetOverlay, { controller, composerRecentlyChanged: false, onOpenThread: () => {} }));
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }

  assert.match(html, /data-tray-horizontal="center"/);
  assert.match(html, /style="left:-92px;width:310px"/);
});
