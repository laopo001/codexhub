import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shared Web exclusively owns authority heartbeat while surfaces only own projection", async () => {
  const [webEffects, vscodeExtension, vscodeBridge, electronMain, electronPreload, surfaceHub, server] = await Promise.all([
    readFile(new URL("../../src/web/appEffects.ts", import.meta.url), "utf8"),
    readFile(new URL("../../targets/vscode/src/extension.ts", import.meta.url), "utf8"),
    readFile(new URL("../../targets/vscode/src/webviewBridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../../targets/electron/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../../targets/electron/src/preload.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/core/embeddedSurfaceHub.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/server/index.ts", import.meta.url), "utf8")
  ]);

  assert.match(webEffects, /apiRoutes\.heartbeatWebClient/);
  assert.doesNotMatch(webEffects, /pre-WebClientHub authority/);
  assert.doesNotMatch(webEffects, /embedded\/surfaces\/.*heartbeat/);
  assert.match(webEffects, /visibilitychange/);
  assert.match(webEffects, /codexhub\.recoverSurface/);
  assert.doesNotMatch(vscodeExtension, /heartbeatEmbeddedSurface|surfaceHeartbeatMs|heartbeatTimer/);
  assert.match(vscodeExtension, /surfaceLeaseId/);
  assert.match(vscodeBridge, /codexhub\.recoverSurface/);
  assert.doesNotMatch(electronMain, /heartbeatEmbeddedSurface|surfaceHeartbeatMs|heartbeatTimer/);
  assert.match(electronMain, /surfaceLeaseId/);
  assert.match(electronPreload, /codexhub:recover-surface/);
  assert.doesNotMatch(surfaceHub, /onIdle|canIdleShutdown|idleShutdown/);
  assert.match(server, /new WebClientHub/);
});
