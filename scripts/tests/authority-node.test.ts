import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  minimumAuthorityNodeMajor,
  resolveAuthorityNode
} from "../../src/core/authorityNode.js";

test("authority Node resolver prefers the explicit executable", async () => {
  const runtime = await resolveAuthorityNode({
    CODEX_HUB_AUTHORITY_NODE: process.execPath,
    PATH: ""
  }, process.execPath);

  assert.equal(runtime.command, process.execPath);
  assert.equal(runtime.version, process.version);
  assert.equal(runtime.source, "configured");
});

test("authority Node resolver uses a Node executable on PATH", async () => {
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const pathCandidate = path.join(path.dirname(process.execPath), executable);
  await access(pathCandidate);
  const runtime = await resolveAuthorityNode({ PATH: path.dirname(process.execPath) }, process.execPath);

  assert.equal(runtime.command, pathCandidate);
  assert.equal(runtime.source, "path");
});

test("authority Node resolver falls back to the host runtime when PATH is empty", async () => {
  const runtime = await resolveAuthorityNode({ PATH: "" }, process.execPath);

  assert.equal(runtime.command, process.execPath);
  assert.equal(runtime.version, process.version);
  assert.equal(runtime.source, "host-fallback");
  assert.ok(Number(process.versions.node.split(".")[0]) >= minimumAuthorityNodeMajor);
});

test("authority Node resolver reports a missing explicit executable", async () => {
  await assert.rejects(
    resolveAuthorityNode({ CODEX_HUB_AUTHORITY_NODE: "/definitely/missing/codexhub-node", PATH: "" }, process.execPath),
    /CODEX_HUB_AUTHORITY_NODE was not found/
  );
});
