import assert from "node:assert/strict";
import test from "node:test";
import { createWebClientHeartbeat } from "../../src/web/helpers/webClientHeartbeat.js";

test("Web surface heartbeat coalesces overlapping sends", async () => {
  let resolveSend: (() => void) | undefined;
  let sends = 0;
  const heartbeat = createWebClientHeartbeat({
    send: () => {
      sends += 1;
      return new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
    },
    requestRecovery: () => assert.fail("successful heartbeat must not request recovery")
  });

  const first = heartbeat.beat();
  await heartbeat.beat();
  assert.equal(sends, 1);
  resolveSend?.();
  await first;
});

test("Web surface heartbeat waits for consecutive failures before asking its host to recover", async () => {
  let recoveries = 0;
  const heartbeat = createWebClientHeartbeat({
    send: async () => {
      throw new Error("lease missing");
    },
    requestRecovery: () => {
      recoveries += 1;
    }
  });

  await heartbeat.beat();
  await heartbeat.beat();
  assert.equal(recoveries, 0);
  await heartbeat.beat();
  assert.equal(recoveries, 1);
  await heartbeat.beat();
  assert.equal(recoveries, 1);
});

test("Web surface heartbeat resets its recovery threshold after a success", async () => {
  let shouldFail = true;
  let recoveries = 0;
  const heartbeat = createWebClientHeartbeat({
    send: async () => {
      if (shouldFail) throw new Error("temporary interruption");
    },
    requestRecovery: () => {
      recoveries += 1;
    },
    failuresBeforeRecovery: 2
  });

  await heartbeat.beat();
  shouldFail = false;
  await heartbeat.beat();
  shouldFail = true;
  await heartbeat.beat();
  assert.equal(recoveries, 0);
  await heartbeat.beat();
  assert.equal(recoveries, 1);
});

test("Web surface heartbeat retries recovery after a throwing recovery callback", async () => {
  let recoveries = 0;
  const heartbeat = createWebClientHeartbeat({
    send: async () => {
      throw new Error("lease missing");
    },
    requestRecovery: () => {
      recoveries += 1;
      throw new Error("host recovery failed");
    },
    failuresBeforeRecovery: 2
  });

  await heartbeat.beat();
  await heartbeat.beat();
  await heartbeat.beat();
  await heartbeat.beat();
  assert.equal(recoveries, 2);
});
