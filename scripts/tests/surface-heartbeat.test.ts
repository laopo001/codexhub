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

test("Web surface heartbeat asks its host to recover after failure", async () => {
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
  assert.equal(recoveries, 1);
});
