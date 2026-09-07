import assert from "node:assert/strict";
import test from "node:test";
import {
  projectsForSurface,
  threadMatchesProjectTarget,
  workspaceIncludesProjectTarget
} from "../../src/web/helpers/surfaceThreadScope.js";
import { findProjectByWorkspacePath } from "../../src/web/helpers/core.js";

test("selects every project contributed by one surface and excludes another surface", () => {
  const result = projectsForSurface([
    {
      machineId: "machine-local",
      path: "/workspace/a",
      source: { kind: "vscode" as const, groupId: "surface-current" }
    },
    {
      machineId: "machine-local",
      path: "/workspace/b",
      source: { kind: "vscode" as const, groupId: "surface-current" }
    },
    {
      machineId: "machine-local",
      path: "/workspace/a",
      source: { kind: "vscode" as const, groupId: "surface-other" }
    },
    {
      machineId: "machine-local",
      path: "/workspace/not-open",
      source: { kind: "vscode" as const, groupId: "surface-current" }
    }
  ], {
    kind: "vscode",
    groupId: "surface-current",
    workspacePaths: ["/workspace/a", "/workspace/b"]
  });

  assert.deepEqual(result.map((project) => project.path), ["/workspace/a", "/workspace/b"]);
});

test("workspace membership uses explicit project target instead of thread cwd", () => {
  const paths = new Set(["/workspace/a", "/workspace/b"]);
  assert.equal(workspaceIncludesProjectTarget(
    paths,
    { machineId: "machine-local", path: "/workspace/b" },
    "machine-local"
  ), true);
  assert.equal(workspaceIncludesProjectTarget(
    paths,
    { machineId: "machine-other", path: "/workspace/b" },
    "machine-local"
  ), false);
  assert.equal(workspaceIncludesProjectTarget(paths, undefined, "machine-local"), false);
});

test("project association requires an explicit machine and path target", () => {
  const projectA = { machineId: "machine-local", path: "/workspace/a" };
  assert.equal(threadMatchesProjectTarget(
    { machineId: "machine-local", path: "/workspace/a" },
    projectA
  ), true);
  assert.equal(threadMatchesProjectTarget(
    { machineId: "machine-remote", path: "/workspace/a" },
    projectA
  ), false);
  assert.equal(threadMatchesProjectTarget(undefined, projectA), false);
});

test("surface filtering selects the matching source and initial resolution keeps cross-kind paths distinct", () => {
  const project = {
    projectId: "project-shared",
    machineId: "machine-local",
    path: "/workspace/shared",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    name: "shared",
    machineOnline: true,
    running: false,
    source: { kind: "electron" as const, groupId: "electron-window", label: "Electron" },
    sources: [
      { kind: "electron" as const, groupId: "electron-window", label: "Electron" },
      { kind: "vscode" as const, groupId: "vscode-window", label: "VS Code" }
    ]
  };
  const vscodeProject = projectsForSurface([project], {
    kind: "vscode",
    groupId: "vscode-window",
    workspacePaths: ["/workspace/shared"]
  });
  assert.equal(vscodeProject[0]?.source?.label, "VS Code");
  assert.equal(vscodeProject[0]?.sources, project.sources);
  assert.equal(findProjectByWorkspacePath([project], "/workspace/shared", {
    sourceKind: "vscode",
    sourceGroupId: "vscode-window"
  }), project);
  assert.equal(findProjectByWorkspacePath([project], "/workspace/shared", {
    sourceKind: "vscode",
    sourceGroupId: "other-window"
  }), undefined);
});
