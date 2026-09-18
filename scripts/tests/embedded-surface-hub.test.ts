import assert from "node:assert/strict";
import test from "node:test";
import {
  EmbeddedSurfaceHub,
  type EmbeddedSurfaceProject
} from "../../src/core/embeddedSurfaceHub.js";

test("embedded surface leases merge workspace projects and retain shared paths", () => {
  const snapshots: EmbeddedSurfaceProject[][] = [];
  const hub = new EmbeddedSurfaceHub({
    leaseTimeoutMs: 60_000,
    onProjectsChange: (projects) => snapshots.push(projects)
  });
  try {
    hub.upsert({
      surface: "vscode",
      surfaceId: "surface-a",
      leaseId: "lease-a",
      machineId: "machine-local",
      workspacePaths: ["/workspace/a", "/workspace/shared"],
      activeWorkspacePath: "/workspace/a",
      label: "VSCode: A",
      vscodeChannel: "insiders",
      workspaceFile: "/workspace/a.code-workspace"
    });
    hub.upsert({
      surface: "vscode",
      surfaceId: "surface-b",
      leaseId: "lease-b",
      machineId: "machine-local",
      workspacePaths: ["/workspace/shared", "/workspace/b"],
      activeWorkspacePath: "/workspace/b",
      label: "VSCode: B",
      vscodeChannel: "stable",
      workspaceFile: "/workspace/b.code-workspace"
    });

    assert.deepEqual(hub.list().map((surface) => surface.surfaceId), ["surface-a", "surface-b"]);
    assert.deepEqual(
      snapshots.at(-1)?.map((project) => ({
        path: project.path,
        channel: project.source.vscodeChannel,
        workspaceFile: project.source.workspaceFile,
        sources: project.sources.map((source) => `${source.kind}:${source.groupId}`)
      })),
      [
        { path: "/workspace/a", channel: "insiders", workspaceFile: "/workspace/a.code-workspace", sources: ["vscode:surface-a"] },
        { path: "/workspace/b", channel: "stable", workspaceFile: "/workspace/b.code-workspace", sources: ["vscode:surface-b"] },
        { path: "/workspace/shared", channel: "insiders", workspaceFile: undefined, sources: ["vscode:surface-a", "vscode:surface-b"] }
      ]
    );
    const shared = snapshots.at(-1)?.find((project) => project.path === "/workspace/shared");
    assert.equal(shared?.source.workspaceFile, undefined);
    assert.equal(shared?.sources[0]?.workspaceFile, "/workspace/a.code-workspace");
    assert.notEqual(shared?.source, shared?.sources[0]);

    assert.equal(hub.remove("surface-a", "wrong-lease"), false);
    assert.equal(hub.remove("surface-a", "lease-a"), true);
    assert.deepEqual(
      snapshots.at(-1)?.map((project) => ({
        path: project.path,
        channel: project.source.vscodeChannel,
        workspaceFile: project.source.workspaceFile,
        sources: project.sources.map((source) => `${source.kind}:${source.groupId}`)
      })),
      [
        { path: "/workspace/b", channel: "stable", workspaceFile: "/workspace/b.code-workspace", sources: ["vscode:surface-b"] },
        { path: "/workspace/shared", channel: "stable", workspaceFile: "/workspace/b.code-workspace", sources: ["vscode:surface-b"] }
      ]
    );
  } finally {
    hub.stop();
  }
});

test("one machine path retains VSCode and Electron sources together", () => {
  const snapshots: EmbeddedSurfaceProject[][] = [];
  const hub = new EmbeddedSurfaceHub({
    leaseTimeoutMs: 60_000,
    onProjectsChange: (projects) => snapshots.push(projects)
  });
  try {
    hub.upsert({
      surface: "electron",
      surfaceId: "electron-window",
      leaseId: "electron-lease",
      machineId: "machine-local",
      workspacePaths: ["/workspace/shared"],
      label: "Electron"
    });
    hub.upsert({
      surface: "vscode",
      surfaceId: "vscode-window",
      leaseId: "vscode-lease",
      machineId: "machine-local",
      workspacePaths: ["/workspace/shared"],
      label: "VS Code"
    });

    assert.deepEqual(snapshots.at(-1)?.map((project) => ({
      path: project.path,
      source: `${project.source.kind}:${project.source.groupId}`,
      sources: project.sources.map((source) => `${source.kind}:${source.groupId}`)
    })), [{
      path: "/workspace/shared",
      source: "electron:electron-window",
      sources: ["electron:electron-window", "vscode:vscode-window"]
    }]);
    assert.equal(hub.remove("electron-window", "electron-lease"), true);
    assert.deepEqual(snapshots.at(-1)?.[0]?.sources.map((source) => `${source.kind}:${source.groupId}`), ["vscode:vscode-window"]);
  } finally {
    hub.stop();
  }
});

test("a new embedded surface lease supersedes stale unregister and heartbeat calls", () => {
  const hub = new EmbeddedSurfaceHub({
    leaseTimeoutMs: 60_000,
    onProjectsChange: () => undefined
  });
  try {
    hub.upsert({
      surface: "vscode",
      surfaceId: "surface-a",
      leaseId: "old-lease",
      machineId: "machine-local",
      workspacePaths: ["/workspace/a"],
      label: "VSCode: A"
    });
    hub.upsert({
      surface: "vscode",
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

test("expired surface leases only clear transient project state", async () => {
  const snapshots: EmbeddedSurfaceProject[][] = [];
  const hub = new EmbeddedSurfaceHub({
    leaseTimeoutMs: 10,
    onProjectsChange: (projects) => snapshots.push(projects)
  });
  try {
    hub.upsert({
      surface: "vscode",
      surfaceId: "surface-expiring",
      leaseId: "lease-expiring",
      machineId: "machine-local",
      workspacePaths: ["/workspace/expiring"],
      label: "VSCode: Expiring"
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    assert.equal(hub.get("surface-expiring"), null);
    assert.deepEqual(snapshots.at(-1), []);
  } finally {
    hub.stop();
  }
});

test("an old embedded authority reports an update as soon as one surface uses a replacement build", () => {
  const replacements: string[] = [];
  const hub = new EmbeddedSurfaceHub({
    leaseTimeoutMs: 60_000,
    currentBuildId: "build-old",
    onProjectsChange: () => undefined,
    onReplacementBuildAvailable: (buildId) => replacements.push(buildId)
  });
  try {
    hub.upsert({
      surface: "vscode",
      surfaceId: "old-window",
      leaseId: "old-lease",
      machineId: "machine-local",
      workspacePaths: ["/workspace/old"],
      label: "VSCode: Old",
      buildId: "build-old"
    });
    hub.upsert({
      surface: "vscode",
      surfaceId: "new-window",
      leaseId: "new-lease",
      machineId: "machine-local",
      workspacePaths: ["/workspace/new"],
      label: "VSCode: New",
      buildId: "build-new"
    });
    assert.deepEqual(replacements, ["build-new"]);
    assert.equal(hub.get("new-window")?.buildId, "build-new");

    hub.remove("old-window", "old-lease");
    assert.deepEqual(replacements, ["build-new"]);
    hub.touch("new-window", "new-lease");
    assert.deepEqual(replacements, ["build-new"]);
  } finally {
    hub.stop();
  }
});
