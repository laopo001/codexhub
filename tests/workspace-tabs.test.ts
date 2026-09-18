import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("workspace tabs mount one persistent keyed conversation per open thread", async () => {
  const source = await readFile(new URL("../src/web/AppView.tsx", import.meta.url), "utf8");
  assert.match(source, /destroyOnHidden=\{false\}/);
  assert.match(source, /<WorkspaceThreadConversation key=\{item\.key\} workspace=\{workspace\} threadId=\{item\.key\} \/>/);
  assert.doesNotMatch(source, /children:\s*activeThread\s*&&/);
});
