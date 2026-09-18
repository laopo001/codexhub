import assert from "node:assert/strict";
import test from "node:test";

let storedValue: string | null = null;
const windowFixture: Record<string, unknown> = {
  location: { search: "" },
  localStorage: {
    getItem: () => storedValue,
    setItem: (_key: string, value: string) => { storedValue = value; }
  },
  sessionStorage: {
    getItem: () => null,
    setItem: () => undefined
  }
};
windowFixture.parent = windowFixture;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: windowFixture
});

const { readStoredUiState } = await import("../src/web/helpers/composer.js");

test("legacy unversioned UI state keeps preferences but drops tab recovery", () => {
  storedValue = JSON.stringify({
    activeWorkspacePath: "/repo",
    openThreadIds: ["stale-thread"],
    activeTabThreadId: "stale-thread",
    activeTabThreadByMachine: { machine: "stale-thread" },
    threadOrderByMachine: { machine: ["stale-thread"] },
    openThreadTargets: {
      "stale-thread": { machineId: "machine", workingDirectory: "/repo" }
    },
    sidebarCollapsed: true
  });

  assert.deepEqual(readStoredUiState(), {
    activeWorkspacePath: "/repo",
    activeMachineId: undefined,
    activeTabThreadId: undefined,
    activeTabThreadByMachine: undefined,
    openThreadIds: undefined,
    openThreadTargets: undefined,
    threadOrderByMachine: undefined,
    selectedProjectKey: undefined,
    projectSearch: undefined,
    settings: undefined,
    sidebarCollapsed: true,
    collapsedProjectMachineKeys: undefined
  });
});

test("v1 exact tab snapshot remains compatible and parses optional project origin", () => {
  storedValue = JSON.stringify({
    tabSnapshotVersion: 1,
    activeWorkspacePath: "/repo",
    activeTabThreadId: "open-thread",
    openThreadIds: ["open-thread"],
    openThreadTargets: {
      "open-thread": {
        machineId: "machine",
        workingDirectory: "/workspace-root",
        projectTarget: { machineId: "machine", path: "/repo" }
      }
    }
  });

  const stored = readStoredUiState();
  assert.equal(stored?.activeTabThreadId, "open-thread");
  assert.deepEqual(stored?.openThreadIds, ["open-thread"]);
  assert.deepEqual(stored?.openThreadTargets, {
    "open-thread": {
      machineId: "machine",
      workingDirectory: "/workspace-root",
      projectTarget: { machineId: "machine", path: "/repo" }
    }
  });
});

test("stored UI state preserves autoGenerateThreadTitle setting", () => {
  storedValue = JSON.stringify({
    tabSnapshotVersion: 1,
    settings: {
      autoGenerateThreadTitle: true,
      taskCompleteSystemNotifications: false
    }
  });

  const stored = readStoredUiState();
  assert.equal(stored?.settings?.autoGenerateThreadTitle, true);
  assert.equal(stored?.settings?.taskCompleteSystemNotifications, false);
});

test("stored project origin is unresolved when its machine differs from the tab machine", () => {
  storedValue = JSON.stringify({
    tabSnapshotVersion: 1,
    openThreadIds: ["thread"],
    openThreadTargets: {
      thread: {
        machineId: "machine-a",
        projectTarget: { machineId: "machine-b", path: "/repo" }
      }
    }
  });
  assert.deepEqual(readStoredUiState()?.openThreadTargets, {
    thread: { machineId: "machine-a" }
  });
});
