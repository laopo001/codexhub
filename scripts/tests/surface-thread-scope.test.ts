import assert from "node:assert/strict";
import test from "node:test";
import {
  projectsForSurface,
  threadMatchesProjectTarget,
  workspaceIncludesProjectTarget
} from "../../src/web/helpers/surfaceThreadScope.js";

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
