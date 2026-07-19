import assert from "node:assert/strict";
import test from "node:test";
import {
  showBrowserTaskCompleteNotification,
  type BrowserTaskNotificationEnvironment
} from "../../src/web/helpers/notifications.js";
import type { TaskCompleteNotification } from "../../src/web/types.js";

const notification: TaskCompleteNotification = {
  title: "Codex task complete",
  body: "Done",
  threadId: "thread-test"
};

test("browser notification uses the Notification constructor when supported", async () => {
  let focused = false;
  let closed = false;
  let created: { title: string; options?: NotificationOptions } | undefined;
  let createdInstance: FakeNotification | undefined;
  class FakeNotification {
    static readonly permission = "granted" as const;
    onclick: ((event: Event) => void) | null = null;

    constructor(title: string, options?: NotificationOptions) {
      created = { title, options };
      createdInstance = this;
    }

    close() {
      closed = true;
    }
  }
  const environment: BrowserTaskNotificationEnvironment = {
    notificationApi: FakeNotification,
    focusWindow: () => {
      focused = true;
    },
    pageUrl: "https://codexhub.example/thread?codexhub_token=secret"
  };

  assert.equal(await showBrowserTaskCompleteNotification(notification, environment), "notification");
  assert.deepEqual(created, {
    title: notification.title,
    options: {
      body: notification.body,
      tag: "codexhub-task-complete:thread-test"
    }
  });
  createdInstance?.onclick?.({} as Event);
  assert.equal(focused, true);
  assert.equal(closed, true);
});

test("browser notification falls back to a service worker when Android rejects the constructor", async () => {
  const shown: Array<{ title: string; options?: NotificationOptions }> = [];
  let registration: { scriptUrl: string; options?: RegistrationOptions } | undefined;
  let workerState: ServiceWorkerState = "activating";
  const stateListeners = new Set<() => void>();
  const worker = {
    get state() {
      return workerState;
    },
    addEventListener: (_type: "statechange", listener: () => void) => stateListeners.add(listener),
    removeEventListener: (_type: "statechange", listener: () => void) => stateListeners.delete(listener)
  };
  const readyRegistration = {
    active: worker,
    showNotification: async (title: string, notificationOptions?: NotificationOptions) => {
      assert.equal(workerState, "activated");
      shown.push({ title, options: notificationOptions });
    }
  };
  class IllegalNotification {
    static readonly permission = "granted" as const;
    onclick: ((event: Event) => void) | null = null;

    constructor() {
      throw new TypeError("Illegal constructor");
    }

    close() {}
  }
  const environment: BrowserTaskNotificationEnvironment = {
    notificationApi: IllegalNotification,
    serviceWorker: {
      ready: Promise.resolve(readyRegistration),
      register: async (scriptUrl, options) => {
        registration = { scriptUrl, options };
        setTimeout(() => {
          workerState = "activated";
          for (const listener of stateListeners) listener();
        }, 0);
        return {
          showNotification: async () => {
            throw new Error("the installing registration must not be used");
          }
        };
      }
    },
    focusWindow: () => undefined,
    pageUrl: "https://codexhub.example/thread?codexhub_token=secret#composer"
  };

  assert.equal(await showBrowserTaskCompleteNotification(notification, environment), "service-worker");
  assert.deepEqual(registration, {
    scriptUrl: "/codexhub-notification-sw.js",
    options: { scope: "/" }
  });
  assert.deepEqual(shown, [{
    title: notification.title,
    options: {
      body: notification.body,
      tag: "codexhub-task-complete:thread-test",
      data: { url: "https://codexhub.example/thread" }
    }
  }]);
});

test("browser notification failures never escape into realtime processing", async () => {
  class IllegalNotification {
    static readonly permission = "granted" as const;
    onclick: ((event: Event) => void) | null = null;

    constructor() {
      throw new TypeError("Illegal constructor");
    }

    close() {}
  }
  const environment: BrowserTaskNotificationEnvironment = {
    notificationApi: IllegalNotification,
    serviceWorker: {
      register: async () => {
        throw new Error("registration failed");
      }
    },
    focusWindow: () => undefined,
    pageUrl: "https://codexhub.example/"
  };

  assert.equal(await showBrowserTaskCompleteNotification(notification, environment), "unavailable");
});
