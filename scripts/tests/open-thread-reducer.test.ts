import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { ThreadDetail } from "../../src/shared/threadTypes.js";

const loadReducer = async () => {
  const globalWithWindow = globalThis as unknown as { window?: { location: { search: string } } };
  globalWithWindow.window = { location: { search: "" } };
  return (await import("../../src/web/openThreadReducer.js")).openThreadReducer;
};

const detail = (threadId: string): ThreadDetail => ({
  threadId,
  workingDirectory: `/tmp/${threadId}`,
  session: { online: true, runnable: true, sessionId: "session-1" },
  status: "idle",
  running: false,
  title: threadId,
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  threadUsage: emptyThreadUsage(),
  records: [],
  lastSeq: 0
});

const record: CodexRecord = {
  id: "record-1",
  type: "event_msg",
  timestamp: "2026-01-01T00:00:01.000Z",
  payload: { type: "agent_message", message: "done" }
};

test("open thread reducer preserves local drafts when fresh server detail arrives", async () => {
  const openThreadReducer = await loadReducer();
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, { type: "set-composer-mode", threadId: "thread-1", mode: "goal" });
  state = openThreadReducer(state, {
    type: "set-draft",
    threadId: "thread-1",
    field: "modelDraft",
    value: "gpt-test"
  });
  state = openThreadReducer(state, {
    type: "upsert-detail",
    thread: { ...detail("thread-1"), status: "running", running: true, title: "server title" }
  });

  assert.equal(state[0].composerMode, "goal");
  assert.equal(state[0].modelDraft, "gpt-test");
  assert.equal(state[0].running, true);
  assert.equal(state[0].title, "server title");
});

test("open thread reducer merges stream records and applies semantic ordering", async () => {
  const openThreadReducer = await loadReducer();
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, { type: "upsert-detail", thread: detail("thread-2") });
  state = openThreadReducer(state, {
    type: "merge-stream",
    thread: { ...detail("thread-1"), status: "running", running: true },
    record
  });
  state = openThreadReducer(state, { type: "reorder", threadIds: ["thread-2", "thread-1"] });

  assert.deepEqual(state.map((thread) => thread.threadId), ["thread-2", "thread-1"]);
  assert.equal(state[1].records[0].id, "record-1");
  assert.equal(state[1].running, true);
});
