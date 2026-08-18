import assert from "node:assert/strict";
import test from "node:test";
import { CodexHubApiError } from "../../src/shared/apiClient.js";
import { restorePersistedThreadTabs } from "../../src/web/helpers/threadRestore.js";

test("persisted thread restore keeps only successfully opened tabs", async () => {
  const attempts: string[] = [];
  const openOptions: Array<{ threadId: string; options?: { activate?: boolean; deferActivationUntilLoaded?: boolean } }> = [];
  const cleared: string[] = [];
  const result = await restorePersistedThreadTabs({
    threadIds: ["thread-a", "thread-b", "thread-c"],
    activeThreadId: "thread-b",
    openThread: async (threadId, options) => {
      attempts.push(threadId);
      openOptions.push({ threadId, options });
      if (threadId === "thread-b") throw new Error("missing");
    },
    clearActiveThreadIfLatest: (threadId) => cleared.push(threadId)
  });

  assert.deepEqual(attempts, ["thread-b", "thread-a", "thread-c"]);
  assert.deepEqual(openOptions, [
    { threadId: "thread-b", options: { activate: true, deferActivationUntilLoaded: true } },
    { threadId: "thread-a", options: { activate: false } },
    { threadId: "thread-c", options: { activate: false } }
  ]);
  assert.deepEqual(cleared, ["thread-b"]);
  assert.deepEqual(result, {
    threadIds: ["thread-a", "thread-c"],
    activeThreadId: "thread-a",
    pendingThreadIds: []
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
    activeThreadId: "thread-b",
    pendingThreadIds: []
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

  assert.deepEqual(cleared, ["stale-b", "stale-a"]);
  assert.deepEqual(result, { threadIds: [], activeThreadId: "", pendingThreadIds: [] });

  const recovered: string[] = [];
  if (!result.activeThreadId && result.threadIds.length === 0) recovered.push("initial-thread");
  assert.deepEqual(recovered, ["initial-thread"]);
});

test("persisted thread restore retries a transient authority failure", async () => {
  let attempts = 0;
  const result = await restorePersistedThreadTabs({
    threadIds: ["thread-a"],
    activeThreadId: "thread-a",
    retryDelaysMs: [0, 0],
    openThread: async () => {
      attempts += 1;
      if (attempts === 1) throw new CodexHubApiError(503, "runtime waking");
    },
    clearActiveThreadIfLatest: () => undefined
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    threadIds: ["thread-a"],
    activeThreadId: "thread-a",
    pendingThreadIds: []
  });
});

test("persisted thread restore preserves a transiently unavailable tab for background retry", async () => {
  const cleared: string[] = [];
  const result = await restorePersistedThreadTabs({
    threadIds: ["thread-a"],
    activeThreadId: "thread-a",
    retryDelaysMs: [0],
    openThread: async () => {
      throw new CodexHubApiError(404, "thread_not_found");
    },
    clearActiveThreadIfLatest: (threadId) => cleared.push(threadId)
  });

  assert.deepEqual(cleared, ["thread-a"]);
  assert.deepEqual(result, {
    threadIds: [],
    activeThreadId: "",
    pendingThreadIds: ["thread-a"]
  });
});

test("a failed active restore does not activate an unloaded tab over opened tabs", async () => {
  let activeThreadId = "";
  const openThread = async (
    threadId: string,
    options?: { activate?: boolean; deferActivationUntilLoaded?: boolean }
  ) => {
    if (options?.activate && !options.deferActivationUntilLoaded) activeThreadId = threadId;
    if (threadId === "stale-active") throw new CodexHubApiError(404, "thread_not_found");
    if (options?.activate) activeThreadId = threadId;
  };

  const result = await restorePersistedThreadTabs({
    threadIds: ["opened-tab", "stale-active"],
    activeThreadId: "stale-active",
    retryDelaysMs: [0],
    openThread,
    clearActiveThreadIfLatest: () => undefined
  });

  assert.equal(activeThreadId, "");
  assert.deepEqual(result, {
    threadIds: ["opened-tab"],
    activeThreadId: "opened-tab",
    pendingThreadIds: ["stale-active"]
  });
});
