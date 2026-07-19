import assert from "node:assert/strict";
import test from "node:test";
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
