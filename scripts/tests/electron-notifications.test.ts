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
  taskCompleteNotification,
  taskCompleteNotificationOpenTarget,
  taskCompleteRecordIsForLatestUserInput,
  taskCompleteNotificationShouldPersist,
  taskCompleteNotificationTitle
} from "../../src/shared/taskNotifications.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { ThreadSummary } from "../../src/shared/threadTypes.js";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";

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
  assert.equal(isTaskCompleteNotification({ ...notification, durationMs: -1 }), false);
  assert.equal(isTaskCompleteNotification({ ...notification, persistent: "yes" }), false);
  assert.equal(isTaskCompleteNotification(null), false);
});

test("notification persistence uses zero for all or a runtime threshold in minutes", () => {
  assert.equal(taskCompleteNotificationShouldPersist({}, 0), true);
  assert.equal(taskCompleteNotificationShouldPersist({}, 3), false);
  assert.equal(taskCompleteNotificationShouldPersist({ durationMs: 179_999 }, 3), false);
  assert.equal(taskCompleteNotificationShouldPersist({ durationMs: 180_000 }, 3), true);
  assert.equal(taskCompleteNotificationShouldPersist({ durationMs: 600_000 }, 5), true);
});

test("task completion notification title is shared across hosts and focuses on activity title", () => {
  assert.equal(
    taskCompleteNotificationTitle(notification),
    "Codex 任务完成"
  );
});

test("task completion notification title follows the latest Activity title and includes formatted source context in body", () => {
  const thread: ThreadSummary = {
    threadId: "thread-activity-title",
    workingDirectory: "/tmp/codexhub-title",
    runtime: { machineId: "machine-title", online: true, runnable: true },
    status: "idle",
    running: false,
    title: "thread-activity-title",
    activityTitle: "检查 ntfy 通知",
    updatedAt: "2026-08-18T00:00:03.000Z",
    messageCount: 2,
    threadUsage: emptyThreadUsage()
  };
  const records: CodexRecord[] = [
    {
      id: "app:thread-activity-title:turn-title:user:message",
      timestamp: "2026-08-18T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "检查 ntfy 通知" }
    },
    {
      id: "app:thread-activity-title:turn-title:agent:message",
      timestamp: "2026-08-18T00:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", phase: "final_answer", message: "已修复" }
    },
    {
      id: "app:thread-activity-title:turn-title:event:task_complete",
      timestamp: "2026-08-18T00:00:03.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-title", duration_ms: 2000 }
    }
  ];
  const notificationWithoutSource = taskCompleteNotification(thread, records[2], records);
  assert.equal(notificationWithoutSource.title, "检查 ntfy 通知");
  assert.equal(notificationWithoutSource.body, "codexhub-title\n已完成 · 用时 2.0s · 已修复");

  const notificationWithLocal = taskCompleteNotification(thread, records[2], records, {
    machine: { type: "local", hostname: "jx" }
  });
  assert.equal(notificationWithLocal.body, "Local · codexhub-title\n已完成 · 用时 2.0s · 已修复");

  const notificationWithInsiders = taskCompleteNotification(thread, records[2], records, {
    source: { kind: "vscode", groupId: "vscode-window-1", vscodeChannel: "insiders" }
  });
  assert.equal(notificationWithInsiders.title, "检查 ntfy 通知");
  assert.equal(notificationWithInsiders.body, "VS Code Insiders · codexhub-title\n已完成 · 用时 2.0s · 已修复");
  assert.equal(notificationWithInsiders.source?.kind, "vscode");
  assert.equal(notificationWithInsiders.source?.vscodeChannel, "insiders");
  const explicitTargets = taskCompleteNotification(thread, records[2], records, {
    machineId: "machine-title",
    projectPath: "/repo/a",
    projectTarget: { machineId: "machine-title", path: "/repo/a" },
    workspaceTarget: {
      machineId: "machine-title",
      kind: "electron",
      groupId: "electron-main",
      workspacePaths: ["/repo/a"]
    }
  });
  assert.deepEqual(taskCompleteNotificationOpenTarget(explicitTargets).projectTarget, {
    machineId: "machine-title",
    path: "/repo/a"
  });
  assert.equal(taskCompleteNotificationOpenTarget(explicitTargets).workspaceTarget?.kind, "electron");
});

test("task completion notification follows the latest user input turn", () => {
  const staleCompletion: CodexRecord = {
    id: "app:thread-test:turn-old:event:task_complete",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-old" }
  };
  const latestUserInput: CodexRecord = {
    id: "app:thread-test:turn-new:user:user-message",
    type: "event_msg",
    payload: { type: "user_message", message: "newest input" }
  };
  const latestCompletion: CodexRecord = {
    id: "app:thread-test:turn-new:event:task_complete",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-new" }
  };

  assert.equal(taskCompleteRecordIsForLatestUserInput(staleCompletion, [staleCompletion, latestUserInput]), false);
  assert.equal(taskCompleteRecordIsForLatestUserInput(latestCompletion, [latestUserInput, latestCompletion]), true);
  assert.equal(
    taskCompleteRecordIsForLatestUserInput(staleCompletion, [staleCompletion], { activeTurnId: "turn-new" }),
    false
  );
  assert.equal(
    taskCompleteRecordIsForLatestUserInput(staleCompletion, [staleCompletion, latestUserInput], { activeTurnId: "turn-new" }),
    false
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

test("notification with vscode source preserves full target routing metadata", () => {
  const fullNotification = {
    title: "测试任务",
    body: "VS Code Insiders · codexhub · 已完成",
    threadId: "thread-vscode-click",
    machineId: "machine-jx",
    machineHostname: "jx",
    projectPath: "/home/laop/projects/codexhub",
    workingDirectory: "/home/laop/projects/codexhub",
    source: {
      kind: "vscode" as const,
      groupId: "vscode-window-1",
      label: "VS Code Insiders: codexhub [WSL: Ubuntu]",
      vscodeChannel: "insiders" as const
    },
    projectTarget: { machineId: "machine-jx", path: "/home/laop/projects/codexhub" },
    workspaceTarget: {
      machineId: "machine-jx",
      kind: "vscode" as const,
      groupId: "vscode-window-1",
      workspacePaths: ["/home/laop/projects/codexhub"],
      vscodeChannel: "insiders" as const
    },
    machineLabel: "codexhub · WSL Ubuntu · jx"
  };

  assert.equal(isTaskCompleteNotification(fullNotification), true);
  assert.equal(isTaskCompleteNotification({ ...fullNotification, machineHostname: "" }), false);
  assert.deepEqual(taskCompleteNotificationOpenTarget(fullNotification), {
    threadId: "thread-vscode-click",
    machineId: "machine-jx",
    machineHostname: "jx",
    projectPath: "/home/laop/projects/codexhub",
    workingDirectory: "/home/laop/projects/codexhub",
    source: fullNotification.source,
    projectTarget: fullNotification.projectTarget,
    workspaceTarget: fullNotification.workspaceTarget
  });
  assert.equal(isTaskCompleteNotification({
    ...fullNotification,
    projectTarget: { machineId: "other-machine", path: fullNotification.projectPath }
  }), false);
  assert.equal(isTaskCompleteNotification({
    ...fullNotification,
    workspaceTarget: { ...fullNotification.workspaceTarget, machineId: "other-machine" }
  }), false);
});
