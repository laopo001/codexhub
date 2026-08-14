import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveEmbeddedAuthorityPort } from "../../src/core/embeddedAuthority.js";

test("embedded authority resolves its shared port from config.yaml", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-config-boundary."));
  try {
    await writeFile(path.join(dataDir, "config.yaml"), [
      "version: 1",
      "env:",
      "  CODEX_HUB_AUTHORITY_PORT: 29876",
      ""
    ].join("\n"));
    assert.equal(await resolveEmbeddedAuthorityPort(dataDir, {}), 29876);
    assert.equal(
      await resolveEmbeddedAuthorityPort(dataDir, { CODEX_HUB_AUTHORITY_PORT: "29877" }),
      29877
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
