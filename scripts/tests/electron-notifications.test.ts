import assert from "node:assert/strict";
import test from "node:test";
import {
  collectRegisteredMachineActivityCompletions,
  machineNotificationLabel,
  sendElectronTaskCompleteNotification,
  type ElectronTaskNotificationBridge
} from "../../src/web/helpers/notifications.js";
import {
  isTaskCompleteNotification,
  taskCompleteNotificationTitle
} from "../../src/shared/taskNotifications.js";

const notification = {
  title: "Codex 任务完成",
  body: "项目检查 · 已完成",
  threadId: "thread-electron",
  machineLabel: "codexhub · WSL Ubuntu · jx",
  duration: "2.0s"
};

test("Electron task completion bridge forwards the complete notification payload", () => {
  const received: unknown[] = [];
  const bridge: ElectronTaskNotificationBridge = {
    showTaskCompleteNotification: (value) => received.push(value)
  };

  assert.equal(sendElectronTaskCompleteNotification(notification, bridge), "notification");
  assert.deepEqual(received, [notification]);
});

test("Electron task completion bridge isolates unavailable or failing hosts", () => {
  assert.equal(sendElectronTaskCompleteNotification(notification), "unavailable");
  assert.equal(
    sendElectronTaskCompleteNotification(notification, {
      showTaskCompleteNotification: () => {
        throw new Error("host unavailable");
      }
    }),
    "unavailable"
  );
});

test("task completion notification payload validation accepts only usable IPC data", () => {
  assert.equal(isTaskCompleteNotification(notification), true);
  assert.equal(isTaskCompleteNotification({ ...notification, title: "" }), false);
  assert.equal(isTaskCompleteNotification({ ...notification, body: 42 }), false);
  assert.equal(isTaskCompleteNotification({ ...notification, threadId: "" }), false);
  assert.equal(isTaskCompleteNotification({ ...notification, duration: 2000 }), false);
  assert.equal(isTaskCompleteNotification({ ...notification, machineLabel: 42 }), false);
  assert.equal(isTaskCompleteNotification(null), false);
});

test("task completion notification title is shared across hosts", () => {
  assert.equal(
    taskCompleteNotificationTitle(notification),
    "Codex 任务完成 · codexhub · WSL Ubuntu · jx"
  );
});

test("registered machine activity transitions produce one completion candidate", () => {
  const machine = {
    machineId: "machine-remote",
    type: "registered" as const,
    hostname: "remote-host",
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-08-16T00:00:00.000Z",
    capabilities: { projectLauncher: true },
    activities: [{
      threadId: "thread-remote",
      title: "Remote task",
      workingDirectory: "C:/remote/project",
      updatedAt: "2026-08-16T00:00:00.000Z",
      status: "running" as const
    }]
  };
  const initial = collectRegisteredMachineActivityCompletions(new Map(), [machine]);
  assert.deepEqual(initial.completed, []);

  const completed = collectRegisteredMachineActivityCompletions(initial.next, [{
    ...machine,
    activities: [{ ...machine.activities[0], status: "idle", updatedAt: "2026-08-16T00:00:01.000Z" }]
  }]);
  assert.equal(completed.completed.length, 1);
  assert.equal(completed.completed[0]?.activity.threadId, "thread-remote");

  const unchanged = collectRegisteredMachineActivityCompletions(completed.next, [{
    ...machine,
    activities: [{ ...machine.activities[0], status: "idle", updatedAt: "2026-08-16T00:00:02.000Z" }]
  }]);
  assert.deepEqual(unchanged.completed, []);
});

test("registered machine notification labels match the activity tray context", () => {
  assert.equal(
    machineNotificationLabel({
      machineId: "machine-remote",
      type: "registered",
      name: "CodexHub Authority · WSL Ubuntu · jx",
      hostname: "jx",
      online: true,
      status: "online",
      lastSeenAt: "2026-08-16T00:00:00.000Z",
      capabilities: { projectLauncher: true }
    }, "/home/laop/projects/codexhub"),
    "codexhub · WSL Ubuntu · jx"
  );
});
