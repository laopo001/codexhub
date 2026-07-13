import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { projectSourceSchema } from "../src/shared/apiContract.js";
import { isEmbeddedCodexHubSurface } from "../src/shared/surfaceTypes.js";
import { parseCodexHubHostIncomingMessage } from "../src/web/hostBridge.js";
import {
  codexHubBrowserNotificationOptions,
} from "../targets/theia/src/browser/codexhub-browser-notifications.js";
import {
  CodexHubNativeNotificationServiceImpl,
  type CodexHubNativeNotificationHandle,
  type CodexHubNativeNotificationRuntime,
} from "../targets/theia/src/electron-main/codexhub-native-notification-service.js";

assert.equal(isEmbeddedCodexHubSurface("theia"), true);
assert.deepEqual(projectSourceSchema.parse({ kind: "theia", groupId: "workspace" }), {
  kind: "theia",
  groupId: "workspace",
});
assert.deepEqual(parseCodexHubHostIncomingMessage({ type: "codexhub.openThread", threadId: " thread-1 " }), {
  type: "codexhub.openThread",
  threadId: "thread-1",
});
assert.equal(parseCodexHubHostIncomingMessage({ type: "codexhub.openThread", threadId: "" }), null);

let clickListener: (() => void) | null = null;
let closeListener: (() => void) | null = null;
let failedListener: ((error: string) => void) | null = null;
let notificationShown = false;
let notificationClosed = false;
let resolvedWindowId = 0;
let notificationTimeoutType = "";
const windowActions: string[] = [];
const openedThreads: string[] = [];
const connectionCloseListeners: Array<() => void> = [];
const handle: CodexHubNativeNotificationHandle = {
  close: () => { notificationClosed = true; },
  onClick: (listener) => { clickListener = listener; },
  onClose: (listener) => { closeListener = listener; },
  onFailed: (listener) => { failedListener = listener; },
  show: () => { notificationShown = true; },
};
const runtime: CodexHubNativeNotificationRuntime = {
  create: (options) => {
    notificationTimeoutType = options.timeoutType;
    return handle;
  },
  isSupported: () => true,
  resolveWindow: (windowId) => {
    resolvedWindowId = windowId;
    return {
      focus: () => windowActions.push("focus"),
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => windowActions.push("restore"),
      show: () => windowActions.push("show"),
    };
  },
};
const client = {
  openThread: (threadId: string) => { openedThreads.push(threadId); },
  onDidCloseConnection: (listener: () => void) => {
    connectionCloseListeners.push(listener);
    return { dispose() {} };
  },
} as unknown as ConstructorParameters<typeof CodexHubNativeNotificationServiceImpl>[0];
const service = new CodexHubNativeNotificationServiceImpl(client, runtime);
assert.equal(await service.show({
  windowId: "42",
  notification: { title: "Done", body: "Finished", threadId: "thread-42" },
}), true);
assert.equal(resolvedWindowId, 42);
assert.equal(notificationShown, true);
assert.equal(notificationTimeoutType, "never");
assert.equal(codexHubBrowserNotificationOptions({
  title: "Done",
  body: "Finished",
  threadId: "thread-42",
}).requireInteraction, true);
assert.ok(clickListener);
(clickListener as () => void)();
assert.deepEqual(windowActions, ["restore", "show", "focus"]);
assert.deepEqual(openedThreads, ["thread-42"]);
assert.ok(closeListener);
assert.ok(failedListener);
assert.equal(notificationClosed, false);
connectionCloseListeners[0]?.();

const targetRoot = path.resolve("dist-theia");
const manifest = JSON.parse(await readFile(path.join(targetRoot, "package.json"), "utf8")) as {
  version?: string;
  type?: string;
  theiaExtensions?: Array<Record<string, string>>;
};
assert.equal(manifest.type, "commonjs");
assert.ok(manifest.version);
assert.equal(manifest.theiaExtensions?.length, 2);
for (const extension of manifest.theiaExtensions ?? []) {
  for (const modulePath of Object.values(extension)) {
    await access(path.join(targetRoot, `${modulePath}.js`));
  }
}
await access(path.join(targetRoot, "dist", "index.html"));
await access(path.join(targetRoot, "dist-node", "ssh", "remote-client.cjs"));

console.log(JSON.stringify({
  ok: true,
  nativeClickRoute: { windowId: resolvedWindowId, windowActions, openedThreads },
  targetVersion: manifest.version,
}));
