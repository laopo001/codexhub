import assert from "node:assert/strict";
import test from "node:test";
import { mergePathEntries, parseUserPathOutput } from "../../src/core/userPath.js";

test("user PATH is preferred and inherited entries are retained", () => {
  const env = mergePathEntries(
    { PATH: "/usr/bin:/workspace/bin" },
    "/home/laop/.local/share/pnpm:/usr/bin",
    "linux",
    ":"
  );
  assert.equal(env.PATH, "/home/laop/.local/share/pnpm:/usr/bin:/workspace/bin");
});

test("PATH output can be extracted from noisy login shell startup", () => {
  assert.equal(
    parseUserPathOutput("shell startup notice\n__CODEXHUB_USER_PATH__/home/user/.local/bin:/usr/bin\n"),
    "/home/user/.local/bin:/usr/bin"
  );
  assert.equal(parseUserPathOutput("shell startup failed\n"), null);
});

test("Windows PATH keeps its existing environment key", () => {
  const env = mergePathEntries(
    { Path: "C:\\Windows\\System32" },
    "C:\\Users\\user\\AppData\\Roaming\\npm",
    "win32",
    ";"
  );
  assert.equal(env.Path, "C:\\Users\\user\\AppData\\Roaming\\npm;C:\\Windows\\System32");
  assert.equal(env.PATH, undefined);
});
