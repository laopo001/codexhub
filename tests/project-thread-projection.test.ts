import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexhubServerState } from "../src/core/serverState.js";
import { findProjectByMachinePath, findProjectByWorkspacePath, patchProjectsThread } from "../src/web/helpers/core.js";
import type { ProjectSummary } from "../src/shared/projectTypes.js";
import type { ThreadSummary } from "../src/shared/threadTypes.js";

const project = (machineId: string, path: string): ProjectSummary => ({
  projectId: `${machineId}:${path}`,
  machineId,
  path,
  name: "shared",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
  machineOnline: true,
  running: false
});

const thread = (machineId = "machine-current"): ThreadSummary => ({
  threadId: "thread-current",
  workingDirectory: "/workspace/shared",
  runtime: { machineId, online: true, runnable: true },
  status: "running",
  running: true,
  title: "Current",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  threadUsage: {} as ThreadSummary["threadUsage"]
});

const unresolvedThread = () => {
  const current = thread("machine-current");
  return {
    ...current,
    runtime: { ...current.runtime, machineId: undefined }
  } as unknown as ThreadSummary;
};

test("patches only the project belonging to the thread machine when paths collide", () => {
  const projects = [project("machine-other", "/workspace/shared"), project("machine-current", "/workspace/shared")];
  const next = patchProjectsThread(projects, thread("machine-current"), {
    machineId: "machine-current",
    path: "/workspace/shared"
  });

  assert.equal(next[0]?.lastThreadId, undefined);
  assert.equal(next[0]?.running, false);
  assert.equal(next[1]?.lastThreadId, "thread-current");
  assert.equal(next[1]?.running, true);
});

test("does not infer project association from a thread workingDirectory", () => {
  const projects = [project("machine-current", "/workspace/shared")];
  assert.strictEqual(patchProjectsThread(projects, thread("machine-current")), projects);
});

test("does not project a mismatched explicit project machine", () => {
  const projects = [project("machine-current", "/workspace/shared")];
  assert.strictEqual(patchProjectsThread(projects, thread("machine-current"), {
    machineId: "machine-other",
    path: "/workspace/shared"
  }), projects);
});

test("resolves project identity strictly by machine and path", () => {
  const current = project("machine-current", "/workspace/shared");
  const other = project("machine-other", "/workspace/shared");

  assert.equal(
    findProjectByMachinePath([current, other], "machine-current", "/workspace/shared"),
    current
  );
  assert.equal(
    findProjectByMachinePath([current, other], "", "/workspace/shared"),
    undefined
  );
});

test("resolves an embedded workspace project by its surface source before path uniqueness", () => {
  const persisted = project("machine-old", "/workspace/shared");
  const embedded = {
    ...project("machine-current", "/workspace/shared"),
    source: { kind: "vscode" as const, groupId: "surface-current" }
  };

  assert.equal(
    findProjectByWorkspacePath([persisted, embedded], "/workspace/shared", {
      sourceKind: "vscode",
      sourceGroupId: "surface-current"
    }),
    embedded
  );
});

test("does not guess an ambiguous workspace path without a matching surface source", () => {
  const projects = [project("machine-a", "/workspace/shared"), project("machine-b", "/workspace/shared")];
  assert.equal(findProjectByWorkspacePath(projects, "/workspace/shared"), undefined);
});

test("resolves a unique workspace path without requiring a runtime", () => {
  const current = project("machine-current", "/workspace/unique");
  assert.equal(findProjectByWorkspacePath([current], "/workspace/unique"), current);
});

test("does not guess a project when a thread has no machine identity and the path is ambiguous", () => {
  const projects = [project("machine-a", "/workspace/shared"), project("machine-b", "/workspace/shared")];
  const next = patchProjectsThread(projects, unresolvedThread());

  assert.strictEqual(next, projects);
});

test("does not patch a project when a thread has no machine identity", () => {
  const projects = [project("machine-a", "/workspace/shared")];
  const next = patchProjectsThread(projects, unresolvedThread());

  assert.strictEqual(next, projects);
});

test("server project snapshots do not attach an unresolved thread by path alone", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-project-identity-"));
  try {
    const state = await CodexhubServerState.load({ dataDir });
    state.upsertProject({ machineId: "machine-a", path: "/workspace/shared" });
    const snapshot = state.snapshot({ machines: [], sessions: [], threads: [unresolvedThread()] });

    assert.equal(snapshot.projects[0]?.running, false);
    assert.equal(snapshot.projects[0]?.lastThreadId, undefined);
    await state.flush();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
