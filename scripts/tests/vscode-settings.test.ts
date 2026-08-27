import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../../targets/vscode/package.json", import.meta.url), "utf8")
) as {
  contributes?: {
    configuration?: {
      properties?: Record<string, unknown>;
    };
  };
};

test("VS Code Settings do not duplicate shared authority configuration", () => {
  const properties = manifest.contributes?.configuration?.properties ?? {};
  assert.deepEqual(Object.keys(properties), []);

  for (const forbidden of [
    "codexhub.dataDir",
    "codexhub.serverUrl",
    "codexhub.authorityPort",
    "codexhub.appServer",
    "codexhub.ssh",
    "codexhub.electron"
  ]) {
    assert.equal(Object.hasOwn(properties, forbidden), false, `unexpected shared setting: ${forbidden}`);
  }
});
