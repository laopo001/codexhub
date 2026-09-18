import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexhubServerState } from "../src/core/serverState.js";

const emptySnapshot = {
  machines: [],
  sessions: [],
  threads: []
};

test("server state preserves sources through stored overlays and cross-kind replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-project-sources."));
  try {
    const state = await CodexhubServerState.load({ filePath: path.join(root, "config.yaml") });
    const vscode = { kind: "vscode" as const, groupId: "vscode-window", label: "VS Code" };
    const electron = { kind: "electron" as const, groupId: "electron-window", label: "Electron" };
    const vscodeUpdated = { ...vscode, label: "VS Code Updated" };
    const electronUpdated = { ...electron, label: "Electron Updated" };

    state.upsertProject({
      machineId: "machine-local",
      path: "/workspace/shared",
      now: "2026-01-01T00:00:00.000Z"
    });
    state.upsertTransientProject({
      machineId: "machine-local",
      path: "/workspace/shared",
      source: vscode,
      sources: [vscode, electron],
      now: "2026-01-02T00:00:00.000Z"
    });
    state.upsertTransientProject({
      machineId: "machine-other",
      path: "/workspace/shared",
      source: vscode,
      sources: [vscode],
      now: "2026-01-02T00:00:00.000Z"
    });

    let projects = state.snapshot(emptySnapshot).projects;
    assert.deepEqual(projects.find((project) => project.machineId === "machine-local")?.sources, [vscode, electron]);

    state.replaceTransientProjectsForMachineSource("machine-local", "vscode", [{
      path: "/workspace/shared",
      source: vscodeUpdated,
      sources: [vscodeUpdated, electron]
    }]);
    projects = state.snapshot(emptySnapshot).projects;
    assert.deepEqual(projects.find((project) => project.machineId === "machine-local")?.sources, [vscodeUpdated, electron]);
    assert.deepEqual(projects.find((project) => project.machineId === "machine-other")?.sources, [vscode]);

    state.replaceTransientProjectsForMachineSource("machine-local", "vscode", []);
    state.replaceTransientProjectsForMachineSource("machine-local", "electron", [{
      path: "/workspace/shared",
      source: electronUpdated,
      sources: [electronUpdated]
    }]);
    projects = state.snapshot(emptySnapshot).projects;
    assert.deepEqual(projects.find((project) => project.machineId === "machine-local")?.sources, [electronUpdated]);

    state.replaceTransientProjectsForMachineSource("machine-local", "electron", []);
    projects = state.snapshot(emptySnapshot).projects;
    assert.equal(projects.some((project) => project.machineId === "machine-local"), true, "stored project remains after transient removal");
    assert.equal(projects.find((project) => project.machineId === "machine-local")?.sources, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
