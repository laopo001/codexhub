import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readVscodeExtensionSettings } from "../../targets/vscode/src/settings.js";

const manifest = JSON.parse(
  await readFile(new URL("../../targets/vscode/package.json", import.meta.url), "utf8")
) as {
  contributes?: {
    configuration?: {
      properties?: Record<string, unknown>;
    };
  };
};

const readSettings = (values: Record<string, unknown>) => readVscodeExtensionSettings({
  get<T>(key: string, fallback?: T) {
    return (values[key] as T | undefined) ?? fallback;
  }
});

test("VS Code Settings contain only extension-owned behavior", () => {
  const properties = manifest.contributes?.configuration?.properties ?? {};
  assert.deepEqual(Object.keys(properties).sort(), ["codexhub.enabled"]);

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

test("VS Code settings use stable defaults and reject invalid values", () => {
  assert.deepEqual(readSettings({}), {
    enabled: true
  });
  assert.deepEqual(readSettings({ enabled: false }), { enabled: false });
  assert.deepEqual(readSettings({
    enabled: "false",
  }), {
    enabled: true
  });
});
