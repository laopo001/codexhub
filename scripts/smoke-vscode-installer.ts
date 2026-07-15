import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installVSCodeExtension } from "../src/core/vscodeExtensionInstaller.js";

const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-vscode-installer-"));
const previousLog = process.env.CODEXHUB_FAKE_CODE_LOG;

try {
  const fakeCode = path.join(root, "code");
  const logPath = path.join(root, "code-calls.jsonl");
  const vsixPath = path.join(root, "codexhub.vsix");
  await writeFile(vsixPath, "fake VSIX consumed by the fake code host");
  await writeFile(fakeCode, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.CODEXHUB_FAKE_CODE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "if (process.argv.includes('--list-extensions')) console.log('dadigua.codexhub@0.4.16');",
  ].join("\n"));
  await chmod(fakeCode, 0o755);
  process.env.CODEXHUB_FAKE_CODE_LOG = logPath;

  const result = await installVSCodeExtension({
    codeCommand: fakeCode,
    installWindowsHost: false,
    vsixPath,
  });
  assert.equal(result.localExtension, "dadigua.codexhub@0.4.16");
  assert.equal(result.windowsExtension, null);
  assert.equal(result.vsixPath, vsixPath);

  const calls = (await readFile(logPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls, [
    ["--install-extension", vsixPath, "--force"],
    ["--list-extensions", "--show-versions"],
  ]);
  await assert.rejects(
    installVSCodeExtension({
      codeCommand: path.join(root, "missing-code"),
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
