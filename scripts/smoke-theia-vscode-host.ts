import vm from "node:vm";
import assert from "node:assert/strict";
import { isCodexPathEntryUsableOnPlatform } from "../src/cli/codexAppServerProcess.js";
import { buildWebviewBridgeScript } from "../targets/vscode/src/webviewBridge.js";

const sourceOrigin = "http://127.0.0.1:15173";

assert.equal(isCodexPathEntryUsableOnPlatform("/mnt/c/Users/test/AppData/Roaming/npm", "linux"), false);
assert.equal(isCodexPathEntryUsableOnPlatform("/home/test/.local/share/pnpm/bin", "linux"), true);
assert.equal(isCodexPathEntryUsableOnPlatform("C:\\Users\\test\\AppData\\Roaming\\npm", "win32"), true);

const createHarness = (theiaHost: boolean, permission: NotificationPermission = "granted") => {
  const hostMessages: unknown[] = [];
  const frameMessages: unknown[] = [];
  const notifications: FakeNotification[] = [];
  const windowListeners = new Map<string, (event: Record<string, unknown>) => void>();
  const frameListeners = new Map<string, () => void>();
  let focused = false;
  let permissionRequests = 0;

  const frameWindow = {
    postMessage: (data: unknown, origin: string) => frameMessages.push({ data, origin })
  };
  const frame = {
    contentWindow: frameWindow,
    addEventListener: (type: string, listener: () => void) => frameListeners.set(type, listener)
  };

  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = async () => {
      permissionRequests += 1;
      FakeNotification.permission = "granted";
      return "granted" as NotificationPermission;
    };

    onclick: (() => void) | null = null;
    closed = false;

    constructor(public title: string, public options: NotificationOptions) {
      notifications.push(this);
    }

    close() {
      this.closed = true;
    }
  }

  const context = {
    acquireVsCodeApi: () => ({ postMessage: (data: unknown) => hostMessages.push(data) }),
    document: { getElementById: () => frame },
    window: {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => windowListeners.set(type, listener),
      focus: () => { focused = true; }
    },
    Notification: FakeNotification,
    Promise
  };
  vm.runInNewContext(buildWebviewBridgeScript(sourceOrigin, theiaHost), context);

  return {
    emitFromFrame(data: unknown) {
      windowListeners.get("message")?.({ data, source: frameWindow, origin: sourceOrigin });
    },
    emitFromHost(data: unknown) {
      windowListeners.get("message")?.({ data, source: null, origin: "" });
    },
    loadFrame() {
      frameListeners.get("load")?.();
    },
    hostMessages,
    frameMessages,
    notifications,
    focused: () => focused,
    permissionRequests: () => permissionRequests,
    FakeNotification
  };
};

const theia = createHarness(true);
theia.emitFromFrame({
  type: "codexhub.taskCompleteNotification",
  notification: { title: "Done", body: "Finished", threadId: "thread-1" }
});
assert.equal(theia.notifications.length, 1);
assert.equal(theia.notifications[0]?.title, "Done");
assert.deepEqual(theia.hostMessages, []);
theia.notifications[0]?.onclick?.();
assert.equal(theia.focused(), true);
assert.equal(theia.notifications[0]?.closed, true);
assert.equal(JSON.stringify(theia.hostMessages), JSON.stringify([{
  type: "codexhub.notificationClicked",
  threadId: "thread-1"
}]));

theia.emitFromHost({ type: "codexhub.openThread", threadId: "thread-2" });
assert.equal(theia.frameMessages.length, 0);
theia.loadFrame();
assert.equal(JSON.stringify(theia.frameMessages), JSON.stringify([{
  data: { type: "codexhub.openThread", threadId: "thread-2" },
  origin: sourceOrigin
}]));

const permission = createHarness(true, "default");
permission.emitFromFrame({ type: "codexhub.requestNotificationPermission" });
await Promise.resolve();
assert.equal(permission.permissionRequests(), 1);

const vscodeFallback = createHarness(false);
const fallbackMessage = {
  type: "codexhub.taskCompleteNotification",
  notification: { title: "Done", body: "Finished", threadId: "thread-3" }
};
vscodeFallback.emitFromFrame(fallbackMessage);
assert.equal(vscodeFallback.notifications.length, 0);
assert.equal(JSON.stringify(vscodeFallback.hostMessages), JSON.stringify([fallbackMessage]));

console.error("theia VSIX host notification bridge smoke passed");
