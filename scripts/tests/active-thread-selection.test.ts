import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import { resolveActiveThreadId, selectActiveThread } from "../../src/web/helpers/activeThreadSelection.js";
import type { OpenThreadState } from "../../src/web/types.js";

const thread = (threadId: string, workingDirectory: string, machineId: string): OpenThreadState => ({
  threadId,
  workingDirectory,
  runtime: { online: true, runnable: true, machineId },
  status: "idle",
  running: false,
  title: threadId,
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  threadUsage: emptyThreadUsage(),
  records: [],
  lastSeq: 0,
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
  pendingUserMessages: []
});

const openThreads = [
  thread("thread-other", "/workspace/other", "machine-other"),
  thread("thread-active", "/workspace/current", "machine-current")
];

test("selected project never derives active thread from machine-only fallback", () => {
  const selectedProject = { machineId: "machine-current", path: "/workspace/a" };
  assert.equal(selectActiveThread({
    activeTabThreadId: "thread-active",
    activeMachineId: "machine-current",
    openThreads,
    selectedProjectTarget: selectedProject,
    projectSelectionActive: true,
    threadProjectTargets: {},
    fixedSurface: true
  }), undefined);
  assert.equal(selectActiveThread({
    activeTabThreadId: "",
    activeMachineId: "machine-current",
    openThreads: [
      ...openThreads,
      thread("thread-explicit", "/workspace/root", "machine-current")
    ],
    selectedProjectTarget: selectedProject,
    projectSelectionActive: true,
    threadProjectTargets: {
      "thread-explicit": selectedProject
    },
    fixedSurface: true
  })?.threadId, "thread-explicit");
});

test("stale selected project identity never falls back to another open thread", () => {
  assert.equal(selectActiveThread({
    activeTabThreadId: "thread-active",
    activeMachineId: "machine-current",
    openThreads,
    selectedProjectTarget: undefined,
    projectSelectionActive: true,
    threadProjectTargets: {},
    fixedSurface: true
  }), undefined);
});

test("keeps a valid active thread", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "thread-active",
    activeWorkspacePath: "/workspace/current",
    openThreads
  }), "thread-active");
});

test("keeps a non-empty active thread while it is loading", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "thread-loading",
    activeWorkspacePath: "/workspace/current",
    openThreads,
    loadingThreadIds: new Set(["thread-loading"])
  }), "thread-loading");
});

test("recovers an active id after its load has failed", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "thread-failed",
    activeWorkspacePath: "/workspace/current",
    openThreads
  }), "thread-active");
});

test("recovers a cleared active thread from the current workspace", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/current",
    openThreads
  }), "thread-active");
});

test("recovers the open thread belonging to the selected project", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/new",
    openThreads: [
      ...openThreads,
      thread("thread-selected-project", "/workspace/new", "machine-current")
    ],
    selectedProjectMachineId: "machine-current",
    selectedProjectPath: "/workspace/new",
    selectedProjectThreadId: "thread-selected-project"
  }), "thread-selected-project");
});

test("selects the matching machine when projects share the same path", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/shared",
    openThreads: [
      thread("thread-other-machine", "/workspace/shared", "machine-other"),
      thread("thread-selected-machine", "/workspace/shared", "machine-current")
    ],
    selectedProjectMachineId: "machine-current",
    selectedProjectPath: "/workspace/shared"
  }), "thread-selected-machine");
});

test("does not select another machine at the selected project path", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/shared",
    openThreads: [thread("thread-other-machine", "/workspace/shared", "machine-other")],
    selectedProjectMachineId: "machine-current",
    selectedProjectPath: "/workspace/shared"
  }), "");
});

test("keeps a same-machine open thread when the selected project has no matching path", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/new",
    openThreads,
    selectedProjectMachineId: "machine-current",
    selectedProjectPath: "/workspace/new"
  }), "thread-active");
});

test("does not use workingDirectory to change fixed-surface tab selection", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/new",
    openThreads,
    selectedProjectMachineId: "machine-current",
    selectedProjectPath: "/workspace/new",
    restrictToWorkspacePath: true
  }), "");
});

test("an explicitly selected foreign tab remains selectable", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "thread-active",
    activeWorkspacePath: "/workspace/new",
    openThreads,
    selectedProjectMachineId: "machine-current",
    selectedProjectPath: "/workspace/new",
    restrictToWorkspacePath: true
  }), "thread-active");
});

test("uses the current machine when active is empty", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-other",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/missing",
    openThreads
  }), "thread-other");
});
