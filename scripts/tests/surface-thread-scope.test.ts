import assert from "node:assert/strict";
import test from "node:test";
import {
  projectsForSurface,
  threadIdsForSurfaceProjects
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

test("keeps every project path contributed by one surface", () => {
  const result = threadIdsForSurfaceProjects(
    ["project-a", "project-b", "foreign"],
    {
      "project-a": { machineId: "machine-local", workingDirectory: "/workspace/a" },
      "project-b": { machineId: "machine-local", workingDirectory: "/workspace/b" },
      foreign: { machineId: "machine-local", workingDirectory: "/workspace/foreign" }
    },
    [
      { machineId: "machine-local", path: "/workspace/a" },
      { machineId: "machine-local", path: "/workspace/b" }
    ]
  );

  assert.deepEqual(result, ["project-a", "project-b"]);
});

test("isolates the same path on another machine", () => {
  const result = threadIdsForSurfaceProjects(
    ["local", "remote"],
    {
      local: { machineId: "machine-local", workingDirectory: "/workspace/shared" },
      remote: { machineId: "machine-remote", workingDirectory: "/workspace/shared" }
    },
    [{ machineId: "machine-local", path: "/workspace/shared" }]
  );

  assert.deepEqual(result, ["local"]);
});

test("uses persisted targets when a restarted runtime has not loaded the thread yet", () => {
  const result = threadIdsForSurfaceProjects(
    ["saved-current", "saved-foreign", "missing-target"],
    {
      "saved-current": { machineId: "machine-local", workingDirectory: "/workspace/current" },
      "saved-foreign": { machineId: "machine-local", workingDirectory: "/workspace/other" }
    },
    [{ machineId: "machine-local", path: "/workspace/current" }]
  );

  assert.deepEqual(result, ["saved-current"]);
});

test("does not select a runtime fallback outside every project in the surface", () => {
  const result = threadIdsForSurfaceProjects(
    ["runtime-foreign"],
    {
      "runtime-foreign": { machineId: "machine-local", workingDirectory: "/workspace/foreign" }
    },
    [
      { machineId: "machine-local", path: "/workspace/a" },
      { machineId: "machine-local", path: "/workspace/b" }
    ]
  );

  assert.deepEqual(result, []);
});
