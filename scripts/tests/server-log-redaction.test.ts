import assert from "node:assert/strict";
import test from "node:test";
import { redactRequestUrlForLog } from "../../src/server/index.js";

test("server request logs redact CodexHub query tokens without dropping routing parameters", () => {
  const redacted = redactRequestUrlForLog(
    "/api/events/ws?surface=vscode&codexhub_token=top-secret&workspacePath=%2Ftmp"
  );
  assert.equal(redacted?.includes("top-secret"), false);
  assert.equal(redacted?.includes("codexhub_token=%5BREDACTED%5D"), true);
  assert.equal(redacted?.includes("surface=vscode"), true);
  assert.equal(redacted?.includes("workspacePath=%2Ftmp"), true);
  assert.equal(redactRequestUrlForLog("/api/health"), "/api/health");

  const encoded = redactRequestUrlForLog(
    "/api/events/ws?codexhub%5ftoken=encoded-secret&CODEXHUB_TOKEN=upper-secret"
  );
  assert.equal(encoded?.includes("encoded-secret"), false);
  assert.equal(encoded?.includes("upper-secret"), false);
  assert.equal(encoded?.match(/%5BREDACTED%5D/g)?.length, 2);

  const wholeQueryEncoded = redactRequestUrlForLog(
    "/?codexhub_token%3Dlive-secret%26surface%3Dvscode%26workspacePath%3D%252Ftmp"
  );
  assert.equal(wholeQueryEncoded?.includes("live-secret"), false);
  assert.equal(wholeQueryEncoded?.includes("codexhub_token=%5BREDACTED%5D"), true);
  assert.equal(wholeQueryEncoded?.includes("surface=vscode"), true);
  assert.equal(wholeQueryEncoded?.includes("workspacePath=%2Ftmp"), true);
});
