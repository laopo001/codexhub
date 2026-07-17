import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertSupportedCodexCliVersion,
  minimumCodexCliVersion,
  parseCodexCliVersion
} from "../../src/cli/codexAppServerProcess.js";
import { codexhubVersion } from "../../src/shared/version.js";

test("Codex CLI versions are parsed and gated against the protocol baseline", () => {
  assert.equal(parseCodexCliVersion("codex-cli 0.144.4"), "0.144.4");
  assert.equal(parseCodexCliVersion("codex_cli_rs/0.145.0 (linux)"), "0.145.0");
  assert.equal(parseCodexCliVersion("codex-cli 0.144.4-alpha.1"), "0.144.4-alpha.1");
  assert.doesNotThrow(() => assertSupportedCodexCliVersion(minimumCodexCliVersion));
  assert.doesNotThrow(() => assertSupportedCodexCliVersion("0.144.5-alpha.1"));
  assert.throws(
    () => assertSupportedCodexCliVersion("0.143.9"),
    /0\.144\.4 or newer.*found 0\.143\.9/
  );
  assert.throws(
    () => assertSupportedCodexCliVersion("0.144.4-alpha.1"),
    /0\.144\.4 or newer.*found 0\.144\.4-alpha\.1/
  );
});

test("app-server clientInfo uses the package manifest version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(codexhubVersion, manifest.version);
});
