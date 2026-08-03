import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { OpenThreadState, RuntimeSummary } from "../../src/web/types.js";

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

type OpenThreadOptions = {
  expectedMachineId?: string;
  preferredWorkingDirectory?: string;
};

type Feedback = {
  key: string;
  title: string;
  message: string;
};

const thread = (
  threadId: string,
  machineId: string,
  workingDirectory: string
): OpenThreadState => ({
  threadId,
  workingDirectory,
  runtime: { machineId, online: true, runnable: true },
  status: "idle",
  running: false,
  title: threadId,
  updatedAt: "2026-08-03T00:00:00.000Z",
  messageCount: 0,
  threadUsage: emptyThreadUsage(),
  records: [],
  lastSeq: 0,
  composerMode: "chat",
  modelDraft: "auto",
  reasoningDraft: "auto",
  serviceTierDraft: "auto",
  approvalPolicyDraft: "auto",
  approvalsReviewerDraft: "auto",
  permissionProfileDraft: null,
  imageAttachments: [],
  textAttachments: []
});

const runtime = (
  machineId: string,
  workingDirectory: string,
  online: boolean,
  threads: RuntimeSummary["threads"] = []
): RuntimeSummary => ({
  machineId,
  workingDirectory,
  online,
  status: online ? "online" : "offline",
  lastSeenAt: "2026-08-03T00:00:00.000Z",
  threads
});

const fixture = async ({
  machineAOnline = true,
  machineAThreads = [],
  fetchImpl
}: {
  machineAOnline?: boolean;
  machineAThreads?: RuntimeSummary["threads"];
  fetchImpl: typeof fetch;
}) => {
  const { createProjectActions } = await import("../../src/web/appActions/projectActions.js");
  const childThreadId = "child-thread";
  const parentThread = thread("parent-thread", "machine-a", "/projects/a");
  const oldChildThread = thread(childThreadId, "machine-b", "/projects/b");
  const runtimeList = [
    runtime("machine-a", "/projects/a", machineAOnline, machineAThreads),
    runtime("machine-b", "/projects/b", true, [oldChildThread])
  ];
  const feedback: Feedback[] = [];
  const projectErrors: string[] = [];
  const openThreadCalls: Array<{ threadId: string; options?: OpenThreadOptions }> = [];
  const subscriptions: Array<{ threadId: string; after: number }> = [];
  let activeMachineId = "machine-a";
  let activeWorkspacePath = "/projects/a";
  let activeTabThreadId = "parent-thread";
  let activeTabThreadByMachine: Record<string, string> = {
    "machine-a": "parent-thread",
    "machine-b": childThreadId
  };
  let threadOrderByMachine: Record<string, string[]> = {
    "machine-a": ["parent-thread"],
    "machine-b": [childThreadId]
  };
  currentFetch = fetchImpl;

  const resolveStateAction = <Value,>(current: Value, action: Value | ((value: Value) => Value)) =>
    typeof action === "function" ? (action as (value: Value) => Value)(current) : action;

  const context = {
    activeRuntime: runtimeList[0],
    activeTabThreadByMachine,
    activeTabThreadId,
    closedThreadIds: { current: new Set<string>() },
    latestRequestedThreadId: { current: "parent-thread" },
    openingSubagentThreads: { current: new Set<string>() },
    machines: [],
    projectList: [],
    projectPicker: null,
    selectedProjectKey: "",
    runtimeList,
    openThreads: [parentThread, oldChildThread],
    threadOrderByMachine,
    threadLastSeqs: { current: new Map([[childThreadId, 27]]) },
    threadPicker: null,
    setActiveMachineId: (action: string | ((value: string) => string)) => {
      activeMachineId = resolveStateAction(activeMachineId, action);
    },
    setActiveTabThreadByMachine: (
      action: Record<string, string> | ((value: Record<string, string>) => Record<string, string>)
    ) => {
      activeTabThreadByMachine = resolveStateAction(activeTabThreadByMachine, action);
    },
    setActiveTabThreadId: (action: string | ((value: string) => string)) => {
      activeTabThreadId = resolveStateAction(activeTabThreadId, action);
    },
    setActiveWorkspacePath: (action: string | ((value: string) => string)) => {
      activeWorkspacePath = resolveStateAction(activeWorkspacePath, action);
    },
    setCollapsedProjectMachineKeys: () => undefined,
    setDeletingProjectId: () => undefined,
    setMachines: () => undefined,
    setOpeningProjectKey: () => undefined,
    setProjectActionError: (action: string | ((value: string) => string)) => {
      projectErrors.push(resolveStateAction(projectErrors.at(-1) ?? "", action));
    },
    setProjectPicker: () => undefined,
    setProjects: () => undefined,
    setSelectedProjectKey: () => undefined,
    setRuntimeList: () => undefined,
    setTaskError: () => undefined,
    setThreadOrderByMachine: (
      action: Record<string, string[]> | ((value: Record<string, string[]>) => Record<string, string[]>)
    ) => {
      threadOrderByMachine = resolveStateAction(threadOrderByMachine, action);
    },
    setThreadPicker: () => undefined
  } as unknown as Parameters<typeof createProjectActions>[0];

  const actions = createProjectActions(context, {
    clearActiveThreadIfLatest: () => undefined,
    focusTaskDraftProject: () => undefined,
    openThread: async (threadId: string, options?: OpenThreadOptions) => {
      openThreadCalls.push({ threadId, options });
    },
    showActionError: (key: string, title: string, message: string) => {
      feedback.push({ key, title, message });
    },
    subscribeThread: (threadId: string, after: number) => {
      subscriptions.push({ threadId, after });
    }
  } as unknown as Parameters<typeof createProjectActions>[1]);

  return {
    actions,
    childThreadId,
    feedback,
    projectErrors,
    openThreadCalls,
    subscriptions,
    state: () => ({
      activeMachineId,
      activeWorkspacePath,
      activeTabThreadId,
      activeTabThreadByMachine,
      threadOrderByMachine
    })
  };
};

