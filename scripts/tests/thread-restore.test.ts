import assert from "node:assert/strict";
import test from "node:test";
import { restorePersistedThreadTabs } from "../../src/web/helpers/threadRestore.js";

test("persisted thread restore keeps only successfully opened tabs", async () => {
  const attempts: string[] = [];
  const cleared: string[] = [];
  const result = await restorePersistedThreadTabs({
    threadIds: ["thread-a", "thread-b", "thread-c"],
    activeThreadId: "thread-b",
    openThread: async (threadId) => {
      attempts.push(threadId);
      if (threadId === "thread-b") throw new Error("missing");
    },
    clearActiveThreadIfLatest: (threadId) => cleared.push(threadId)
  });

  assert.deepEqual(attempts, ["thread-a", "thread-c", "thread-b"]);
  assert.deepEqual(cleared, ["thread-b"]);
  assert.deepEqual(result, {
    threadIds: ["thread-a", "thread-c"],
    activeThreadId: "thread-a"
  });
});

test("persisted thread restore preserves a successfully opened active tab", async () => {
  const result = await restorePersistedThreadTabs({
    threadIds: ["thread-a", "thread-b"],
    activeThreadId: "thread-b",
    openThread: async () => undefined,
    clearActiveThreadIfLatest: () => undefined
  });

  assert.deepEqual(result, {
    threadIds: ["thread-a", "thread-b"],
    activeThreadId: "thread-b"
  });
});

test("persisted thread restore leaves no stale selection when every tab fails", async () => {
  const cleared: string[] = [];
  const result = await restorePersistedThreadTabs({
    threadIds: ["stale-a", "stale-b"],
    activeThreadId: "stale-b",
    openThread: async () => {
      throw new Error("missing");
    },
    clearActiveThreadIfLatest: (threadId) => cleared.push(threadId)
  });

  assert.deepEqual(cleared, ["stale-a", "stale-b"]);
  assert.deepEqual(result, { threadIds: [], activeThreadId: "" });

  const recovered: string[] = [];
  if (!result.activeThreadId && result.threadIds.length === 0) recovered.push("initial-thread");
  assert.deepEqual(recovered, ["initial-thread"]);
});
