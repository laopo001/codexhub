import assert from "node:assert/strict";
import test from "node:test";
import {
  sendElectronTaskCompleteNotification,
  type ElectronTaskNotificationBridge
} from "../../src/web/helpers/notifications.js";
import { isTaskCompleteNotification } from "../../src/shared/taskNotifications.js";

const notification = {
  title: "Codex task complete",
  body: "The task completed.",
  threadId: "thread-electron",
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
  assert.equal(isTaskCompleteNotification(null), false);
});
