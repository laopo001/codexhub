import assert from "node:assert/strict";
import test from "node:test";
import { CodexHubApiError } from "../../src/shared/apiClient.js";
import { forkErrorMessage } from "../../src/web/helpers/apiErrors.js";

test("fork errors display the server message without the HTTP transport wrapper", () => {
  assert.equal(
    forkErrorMessage(new CodexHubApiError(504, JSON.stringify({
      error: "codex app-server request timed out after 60000ms: thread/fork"
    }))),
    "codex app-server request timed out after 60000ms: thread/fork"
  );
});

test("fork errors retain ordinary and non-JSON transport diagnostics", () => {
  assert.equal(forkErrorMessage(new Error("runtime offline")), "runtime offline");
  assert.equal(
    forkErrorMessage(new CodexHubApiError(502, "upstream disconnected")),
    "API HTTP 502: upstream disconnected"
  );
});
