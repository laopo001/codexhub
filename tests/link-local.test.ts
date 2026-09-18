import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageRootFromExecutable } from "../src/core/authorityPackage.js";
import { toPowerShellSingleQuoted, toWindowsWslPath } from "../scripts/link-local.js";

test("local link script converts the WSL repository path for Windows", () => {
  assert.equal(
    toWindowsWslPath("/home/laop/projects/codexhub", "Ubuntu"),
    "\\\\wsl.localhost\\Ubuntu\\home\\laop\\projects\\codexhub"
  );
});

test("local link script normalizes a path with repeated leading slashes", () => {
  assert.equal(
    toWindowsWslPath("//home/laop/projects/codexhub", "Ubuntu-24.04"),
    "\\\\wsl.localhost\\Ubuntu-24.04\\home\\laop\\projects\\codexhub"
  );
});

test("local link script quotes the Windows path for PowerShell", () => {
  assert.equal(toPowerShellSingleQuoted("\\\\wsl.localhost\\Ubuntu\\home\\laop"), "'\\\\wsl.localhost\\Ubuntu\\home\\laop'");
  assert.equal(toPowerShellSingleQuoted("C:\\Users\\O'Brien"), "'C:\\Users\\O''Brien'");
});

test("authority package resolver finds a Windows npm global package beside a cmd shim", async () => {
  const globalBin = await mkdtemp(path.join(os.tmpdir(), "codexhub-windows-bin."));
  const packageRoot = path.join(globalBin, "node_modules", "@dadigua", "codexhub");
  const executablePath = path.join(globalBin, "codexhub.cmd");
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(executablePath, "@echo off\r\n");
    assert.equal(
      await packageRootFromExecutable(executablePath, "win32"),
      packageRoot
    );
  } finally {
    await rm(globalBin, { recursive: true, force: true });
  }
});
