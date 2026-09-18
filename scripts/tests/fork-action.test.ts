import assert from "node:assert/strict";
import test from "node:test";
import { CodexHubApiError } from "../../src/shared/apiClient.js";
import { apiErrorDetails } from "../../src/web/helpers/apiErrors.js";

test("fork errors display the server message without the HTTP transport wrapper", () => {
  assert.deepEqual(
    apiErrorDetails(new CodexHubApiError(504, JSON.stringify({
      error: "codex app-server request timed out after 60000ms: thread/fork"
    }))),
    { message: "codex app-server request timed out after 60000ms: thread/fork" }
  );
});

test("API response errors retain turn delivery metadata for error routing", () => {
  assert.deepEqual(apiErrorDetails(new CodexHubApiError(409, JSON.stringify({
    error: "goal unavailable",
    delivery: "goal"
  }))), {
    message: "goal unavailable",
    delivery: "goal"
  });
});

test("fork errors retain ordinary and non-JSON transport diagnostics", () => {
  assert.deepEqual(apiErrorDetails(new Error("runtime offline")), { message: "runtime offline" });
  assert.deepEqual(apiErrorDetails(new CodexHubApiError(502, "upstream disconnected")), {
    message: "API HTTP 502: upstream disconnected"
  });
});
