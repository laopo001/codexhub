import assert from "node:assert/strict";
import test from "node:test";
import { toPowerShellSingleQuoted, toWindowsWslPath } from "../../scripts/link-local.js";

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
