import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readVscodeExtensionSettings, vscodeToolModel } from "../../targets/vscode/src/settings.js";
import {
  defaultCommitMessageModel,
  defaultCommitMessagePrompt
} from "../../src/shared/commitMessageGeneration.js";

const manifest = JSON.parse(
  await readFile(new URL("../../targets/vscode/package.json", import.meta.url), "utf8")
) as {
  contributes?: {
    commands?: Array<{ command?: string; icon?: string }>;
    configuration?: {
      properties?: Record<string, unknown>;
    };
    menus?: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
  };
};

const readSettings = (values: Record<string, unknown>) => readVscodeExtensionSettings({
  get<T>(key: string, fallback?: T) {
    return (values[key] as T | undefined) ?? fallback;
  }
});

test("VS Code Settings contain only extension-owned behavior", () => {
  const properties = manifest.contributes?.configuration?.properties ?? {};
  assert.deepEqual(Object.keys(properties).sort(), [
    "codexhub.gitCommit.model",
    "codexhub.gitCommit.prompt",
    "codexhub.tools.model"
  ]);

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
    toolsModel: defaultCommitMessageModel,
    gitCommitModel: "",
    gitCommitPrompt: defaultCommitMessagePrompt
  });
  assert.deepEqual(readSettings({
    "tools.model": " gpt-tools ",
    "gitCommit.model": " gpt-commit ",
    "gitCommit.prompt": " custom instructions "
  }), {
    toolsModel: "gpt-tools",
    gitCommitModel: "gpt-commit",
    gitCommitPrompt: "custom instructions"
  });
  assert.deepEqual(readSettings({
    "tools.model": false,
    "gitCommit.model": " ",
    "gitCommit.prompt": 42
  }), {
    toolsModel: defaultCommitMessageModel,
    gitCommitModel: "",
    gitCommitPrompt: defaultCommitMessagePrompt
  });
});

test("VS Code tool model supports a Git commit override without changing conversation models", () => {
  const settings = readSettings({ "tools.model": "gpt-tools", "gitCommit.model": "" });
  assert.equal(vscodeToolModel(settings, settings.gitCommitModel), "gpt-tools");
  assert.equal(vscodeToolModel(settings, "gpt-commit"), "gpt-commit");
});

test("VS Code contributes one Git SCM commit-message action", () => {
  const command = manifest.contributes?.commands?.find((entry) =>
    entry.command === "codexhub.generateCommitMessage"
  );
  assert.deepEqual(command, {
    command: "codexhub.generateCommitMessage",
    category: "%command.category%",
    title: "%command.generateCommitMessage.title%",
    shortTitle: "%command.generateCommitMessage.shortTitle%",
    icon: "$(wand)"
  });
  assert.deepEqual(
    manifest.contributes?.menus?.["scm/title"]?.filter((entry) =>
      entry.command === "codexhub.generateCommitMessage"
    ),
    [{
      command: "codexhub.generateCommitMessage",
      when: "scmProvider == git && !codexhub.commitMessageGenerating",
      group: "navigation@91"
    }]
  );
});
