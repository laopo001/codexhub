import assert from "node:assert/strict";
import test from "node:test";
import {
  claimPendingThreadRestoreAttempt,
  mergeThreadRestoreTarget,
  pendingThreadRestoreOpenOptions,
  removePendingThreadRestoreTarget,
  selectPendingThreadRestoreTargets
} from "../src/web/helpers/pendingThreadRestore.js";

test("loaded detail keeps its execution fields while saved origin survives", () => {
  assert.deepEqual(mergeThreadRestoreTarget(
    { machineId: "machine-a", workingDirectory: "/workspace/root" },
    {
      machineId: "machine-a",
      workingDirectory: "/stale-cwd",
      projectTarget: { machineId: "machine-a", path: "/repo/a" }
    }
  ), {
    machineId: "machine-a",
    workingDirectory: "/workspace/root",
    projectTarget: { machineId: "machine-a", path: "/repo/a" }
  });
});

test("pending restore targets retain only explicitly persisted thread targets", () => {
  const savedTargets = {
    active: { machineId: "machine-local", workingDirectory: "/workspace/a" },
    inactive: { machineId: "machine-local", workingDirectory: "/workspace/b" },
    historical: { machineId: "machine-local", workingDirectory: "/workspace/history" }
  };

  const pendingTargets = selectPendingThreadRestoreTargets(
    ["active", "inactive", "missing"],
    savedTargets
  );

  assert.deepEqual(pendingTargets, {
    active: savedTargets.active,
    inactive: savedTargets.inactive
  });
  assert.equal("historical" in pendingTargets, false);

  const overwrittenStorageTargets = {};
  assert.deepEqual(overwrittenStorageTargets, {});
  assert.deepEqual(pendingTargets, {
    active: savedTargets.active,
    inactive: savedTargets.inactive
  });
});

test("pending restore options preserve exact targets without stealing focus", () => {
  const targets = {
    active: {
      machineId: "machine-local",
      workingDirectory: "/workspace/a",
      projectTarget: { machineId: "machine-local", path: "/repo/a" }
    },
    inactive: {
      machineId: "machine-remote",
      workingDirectory: "/workspace/b",
      projectTarget: { machineId: "machine-remote", path: "/repo/b" }
    }
  };

  assert.deepEqual(pendingThreadRestoreOpenOptions({
    threadId: "active",
    activeThreadId: "active",
    hasActiveThread: false,
    targets
  }), {
    deferActivationUntilLoaded: true,
    expectedMachineId: "machine-local",
    preferredWorkingDirectory: "/workspace/a",
    projectTarget: { machineId: "machine-local", path: "/repo/a" }
  });

  assert.deepEqual(pendingThreadRestoreOpenOptions({
    threadId: "inactive",
    activeThreadId: "active",
    hasActiveThread: false,
    targets
  }), {
    activate: false,
    expectedMachineId: "machine-remote",
    preferredWorkingDirectory: "/workspace/b",
    projectTarget: { machineId: "machine-remote", path: "/repo/b" }
  });

  assert.deepEqual(pendingThreadRestoreOpenOptions({
    threadId: "active",
    activeThreadId: "active",
    hasActiveThread: true,
    targets
  }), {
    activate: false,
    expectedMachineId: "machine-local",
    preferredWorkingDirectory: "/workspace/a",
    projectTarget: { machineId: "machine-local", path: "/repo/a" }
  });
});

test("pending restore cleanup removes only the successful target", () => {
  const targets = {
    restored: { machineId: "machine-local", workingDirectory: "/workspace/a" },
    waiting: { machineId: "machine-remote", workingDirectory: "/workspace/b" }
  };

  const remaining = removePendingThreadRestoreTarget(targets, "restored");
  assert.deepEqual(remaining, { waiting: targets.waiting });
  assert.deepEqual(targets, {
    restored: { machineId: "machine-local", workingDirectory: "/workspace/a" },
    waiting: { machineId: "machine-remote", workingDirectory: "/workspace/b" }
  });
  assert.equal(removePendingThreadRestoreTarget(remaining, "unknown"), remaining);
});

test("pending restore attempt limits survive effect restarts and remain thread-local", () => {
  let attempts = {};
  for (let index = 0; index < 10; index += 1) {
    const claimed = claimPendingThreadRestoreAttempt(attempts, "waiting", 10);
    assert.ok(claimed);
    attempts = claimed;
  }

  assert.equal(claimPendingThreadRestoreAttempt(attempts, "waiting", 10), undefined);
  assert.deepEqual(claimPendingThreadRestoreAttempt(attempts, "other", 10), {
    waiting: 10,
    other: 1
  });
});

test("pending restore refuses a project target from another machine", () => {
  assert.deepEqual(pendingThreadRestoreOpenOptions({
    threadId: "thread",
    activeThreadId: "",
    hasActiveThread: true,
    targets: {
      thread: {
        machineId: "machine-a",
        workingDirectory: "/workspace/root",
        projectTarget: { machineId: "machine-b", path: "/repo" }
      }
    }
  }), {
    activate: false,
    expectedMachineId: "machine-a",
    preferredWorkingDirectory: "/workspace/root"
  });
});
