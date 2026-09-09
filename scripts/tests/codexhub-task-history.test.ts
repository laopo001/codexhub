import assert from "node:assert/strict";
import test from "node:test";
import { codexhubTaskHistoryCursor } from "../../src/web/helpers/useCodexhubTaskHistory.js";

const parent = {
  threadId: "parent",
  records: [],
  history: { hasOlder: true, oldestRecordId: "cursor", loadedRecordCount: 24 },
  backgroundTerminals: [{ itemId: "start-call", processId: "1", command: "codexhub start task --name test", cwd: "/workspace", osPid: null, cpuPercent: null, rssKb: null }]
};

test("loads older pages only for missing live CLI start records", () => {
  assert.equal(codexhubTaskHistoryCursor(parent), "cursor");
  assert.equal(codexhubTaskHistoryCursor({ ...parent, history: { ...parent.history, oldestRecordId: "next" } }), "next");
  assert.equal(codexhubTaskHistoryCursor({ ...parent, records: [{ id: "app:parent:command", type: "response_item", payload: { type: "local_shell_call", call_id: "start-call" } }] }), undefined);
  assert.equal(codexhubTaskHistoryCursor({ ...parent, history: { ...parent.history, hasOlder: false } }), undefined);
});

test("does not scan history for empty terminals or unrelated shell commands", () => {
  assert.equal(codexhubTaskHistoryCursor(undefined), undefined);
  assert.equal(codexhubTaskHistoryCursor({ ...parent, backgroundTerminals: [] }), undefined);
  for (const command of ["pnpm dev", "echo 'codexhub start task'", "codexhub send 123e4567-e89b-12d3-a456-426614174000 update"]) {
    assert.equal(codexhubTaskHistoryCursor({ ...parent, backgroundTerminals: [{ ...parent.backgroundTerminals[0], command }] }), undefined);
  }
});
