import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installVSCodeExtension } from "../src/core/vscodeExtensionInstaller.js";

const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-vscode-installer-"));
const previousLog = process.env.CODEXHUB_FAKE_CODE_LOG;

try {
  const fakeCode = path.join(root, "code");
  const fakeCodeInsiders = path.join(root, "code-insiders");
  const logPath = path.join(root, "code-calls.jsonl");
  const vsixPath = path.join(root, "codexhub.vsix");
  await writeFile(vsixPath, "fake VSIX consumed by the fake code host");
  await writeFile(fakeCode, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.CODEXHUB_FAKE_CODE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
    `if (process.argv.includes('--list-extensions')) console.log('dadigua.codexhub@${version}');`,
  ].join("\n"));
  await chmod(fakeCode, 0o755);
  await writeFile(fakeCodeInsiders, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.CODEXHUB_FAKE_CODE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
    `if (process.argv.includes('--list-extensions')) console.log('dadigua.codexhub@${version}');`,
  ].join("\n"));
  await chmod(fakeCodeInsiders, 0o755);
  process.env.CODEXHUB_FAKE_CODE_LOG = logPath;

  const result = await installVSCodeExtension({
    codeCommand: fakeCode,
    codeInsidersCommand: fakeCodeInsiders,
    installWindowsHost: false,
    vsixPath,
  });
  assert.equal(result.localExtension, `dadigua.codexhub@${version}`);
  assert.equal(result.localInsidersExtension, `dadigua.codexhub@${version}`);
  assert.equal(result.windowsExtension, null);
  assert.equal(result.windowsInsidersExtension, null);
  assert.equal(result.vsixPath, vsixPath);

  const calls = (await readFile(logPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls, [
    ["--install-extension", vsixPath, "--force"],
    ["--list-extensions", "--show-versions"],
    ["--version"],
    ["--install-extension", vsixPath, "--force"],
    ["--list-extensions", "--show-versions"],
  ]);

  await writeFile(logPath, "");
  const stableOnlyResult = await installVSCodeExtension({
    codeCommand: fakeCode,
    codeInsidersCommand: path.join(root, "missing-code-insiders"),
    installWindowsHost: false,
    vsixPath,
  });
  assert.equal(stableOnlyResult.localExtension, `dadigua.codexhub@${version}`);
  assert.equal(stableOnlyResult.localInsidersExtension, null);
  const stableOnlyCalls = (await readFile(logPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(stableOnlyCalls, [
    ["--install-extension", vsixPath, "--force"],
    ["--list-extensions", "--show-versions"],
  ]);

  await assert.rejects(
    installVSCodeExtension({
      codeCommand: path.join(root, "missing-code"),
      codeInsidersCommand: path.join(root, "missing-code-insiders"),
      installWindowsHost: false,
      vsixPath,
    }),
    /Could not install VS Code extension/,
  );
  console.error("VS Code CLI installer smoke passed");
} finally {
  if (previousLog === undefined) delete process.env.CODEXHUB_FAKE_CODE_LOG;
  else process.env.CODEXHUB_FAKE_CODE_LOG = previousLog;
  await rm(root, { recursive: true, force: true });
}
