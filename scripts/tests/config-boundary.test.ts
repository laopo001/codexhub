import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveEmbeddedAuthorityHost,
  resolveEmbeddedAuthorityPort
} from "../../src/core/embeddedAuthority.js";

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

test("embedded authority resolves its listen host from config.yaml with an explicit loopback default", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-config-boundary."));
  try {
    await writeFile(path.join(dataDir, "config.yaml"), [
      "version: 1",
      "env:",
      "  CODEX_HUB_AUTHORITY_HOST: 0.0.0.0",
      ""
    ].join("\n"));
    assert.equal(await resolveEmbeddedAuthorityHost(dataDir, {}), "0.0.0.0");
    assert.equal(
      await resolveEmbeddedAuthorityHost(dataDir, { CODEX_HUB_AUTHORITY_HOST: "127.0.0.1" }),
      "127.0.0.1"
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("embedded authority rejects an unsafe or unsupported listen host", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-config-boundary."));
  try {
    await writeFile(path.join(dataDir, "config.yaml"), [
      "version: 1",
      "env:",
      "  CODEX_HUB_AUTHORITY_HOST: 192.168.10.100",
      ""
    ].join("\n"));
    await assert.rejects(
      resolveEmbeddedAuthorityHost(dataDir, {}),
      /Invalid CODEX_HUB_AUTHORITY_HOST/
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
