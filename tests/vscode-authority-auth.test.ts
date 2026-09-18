import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorityServiceAuthToken,
  configuredVscodeAuthorityAuthToken,
  removeLegacyVscodeAuthorityTokenFile,
  vscodeAuthorityAuthTokenEnvName
} from "../targets/vscode/src/authorityAuth.js";

test("VSCode authority authentication is disabled when no token was explicitly configured", () => {
  assert.equal(configuredVscodeAuthorityAuthToken({}, undefined), "");
  assert.equal(authorityServiceAuthToken(undefined, {
    CODEX_HUB_AUTH_TOKEN: "legacy-generated-token"
  }), "");
});

test("VSCode authority authentication can be explicitly enabled from config or process env", () => {
  assert.equal(configuredVscodeAuthorityAuthToken({
    CODEX_HUB_AUTH_TOKEN: " shell-token "
  }, {
    CODEX_HUB_AUTH_TOKEN: "config-token"
  }), "config-token");
  assert.equal(configuredVscodeAuthorityAuthToken({}, {
    CODEX_HUB_AUTH_TOKEN: " config-token "
  }), "config-token");
  assert.equal(configuredVscodeAuthorityAuthToken({
    CODEX_HUB_AUTH_TOKEN: "shell-token"
  }, {
    CODEX_HUB_AUTH_TOKEN: ""
  }), "");
  assert.equal(authorityServiceAuthToken(vscodeAuthorityAuthTokenEnvName, {
    CODEX_HUB_AUTH_TOKEN: " explicit-token "
  }), "explicit-token");
});

test("VSCode authority auth opt-in rejects a missing token or unexpected env name", () => {
  assert.throws(
    () => authorityServiceAuthToken(vscodeAuthorityAuthTokenEnvName, {}),
    /Missing explicitly configured/
  );
  assert.throws(
    () => authorityServiceAuthToken("OTHER_TOKEN", { OTHER_TOKEN: "secret" }),
    /Unsupported authority auth-token environment variable/
  );
});

test("VSCode authority migration removes the obsolete generated token file", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-vscode-auth."));
  const tokenFile = path.join(dataDir, "vscode-authority-token");
  try {
    await writeFile(tokenFile, "obsolete-generated-token\n");
    assert.equal(await removeLegacyVscodeAuthorityTokenFile(dataDir), true);
    await assert.rejects(access(tokenFile), { code: "ENOENT" });
    assert.equal(await removeLegacyVscodeAuthorityTokenFile(dataDir), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
