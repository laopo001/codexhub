import assert from "node:assert/strict";
import test from "node:test";
import {
  accountRateLimitsPayloadFromValue,
  appServerThreadRateLimitsFromValue,
  mergeAppServerThreadRateLimits
} from "../../src/core/threadUsage.js";

test("account rate limits select the current codex bucket", () => {
  const codex = {
    limitId: "codex",
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_100_000 }
  };
  const selected = accountRateLimitsPayloadFromValue({
    result: {
      rateLimits: {
        limitId: "codex_other",
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: null
      },
      rateLimitsByLimitId: { codex, codex_other: {} }
    }
  });

  assert.deepEqual(selected, codex);
  assert.deepEqual(appServerThreadRateLimitsFromValue(selected, "2026-07-17T00:00:00.000Z"), {
    primaryRateLimit: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_800_000_000 },
    secondaryRateLimit: { usedPercent: 40, windowMinutes: 10_080, resetsAt: 1_800_100_000 },
    observedAt: "2026-07-17T00:00:00.000Z"
  });
});

test("sparse account rate-limit updates preserve the previous window", () => {
  const previous = {
    primaryRateLimit: { usedPercent: 10, windowMinutes: 300, resetsAt: 1_800_000_000 },
    secondaryRateLimit: { usedPercent: 40, windowMinutes: 10_080, resetsAt: 1_800_100_000 },
    observedAt: "2026-07-17T00:00:00.000Z"
  };

  assert.deepEqual(mergeAppServerThreadRateLimits(previous, {
    primary: { usedPercent: 25, windowDurationMins: null, resetsAt: null },
    secondary: null
  }, "2026-07-17T01:00:00.000Z"), {
    primaryRateLimit: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_800_000_000 },
    secondaryRateLimit: previous.secondaryRateLimit,
    observedAt: "2026-07-17T01:00:00.000Z"
  });
});

test("initial account rate-limit snapshots preserve usage with nullable metadata", () => {
  assert.deepEqual(mergeAppServerThreadRateLimits(null, {
    primary: { usedPercent: 25, windowDurationMins: null, resetsAt: null },
    secondary: null
  }, "2026-07-17T01:00:00.000Z"), {
    primaryRateLimit: { usedPercent: 25, windowMinutes: null, resetsAt: null },
    secondaryRateLimit: null,
    observedAt: "2026-07-17T01:00:00.000Z"
  });
});
