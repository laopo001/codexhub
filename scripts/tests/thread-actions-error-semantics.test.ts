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

let currentFetch: typeof fetch = async () => {
  throw new Error("fetch implementation not configured");
};
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: ((...args: Parameters<typeof fetch>) => currentFetch(...args)) as typeof fetch
});

const openThread = (
  running: boolean,
  composerMode: OpenThreadState["composerMode"],
  threadId = "thread-actions"
): OpenThreadState => ({
  threadId,
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
  fetchImpl: typeof fetch,
  options: { threadId?: string; workspaceOpen?: boolean } = {}
) => {
  const { createThreadActions } = await import("../../src/web/appActions/threadActions.js");
  const { reduceConversationThreadState } = await import("../../src/web/openThreadReducer.js");
  const threadId = options.threadId ?? "thread-actions";
  const thread = openThread(running, composerMode, threadId);
  const draft = new Map([[threadId, "hello"]]);
  const conversationThreads = new Map([[threadId, thread]]);
  const actionsDispatched: Array<{ type: string; record?: CodexRecord }> = [];
  const shownErrors: Array<{ key: string; title: string; message: string }> = [];
  const openedModelThreadIds: string[] = [];
  const activeTabChanges: string[] = [];
  let projectUpdates = 0;
  currentFetch = fetchImpl;
  const context = {
    activeTabThreadId: options.workspaceOpen === false ? "parent-thread" : threadId,
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
    openThreadIdsRef: { current: new Set(options.workspaceOpen === false ? [] : [threadId]) },
    openingThreads: { current: new Map() },
    realtimeThreadSubscriptions: { current: new Set() },
    selectedProjectKey: "",
    openThreads: options.workspaceOpen === false ? [] : [thread],
    conversationThreadsRef: { current: conversationThreads },
    threadLastSeqs: { current: new Map() },
    setActiveMachineId: () => undefined,
    setActiveTabThreadByMachine: () => undefined,
    setActiveTabThreadId: (threadId: string) => {
      activeTabChanges.push(threadId);
    },
    setActiveWorkspacePath: () => undefined,
    setForkingMessageKey: () => undefined,
    setGoalDialog: () => undefined,
    setProjects: () => {
      projectUpdates += 1;
    },
    openThreadModelDialog: (targetThreadId: string) => openedModelThreadIds.push(targetThreadId),
    setThreadRenameDialog: () => undefined,
    setRuntimeList: () => undefined,
    dispatchOpenThreads: () => undefined,
    dispatchConversationThread: (action: Parameters<typeof reduceConversationThreadState>[1]) => {
      actionsDispatched.push(action);
      const current = conversationThreads.get(action.threadId);
      if (current) conversationThreads.set(action.threadId, reduceConversationThreadState(current, action));
    },
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
  return {
    actions,
    actionsDispatched,
    shownErrors,
    openedModelThreadIds,
    activeTabChanges,
    conversationThreads,
    draft,
    threadId,
    projectUpdates: () => projectUpdates
  };
};

test("deferred thread activation waits for a successful load", async () => {
  let resolveFetch!: (response: Response) => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const fetchResponse = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const deferredThread = openThread(false, "chat", "deferred-thread");
  const { actions, activeTabChanges } = await fixture(
    false,
    "chat",
    async () => {
      markFetchStarted();
      return fetchResponse;
    },
    { threadId: deferredThread.threadId, workspaceOpen: false }
  );

  const opening = actions.openThread(deferredThread.threadId, { deferActivationUntilLoaded: true });
  await fetchStarted;
  assert.deepEqual(activeTabChanges, []);

  resolveFetch(new Response(JSON.stringify(deferredThread), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  await opening;
  assert.deepEqual(activeTabChanges, [deferredThread.threadId]);
});

test("failed deferred thread activation leaves the current tab untouched", async () => {
  const { actions, activeTabChanges } = await fixture(
    false,
    "chat",
    async () => new Response(JSON.stringify({ error: "thread unavailable" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    }),
    { threadId: "missing-thread", workspaceOpen: false }
  );

  await assert.rejects(
    actions.openThread("missing-thread", { deferActivationUntilLoaded: true }),
    /thread unavailable/
  );
  assert.deepEqual(activeTabChanges, []);
});

const serverFailure = (message: string, delivery: "turn" | "steer" | "goal") =>
  async () => new Response(JSON.stringify({ error: message, delivery }), {
    status: 409,
    headers: { "content-type": "application/json" }
  });

type SendFailureCase = {
  name: string;
  running: boolean;
  mode: OpenThreadState["composerMode"];
  fetch: typeof fetch;
  recordMessage?: string;
  actionError?: { key: string; title: string; message: string };
};

const sendFailureCases: SendFailureCase[] = [
  {
    name: "chat transport failure is the only Web-local submission transcript record",
    running: false,
    mode: "chat" as const,
    fetch: async () => { throw new Error("network unreachable"); },
    recordMessage: "network unreachable"
  },
  {
    name: "non-JSON HTTP send failures preserve the original response message",
    running: false,
    mode: "chat" as const,
    fetch: async () => new Response("upstream disconnected", { status: 502 }),
    recordMessage: "upstream disconnected"
  },
  {
    name: "active Goal transport failure stays a control error instead of a transcript message",
    running: true,
    mode: "goal" as const,
    fetch: async () => { throw new Error("goal transport unavailable"); },
    actionError: {
      key: "thread-actions:goal-update",
      title: "Goal update failed",
      message: "goal transport unavailable"
    }
  },
  ...(["turn", "steer"] as const).map((delivery) => ({
    name: `server-recorded ${delivery} failures are not duplicated by the Web`,
    running: false,
    mode: "chat" as const,
    fetch: serverFailure("runtime offline", delivery)
  })),
  {
    name: "explicit server delivery wins over a stale active Goal projection",
    running: true,
    mode: "goal" as const,
    fetch: serverFailure("turn/start rejected", "turn")
  }
];

for (const scenario of sendFailureCases) {
  test(scenario.name, async () => {
    const { actions, actionsDispatched, shownErrors } = await fixture(
      scenario.running,
      scenario.mode,
      scenario.fetch
    );
    await actions.send("thread-actions");

    const payloads = actionsDispatched
      .filter((action) => action.type === "append-record")
      .map((action) => action.record?.payload);
    assert.deepEqual(payloads, scenario.recordMessage ? [{
      type: "submission_failed",
      source: "codexhub",
      message: scenario.recordMessage
    }] : []);
    assert.deepEqual(shownErrors, scenario.actionError ? [scenario.actionError] : []);
  });
}

test("stop, compact, review, and Goal control failures only use action feedback", async () => {
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
  assert.equal(await actions.updateThreadGoal("thread-actions", { status: "paused" }), false);
  await actions.clearThreadGoal("thread-actions");

  assert.equal(actionsDispatched.some((action) => action.type === "append-record"), false);
  assert.deepEqual(shownErrors.map(({ title, message }) => ({ title, message })), [
    { title: "Stop failed", message: "operation rejected" },
    { title: "Compact failed", message: "operation rejected" },
    { title: "Review failed", message: "operation rejected" },
    { title: "Goal update failed", message: "operation rejected" },
    { title: "Goal clear failed", message: "operation rejected" }
  ]);
});

test("dialog-only subagent send uses the shared thread delivery path without opening a tab", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const { actions, actionsDispatched, threadId } = await fixture(
    false,
    "plan",
    async (input, init) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return new Response(JSON.stringify({ ok: true, delivery: "turn" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    { threadId: "child-thread", workspaceOpen: false }
  );

  await actions.send(threadId);

  assert.deepEqual(requests, [{
    url: "/api/threads/child-thread/turn",
    body: {
      input: "hello",
      source: "web",
      options: {
        model: null,
        modelReasoningEffort: null,
        serviceTier: null,
        approvalPolicy: null,
        approvalsReviewer: null,
        permissions: null,
        collaborationMode: "plan"
      }
    }
  }]);
  assert.equal(actionsDispatched.some((action) => action.type === "upsert-detail"), false);
  assert.equal(actionsDispatched.some((action) => action.type === "reset-composer-mode"), true);
});

test("dialog-only subagent model command targets the child conversation", async () => {
  const { actions, draft, openedModelThreadIds, shownErrors, threadId } = await fixture(
    false,
    "chat",
    async () => {
      throw new Error("model command must not send a turn");
    },
    { threadId: "child-thread", workspaceOpen: false }
  );
  draft.set(threadId, "/model");

  await actions.send(threadId);

  assert.deepEqual(openedModelThreadIds, ["child-thread"]);
  assert.equal(draft.get(threadId), "");
  assert.deepEqual(shownErrors, []);
});

test("dialog-only approval refreshes its conversation without creating or selecting a project thread", async () => {
  const { actions, actionsDispatched, conversationThreads, projectUpdates, threadId } = await fixture(
    false,
    "chat",
    async () => new Response(JSON.stringify({
      thread: {
        ...openThread(false, "chat", "child-thread"),
        title: "Approval handled"
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    { threadId: "child-thread", workspaceOpen: false }
  );

  await actions.respondToApproval(threadId, "approval-1", "approve");

  assert.equal(conversationThreads.get(threadId)?.title, "Approval handled");
  assert.equal(actionsDispatched.some((action) => action.type === "sync-detail"), true);
  assert.equal(actionsDispatched.some((action) => action.type === "upsert-detail"), false);
  assert.equal(projectUpdates(), 0);
});
