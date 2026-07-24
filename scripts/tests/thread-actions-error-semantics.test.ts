import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { OpenThreadState } from "../../src/web/types.js";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: { href: "http://codexhub.test/", search: "" },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined
    }
  }
});

const openThread = (
  running: boolean,
  composerMode: OpenThreadState["composerMode"]
): OpenThreadState => ({
  threadId: "thread-actions",
  workingDirectory: "/tmp/thread-actions",
  runtime: { online: true, runnable: true, machineId: "machine-actions" },
  status: running ? "running" : "idle",
  running,
  title: "Thread actions",
  updatedAt: "2026-07-24T00:00:00.000Z",
  messageCount: 0,
  threadUsage: emptyThreadUsage(),
  records: [],
  lastSeq: 0,
  composerMode,
  modelDraft: "auto",
  reasoningDraft: "auto",
  serviceTierDraft: "auto",
  approvalPolicyDraft: "auto",
  approvalsReviewerDraft: "auto",
  permissionProfileDraft: null,
  imageAttachments: [],
  textAttachments: []
});

const fixture = async (
  running: boolean,
  composerMode: OpenThreadState["composerMode"],
  fetchImpl: typeof fetch
) => {
  const { createThreadActions } = await import("../../src/web/appActions/threadActions.js");
  const draft = new Map([["thread-actions", "hello"]]);
  const actionsDispatched: Array<{ type: string; record?: CodexRecord }> = [];
  const shownErrors: Array<{ key: string; title: string; message: string }> = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchImpl });
  const context = {
    activeTabThreadId: "thread-actions",
    closedThreadIds: { current: new Set<string>() },
    composerDraftStore: {
      delete: (threadId: string) => draft.delete(threadId),
      get: (threadId: string) => draft.get(threadId) ?? "",
      set: (threadId: string, value: string) => {
        draft.set(threadId, value);
      },
      subscribe: () => () => undefined
    },
    forkingMessageKey: "",
    goalDialog: null,
    threadRenameDialog: null,
    latestRequestedThreadId: { current: "" },
    notificationRecordsByThread: { current: new Map() },
    openingThreads: { current: new Map() },
    realtimeThreadSubscriptions: { current: new Set() },
    selectedProjectKey: "",
    openThreads: [openThread(running, composerMode)],
    threadLastSeqs: { current: new Map() },
    setActiveMachineId: () => undefined,
    setActiveTabThreadByMachine: () => undefined,
    setActiveTabThreadId: () => undefined,
    setActiveWorkspacePath: () => undefined,
    setForkingMessageKey: () => undefined,
    setGoalDialog: () => undefined,
    setProjects: () => undefined,
    setThreadModelDialogOpen: () => undefined,
    setThreadRenameDialog: () => undefined,
    setRuntimeList: () => undefined,
    dispatchOpenThreads: (action: { type: string; record?: CodexRecord }) => actionsDispatched.push(action),
    setThreadOrderByMachine: () => undefined
  } as unknown as Parameters<typeof createThreadActions>[0];
  const actions = createThreadActions(context, {
    handleLocalComposerCommand: () => false,
    primeTaskCompletionFeedback: () => undefined,
    refreshProjects: async () => ({ configPath: "/tmp/config.yaml", projects: [], machines: [] }),
    refreshRuntimes: async () => [],
    resetComposerHistory: () => undefined,
    sendRealtime: () => true,
    showActionError: (key, title, message) => shownErrors.push({ key, title, message }),
    showForkError: () => undefined
  });
  return { actions, actionsDispatched, shownErrors };
};

test("chat transport failure is the only Web-local submission transcript record", async () => {
  const { actions, actionsDispatched, shownErrors } = await fixture(
    false,
    "chat",
    async () => {
      throw new Error("network unreachable");
    }
  );
  await actions.send("thread-actions");

  const appended = actionsDispatched.filter((action) => action.type === "append-record");
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0]?.record?.payload, {
    type: "submission_failed",
    source: "codexhub",
    message: "network unreachable"
  });
  assert.deepEqual(shownErrors, []);
});

test("active Goal transport failure stays a control error instead of a transcript message", async () => {
  const { actions, actionsDispatched, shownErrors } = await fixture(
    true,
    "goal",
    async () => {
      throw new Error("goal transport unavailable");
    }
  );
  await actions.send("thread-actions");

  assert.equal(actionsDispatched.some((action) => action.type === "append-record"), false);
  assert.deepEqual(shownErrors, [{
    key: "thread-actions:goal-update",
    title: "Goal update failed",
    message: "goal transport unavailable"
  }]);
});

test("server-recorded synchronous send failures are not duplicated by the Web", async () => {
  const { actions, actionsDispatched, shownErrors } = await fixture(
    false,
    "chat",
    async () => new Response(JSON.stringify({
      error: "runtime offline",
      delivery: "turn"
    }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })
  );
  await actions.send("thread-actions");

  assert.equal(actionsDispatched.some((action) => action.type === "append-record"), false);
  assert.deepEqual(shownErrors, []);
});

test("explicit server delivery wins over a stale active Goal projection", async () => {
  const { actions, actionsDispatched, shownErrors } = await fixture(
    true,
    "goal",
    async () => new Response(JSON.stringify({
      error: "turn/start rejected",
      delivery: "turn"
    }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })
  );
  await actions.send("thread-actions");

  assert.equal(actionsDispatched.some((action) => action.type === "append-record"), false);
  assert.deepEqual(shownErrors, []);
});

test("stop, compact, review, and goal clear failures only use action feedback", async () => {
  const { actions, actionsDispatched, shownErrors } = await fixture(
    false,
    "chat",
    async () => new Response(JSON.stringify({ error: "operation rejected" }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })
  );
  await actions.stopTurn("thread-actions");
  await actions.compactThread("thread-actions");
  await actions.reviewThread("thread-actions");
  await actions.clearThreadGoal("thread-actions");

  assert.equal(actionsDispatched.some((action) => action.type === "append-record"), false);
  assert.deepEqual(shownErrors.map(({ title, message }) => ({ title, message })), [
    { title: "Stop failed", message: "operation rejected" },
    { title: "Compact failed", message: "operation rejected" },
    { title: "Review failed", message: "operation rejected" },
    { title: "Goal clear failed", message: "operation rejected" }
  ]);
});
