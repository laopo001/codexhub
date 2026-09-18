import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../src/core/threadUsage.js";
import { resolveActiveThreadId, selectActiveThread } from "../src/web/helpers/activeThreadSelection.js";
import type { OpenThreadState } from "../src/web/types.js";

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

test("an explicit active surface tab remains authoritative without project metadata", () => {
  const selectedProject = { machineId: "machine-current", path: "/workspace/a" };
  assert.equal(selectActiveThread({
    activeTabThreadId: "thread-active",
    activeMachineId: "machine-current",
    openThreads,
    selectedProjectTarget: selectedProject,
    projectSelectionActive: true,
    threadProjectTargets: {},
    fixedSurface: true
  })?.threadId, "thread-active");

  // With no explicit tab, project selection still requires an explicit target
  // and never falls back through workingDirectory or machine-only matching.
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

test("a valid active surface tab survives stale selected-project identity", () => {
  assert.equal(selectActiveThread({
    activeTabThreadId: "thread-active",
    activeMachineId: "machine-current",
    openThreads,
    selectedProjectTarget: undefined,
    projectSelectionActive: true,
    threadProjectTargets: {},
    fixedSurface: true
  })?.threadId, "thread-active");
});

test("stale selected project identity has no fallback when no tab is active", () => {
  assert.equal(selectActiveThread({
    activeTabThreadId: "",
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
  const selectedProject = { machineId: "machine-current", path: "/workspace/new" };
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/new",
    openThreads: [
      ...openThreads,
      thread("thread-selected-project", "/workspace/new", "machine-current")
    ],
    selectedProjectTarget: selectedProject,
    threadProjectTargets: {
      "thread-selected-project": selectedProject
    }
  }), "thread-selected-project");
});

test("restored threads without project targets do not crash before project selection is available", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/current",
    openThreads,
    selectedProjectTarget: undefined,
    threadProjectTargets: {}
  }), "thread-active");
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
    selectedProjectTarget: { machineId: "machine-current", path: "/workspace/shared" }
  }), "thread-selected-machine");
});

test("does not select another machine at the selected project path", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/shared",
    openThreads: [thread("thread-other-machine", "/workspace/shared", "machine-other")],
    selectedProjectTarget: { machineId: "machine-current", path: "/workspace/shared" }
  }), "");
});

test("keeps a same-machine open thread when the selected project has no matching path", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/new",
    openThreads,
    selectedProjectTarget: { machineId: "machine-current", path: "/workspace/new" }
  }), "thread-active");
});

test("does not use workingDirectory to change fixed-surface tab selection", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/new",
    openThreads,
    selectedProjectTarget: { machineId: "machine-current", path: "/workspace/new" },
    restrictToWorkspacePath: true
  }), "");
});

test("an explicitly selected foreign tab remains selectable", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "thread-active",
    activeWorkspacePath: "/workspace/new",
    openThreads,
    selectedProjectTarget: { machineId: "machine-current", path: "/workspace/new" },
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
