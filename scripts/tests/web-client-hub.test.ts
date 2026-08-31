import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultWebClientAuthorityTimeoutMs,
  WebClientHub
} from "../../src/core/webClientHub.js";

test("authority Web client silence timeout is five minutes", () => {
  assert.equal(defaultWebClientAuthorityTimeoutMs, 5 * 60_000);
});

test("Web client heartbeat is the only activity that postpones authority idle", async () => {
  let idleCalls = 0;
  const hub = new WebClientHub({
    timeoutMs: 30,
    retryMs: 10,
    canShutdown: () => true,
    onIdle: () => {
      idleCalls += 1;
    }
  });
  try {
    hub.touch("web-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    hub.touch("web-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(idleCalls, 0);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(idleCalls, 1);
  } finally {
    hub.stop();
  }
});

test("running turns defer Web client idle shutdown until completion", async () => {
  let running = true;
  let idleCalls = 0;
  const hub = new WebClientHub({
    timeoutMs: 15,
    retryMs: 10,
    canShutdown: () => !running,
    onIdle: () => {
      idleCalls += 1;
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(idleCalls, 0);
    running = false;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(idleCalls, 1);
  } finally {
    hub.stop();
  }
});
