import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { ThreadStreamEvent, ThreadSummary } from "../../src/shared/threadTypes.js";

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

  const { createRealtimeActions } = await import("../../src/web/appActions/realtimeActions.js");
  const context = {
    appSettingsRef: { current: { selectedPetId: "red-spark", showFloatingPet: false, taskCompleteSystemNotifications: true } },
    closedThreadIds: { current: new Set<string>() },
    notificationAudioContext: { current: null },
    notificationRecordsByThread: { current: new Map<string, CodexRecord[]>() },
    notifiedTaskCompletions: { current: new Set<string>() },
    realtimeThreadSubscriptions: { current: new Set<string>() },
    threadLastSeqs: { current: new Map<string, number>() },
    dispatchOpenThreads: () => calls.push("thread"),
    setThreadOrderBySession: () => calls.push("order"),
    setSessionList: () => calls.push("sessions"),
    setProjects: () => calls.push("projects")
  } as unknown as Parameters<typeof createRealtimeActions>[0];
  const actions = createRealtimeActions(context, {
    clearActiveThreadIfLatest: () => undefined,
    notifyRegisteredMachineConnected: () => undefined,
    notifyRegisteredMachineDisconnected: () => undefined,
    openThread: async () => undefined
  });

  assert.doesNotThrow(() => actions.applyThreadStreamEvent(taskCompleteEvent()));
  assert.deepEqual(calls, ["thread", "order", "sessions", "projects", "notification"]);
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

const threadSummary = (): ThreadSummary => ({
  threadId: "thread-test",
  workingDirectory: "/tmp/codexhub-test",
  session: {
    sessionId: "session-test",
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
