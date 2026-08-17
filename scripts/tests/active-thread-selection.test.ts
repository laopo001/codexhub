import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import { resolveActiveThreadId } from "../../src/web/helpers/activeThreadSelection.js";
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
  textAttachments: []
});

const openThreads = [
  thread("thread-other", "/workspace/other", "machine-other"),
  thread("thread-active", "/workspace/current", "machine-current")
];

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
    openThreads
  }), "thread-loading");
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
    selectedProjectPath: "/workspace/new"
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

test("does not activate a thread from another project", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-current",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/new",
    openThreads,
    selectedProjectMachineId: "machine-current",
    selectedProjectPath: "/workspace/new"
  }), "");
});

test("uses the current machine when active is empty", () => {
  assert.equal(resolveActiveThreadId({
    activeMachineId: "machine-other",
    activeTabThreadId: "",
    activeWorkspacePath: "/workspace/missing",
    openThreads
  }), "thread-other");
});
