import assert from "node:assert/strict";
import test from "node:test";
import { applyServerConfigEnv } from "../../src/core/serverConfigEnv.js";
import { readBooleanEnv, readNonNegativeNumberEnv, readPositiveIntEnv } from "../../src/shared/env.js";

test("shared environment readers preserve their explicit value domains", () => {
  const env = {
    POSITIVE: "42",
    ZERO: "0",
    NEGATIVE: "-1",
    ENABLED: "yes",
    DISABLED: "off",
    INVALID: "maybe"
  };

  assert.equal(readPositiveIntEnv(env, "POSITIVE", 10), 42);
  assert.equal(readPositiveIntEnv(env, "ZERO", 10), 10);
  assert.equal(readNonNegativeNumberEnv(env, "ZERO", 10), 0);
  assert.equal(readNonNegativeNumberEnv(env, "NEGATIVE", 10), 10);
  assert.equal(readBooleanEnv(env, "ENABLED", false), true);
  assert.equal(readBooleanEnv(env, "DISABLED", true), false);
  assert.equal(readBooleanEnv(env, "INVALID", true), true);
  assert.equal(readBooleanEnv(env, "MISSING", false), false);
});

test("config.yaml env values only fill missing process values", () => {
  const env: NodeJS.ProcessEnv = {
    CODEX_HUB_HOST: "127.0.0.1",
    CODEX_HUB_EMPTY: ""
  };
  applyServerConfigEnv({
    CODEX_HUB_HOST: "0.0.0.0",
    CODEX_HUB_PORT: "8788",
    CODEX_HUB_EMPTY: "from-config"
  }, env);
  assert.deepEqual(env, {
    CODEX_HUB_HOST: "127.0.0.1",
    CODEX_HUB_PORT: "8788",
    CODEX_HUB_EMPTY: ""
  });
});
