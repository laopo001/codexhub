import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../src/core/threadUsage.js";
import type { CodexRecord } from "../src/shared/recordTypes.js";
import type { ThreadStreamEvent, ThreadSummary } from "../src/shared/threadTypes.js";
import type { ProjectSummary } from "../src/web/types.js";

test("thread state is merged before a browser completion notification is attempted", async () => {
  const calls: string[] = [];
  class IllegalNotification {
    static readonly permission = "granted" as const;
    onclick: ((event: Event) => void) | null = null;

    constructor() {
      calls.push("notification");
      throw new TypeError("Illegal constructor");
    }

    close() {}
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: "https://codexhub.example/", search: "" },
      Notification: IllegalNotification,
      focus: () => undefined,
      parent: undefined
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        register: async () => {
          throw new Error("registration failed");
        }
      }
    }
  });

  const { createRealtimeActions } = await import("../src/web/appActions/realtimeActions.js");
  const project: ProjectSummary = {
    projectId: "project-test",
    machineId: "session-test",
    path: "/tmp/codexhub-test",
    name: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    machineOnline: true,
    running: false
  };
  let projectState = [project];
  const context = {
    appSettingsRef: { current: { selectedPetId: "red-spark", showFloatingPet: false, showDesktopPet: false, taskCompleteSystemNotifications: true } },
    closedThreadIds: { current: new Set<string>() },
    notificationAudioContext: { current: null },
    notificationRecordsByThread: { current: new Map<string, CodexRecord[]>() },
    notifiedTaskCompletions: { current: new Set<string>() },
    openThreadIdsRef: { current: new Set(["thread-test"]) },
    realtimeThreadSubscriptions: { current: new Set<string>() },
    threadLastSeqs: { current: new Map<string, number>() },
    dispatchOpenThreads: () => undefined,
    dispatchConversationThread: () => calls.push("thread"),
    setThreadOrderByMachine: () => calls.push("order"),
    threadProjectTargetsRef: { current: {} },
    setThreadProjectTargets: () => undefined,
    setRuntimeList: () => calls.push("runtimes"),
    setProjects: (update: (current: typeof projectState) => typeof projectState) => {
      projectState = update(projectState);
      calls.push("projects");
    }
  } as unknown as Parameters<typeof createRealtimeActions>[0];
  const actions = createRealtimeActions(context, {
    clearActiveThreadIfLatest: () => undefined,
    notifyRegisteredMachineConnected: () => undefined,
    notifyRegisteredMachineDisconnected: () => undefined,
    onThreadCompleted: (completionKey) => calls.push(`pet:${completionKey}`),
    openThread: async () => undefined
  });

  assert.doesNotThrow(() => actions.applyThreadStreamEvent(taskCompleteEvent()));
  assert.deepEqual(calls, [
    "thread",
    "order",
    "runtimes",
    "projects",
    "pet:thread-test:turn-test",
    "notification",
  ]);

  assert.equal(projectState[0]?.lastThreadId, undefined);
  context.threadProjectTargetsRef.current = {
    "thread-test": { machineId: "session-test", path: "/tmp/codexhub-test" }
  };
  calls.length = 0;
  actions.applyThreadStreamEvent({ ...turnAbortedEvent(), seq: 7 });
  assert.equal(projectState[0]?.lastThreadId, "thread-test");

  calls.length = 0;
  assert.doesNotThrow(() => actions.applyThreadStreamEvent({
    ...taskCompleteEvent(),
    seq: 3,
    historical: true,
  }));
  assert.deepEqual(calls, ["thread", "order", "runtimes", "projects"]);

  calls.length = 0;
  assert.doesNotThrow(() => actions.applyThreadStreamEvent(turnAbortedEvent()));
  assert.deepEqual(calls, ["thread", "order", "runtimes", "projects"]);

  context.notificationRecordsByThread.current.set("thread-test", [
    {
      id: "app:thread-test:turn-new:user:user-message",
      timestamp: "2026-07-19T00:00:03.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "newest input" }
    }
  ]);
  calls.length = 0;
  assert.doesNotThrow(() => actions.applyThreadStreamEvent({
    ...taskCompleteEvent(),
    seq: 6
  }));
  assert.deepEqual(
    calls,
    ["thread", "order", "runtimes", "projects", "pet:thread-test:turn-test"],
    "a stale completion remains in the thread and pet lifecycle, but does not show a task notification"
  );

  context.openThreadIdsRef.current.clear();
  calls.length = 0;
  assert.doesNotThrow(() => actions.applyThreadStreamEvent({
    ...turnAbortedEvent(),
    seq: 5,
    historical: true
  }));
  assert.deepEqual(calls, ["thread", "runtimes"], "dialog-only child events must not change workspace ordering or project selection");
});

const taskCompleteEvent = (): ThreadStreamEvent => ({
  seq: 2,
  threadId: "thread-test",
  kind: "record",
  thread: threadSummary(),
  record: {
    id: "app:thread-test:turn-test:event:task_complete",
    timestamp: "2026-07-19T00:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "turn-test",
      duration_ms: 2000
    }
  }
});

const turnAbortedEvent = (): ThreadStreamEvent => ({
  seq: 4,
  threadId: "thread-test",
  kind: "record",
  thread: threadSummary(),
  record: {
    id: "app:thread-test:turn-failed:event:turn_aborted",
    timestamp: "2026-07-19T00:00:03.000Z",
    type: "event_msg",
    payload: {
      type: "turn_aborted",
      turn_id: "turn-failed",
      status: "failed",
      reason: "quota exhausted",
      duration_ms: 1000
    }
  }
});

const threadSummary = (): ThreadSummary => ({
  threadId: "thread-test",
  workingDirectory: "/tmp/codexhub-test",
  runtime: {
    machineId: "session-test",
    online: true,
    runnable: true
  },
  status: "idle",
  running: false,
  title: "Notification regression",
  updatedAt: "2026-07-19T00:00:02.000Z",
  messageCount: 1,
  threadUsage: emptyThreadUsage()
});