test("opening a subagent thread refreshes the visible parent machine instead of reusing another machine tab", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const resumedWorkingDirectory = "/projects/a/resumed-child";
  const testFixture = await fixture({
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return new Response(JSON.stringify({
        threadId: "child-thread",
        workingDirectory: resumedWorkingDirectory,
        runtime: { machineId: "machine-a", online: true, runnable: true },
        status: "idle",
        running: false,
        title: "Child thread on machine A",
        updatedAt: "2026-08-03T00:00:01.000Z",
        messageCount: 0,
        threadUsage: emptyThreadUsage(),
        records: [],
        lastSeq: 0
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await testFixture.actions.openSubagentThread(testFixture.childThreadId);

  assert.deepEqual(requests, [{
    url: "/api/machines/machine-a/threads",
    method: "POST",
    body: {
      action: "resume",
      threadId: "child-thread",
      cwd: "/projects/a"
    }
  }]);
  assert.deepEqual(testFixture.subscriptions, [], "must not subscribe through machine-b's stale open-tab fast path");
  assert.deepEqual(testFixture.openThreadCalls, [{
    threadId: "child-thread",
    options: {
      expectedMachineId: "machine-a",
      preferredWorkingDirectory: resumedWorkingDirectory
    }
  }]);
  assert.equal(testFixture.state().activeMachineId, "machine-a");
  assert.equal(testFixture.state().activeWorkspacePath, resumedWorkingDirectory);
  assert.equal(testFixture.state().activeTabThreadByMachine["machine-a"], "child-thread");
  assert.deepEqual(testFixture.feedback, []);
});

test("opening an attached subagent preserves its runtime-reported working directory", async () => {
  const attachedChild = thread("child-thread", "machine-a", "/projects/a/worktree");
  const testFixture = await fixture({
    machineAThreads: [attachedChild],
    fetchImpl: async () => {
      throw new Error("an attached subagent must not be resumed");
    }
  });

  await testFixture.actions.openSubagentThread(testFixture.childThreadId);

  assert.deepEqual(testFixture.openThreadCalls, [{
    threadId: "child-thread",
    options: { expectedMachineId: "machine-a" }
  }]);
  assert.equal(testFixture.state().activeWorkspacePath, "/projects/a/worktree");
  assert.deepEqual(testFixture.subscriptions, []);
  assert.deepEqual(testFixture.feedback, []);
});

test("an offline parent machine reports subagent Open failure through workspace action feedback", async () => {
  const testFixture = await fixture({
    machineAOnline: false,
    fetchImpl: async () => {
      throw new Error("offline Open must not make a request");
    }
  });

  await testFixture.actions.openSubagentThread(testFixture.childThreadId);

  assert.deepEqual(testFixture.feedback, [{
    key: "child-thread:subagent-open",
    title: "Open subagent thread failed",
    message: "Cannot open the subagent thread while its machine runtime is offline."
  }]);
  assert.deepEqual(testFixture.openThreadCalls, []);
  assert.deepEqual(testFixture.subscriptions, []);
});

test("a subagent resume rejection reports the server reason through workspace action feedback", async () => {
  const testFixture = await fixture({
    fetchImpl: async () => new Response(JSON.stringify({ error: "runtime unavailable" }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })
  });

  await testFixture.actions.openSubagentThread(testFixture.childThreadId);

  assert.deepEqual(testFixture.feedback, [{
    key: "child-thread:subagent-open",
    title: "Open subagent thread failed",
    message: "runtime unavailable"
  }]);
  assert.deepEqual(testFixture.openThreadCalls, []);
  assert.deepEqual(testFixture.subscriptions, []);
});
