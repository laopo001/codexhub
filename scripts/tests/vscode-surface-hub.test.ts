import assert from "node:assert/strict";
import test from "node:test";
import {
  VscodeSurfaceHub,
  type VscodeSurfaceProject
} from "../../src/core/vscodeSurfaceHub.js";

test("VSCode surface leases merge workspace projects and retain shared paths", () => {
  const snapshots: VscodeSurfaceProject[][] = [];
  const hub = new VscodeSurfaceHub({
    leaseTimeoutMs: 60_000,
    idleShutdownMs: 60_000,
    onProjectsChange: (projects) => snapshots.push(projects)
  });
  try {
    hub.upsert({
      surfaceId: "surface-a",
      leaseId: "lease-a",
      machineId: "machine-local",
      workspacePaths: ["/workspace/a", "/workspace/shared"],
      activeWorkspacePath: "/workspace/a",
      label: "VSCode: A"
    });
    hub.upsert({
      surfaceId: "surface-b",
      leaseId: "lease-b",
      machineId: "machine-local",
      workspacePaths: ["/workspace/shared", "/workspace/b"],
      activeWorkspacePath: "/workspace/b",
      label: "VSCode: B"
    });

    assert.deepEqual(hub.list().map((surface) => surface.surfaceId), ["surface-a", "surface-b"]);
    assert.deepEqual(
      snapshots.at(-1)?.map((project) => project.path),
      ["/workspace/a", "/workspace/b", "/workspace/shared"]
    );

    assert.equal(hub.remove("surface-a", "wrong-lease"), false);
    assert.equal(hub.remove("surface-a", "lease-a"), true);
    assert.deepEqual(
      snapshots.at(-1)?.map((project) => project.path),
      ["/workspace/b", "/workspace/shared"]
    );
  } finally {
    hub.stop();
  }
});

test("a new VSCode lease supersedes stale unregister and heartbeat calls", () => {
  const hub = new VscodeSurfaceHub({
    leaseTimeoutMs: 60_000,
    idleShutdownMs: 60_000,
    onProjectsChange: () => undefined
  });
  try {
    hub.upsert({
      surfaceId: "surface-a",
      leaseId: "old-lease",
      machineId: "machine-local",
      workspacePaths: ["/workspace/a"],
      label: "VSCode: A"
    });
    hub.upsert({
      surfaceId: "surface-a",
      leaseId: "new-lease",
      machineId: "machine-local",
      workspacePaths: ["/workspace/b"],
      label: "VSCode: B"
    });

    assert.equal(hub.touch("surface-a", "old-lease"), null);
    assert.equal(hub.remove("surface-a", "old-lease"), false);
    assert.equal(hub.get("surface-a")?.leaseId, "new-lease");
    assert.deepEqual(hub.get("surface-a")?.workspacePaths, ["/workspace/b"]);
  } finally {
    hub.stop();
  }
});

test("an empty VSCode authority reaches its idle callback", async () => {
  let resolveIdle: (() => void) | undefined;
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  const hub = new VscodeSurfaceHub({
    leaseTimeoutMs: 100,
    idleShutdownMs: 10,
    onProjectsChange: () => undefined,
    onIdle: () => resolveIdle?.()
  });
  try {
    await Promise.race([
      idle,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("idle callback timeout")), 500))
    ]);
  } finally {
    hub.stop();
  }
});

test("an old VSCode authority yields after every remaining surface uses the replacement build", () => {
  const replacements: string[] = [];
  const hub = new VscodeSurfaceHub({
    leaseTimeoutMs: 60_000,
    idleShutdownMs: 60_000,
    currentBuildId: "build-old",
    onProjectsChange: () => undefined,
    onReplacementBuild: (buildId) => replacements.push(buildId)
  });
  try {
    hub.upsert({
      surfaceId: "old-window",
      leaseId: "old-lease",
      machineId: "machine-local",
      workspacePaths: ["/workspace/old"],
      label: "VSCode: Old",
      buildId: "build-old"
    });
    hub.upsert({
      surfaceId: "new-window",
      leaseId: "new-lease",
      machineId: "machine-local",
      workspacePaths: ["/workspace/new"],
      label: "VSCode: New",
      buildId: "build-new"
    });
    assert.deepEqual(replacements, []);
    assert.equal(hub.get("new-window")?.buildId, "build-new");

    hub.remove("old-window", "old-lease");
    assert.deepEqual(replacements, ["build-new"]);
    hub.touch("new-window", "new-lease");
    assert.deepEqual(replacements, ["build-new"]);
  } finally {
    hub.stop();
  }
});
