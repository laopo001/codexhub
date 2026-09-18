import type { OpenThreadOptions } from "../src/web/appActions/threadActions.js";
import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../src/core/threadUsage.js";
import type {
  MachineSummary,
  OpenThreadState,
  ProjectPickerState,
  RuntimeSummary,
  StreamEvent,
  SubagentThreadDialogState
} from "../src/web/types.js";

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

const thread = (
  threadId: string,
  machineId: string,
  workingDirectory: string,
  lastSeq = 0
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
  lastSeq,
  composerMode: "chat",
  modelDraft: "auto",
  reasoningDraft: "auto",
  serviceTierDraft: "auto",
  approvalPolicyDraft: "auto",
  approvalsReviewerDraft: "auto",
  permissionProfileDraft: null,
  imageAttachments: [],
  textAttachments: [],
  queuedTurns: [],
  pendingUserMessages: []
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

const threadResponse = (
  machineId: string,
  workingDirectory: string,
  lastSeq = 31
) => new Response(JSON.stringify({
  threadId: "child-thread",
  workingDirectory,
  runtime: { machineId, online: true, runnable: true },
  status: "idle",
  running: false,
  title: "Child conversation",
  updatedAt: "2026-08-03T00:00:01.000Z",
  messageCount: 0,
  threadUsage: emptyThreadUsage(),
  records: [],
  lastSeq
}), {
  status: 200,
  headers: { "content-type": "application/json" }
});

const fixture = async ({
  machineAOnline = true,
  machineAThreads = [],
  dialogParentOnly = false,
  dialogParentAttachmentUrl,
  fetchImpl
}: {
  machineAOnline?: boolean;
  machineAThreads?: RuntimeSummary["threads"];
  dialogParentOnly?: boolean;
  dialogParentAttachmentUrl?: string;
  fetchImpl: typeof fetch;
}) => {
  const { createProjectActions } = await import("../src/web/appActions/projectActions.js");
  const childThreadId = "child-thread";
  const parentThread = thread("parent-thread", "machine-a", "/projects/a");
  if (dialogParentAttachmentUrl) {
    parentThread.imageAttachments = [{
      id: "dialog-parent-image",
      file: new File([], "dialog-parent.png", { type: "image/png" }),
      name: "dialog-parent.png",
      previewUrl: dialogParentAttachmentUrl
    }];
  }
  const staleChildThread = thread(childThreadId, "machine-b", "/projects/b");
  const openThreads = dialogParentOnly ? [staleChildThread] : [parentThread, staleChildThread];
  const conversationThreads = new Map(openThreads.map((item) => [item.threadId, item]));
  const runtimeList = [
    runtime("machine-a", "/projects/a", machineAOnline, machineAThreads),
    runtime("machine-b", "/projects/b", true, [staleChildThread])
  ];
  const openThreadCalls: string[] = [];
  const openThreadOptions: Array<OpenThreadOptions | undefined> = [];
  const subscriptions: Array<{ threadId: string; after: number }> = [];
  const closedThreadIds = new Set([childThreadId]);
  const threadLastSeqs = new Map([[childThreadId, 27]]);
  let subagentThreadDialog: SubagentThreadDialogState | null = dialogParentOnly ? {
    threadId: parentThread.threadId,
    parentThreadId: "workspace-parent",
    agentPath: "/root/dialog-parent",
    machineId: "machine-a",
    workingDirectory: parentThread.workingDirectory,
    status: "ready",
    thread: parentThread,
    error: ""
  } : null;
  let projectPicker: ProjectPickerState | null = null;
  const projectMachine: MachineSummary = {
    machineId: "machine-a",
    type: "local",
    hostname: "test-host",
    online: true,
    status: "online",
    lastSeenAt: "2026-08-03T00:00:00.000Z",
    cwd: "/projects/a",
    capabilities: { projectLauncher: true, projectCatalog: "editable" }
  };
  const syncConversationThreads = () => {
    conversationThreads.clear();
    for (const item of openThreads) conversationThreads.set(item.threadId, item);
    const visited = new Set<SubagentThreadDialogState>();
    let dialog = subagentThreadDialog;
    while (dialog && !visited.has(dialog)) {
      visited.add(dialog);
      if (dialog.thread) conversationThreads.set(dialog.threadId, dialog.thread);
      dialog = dialog.parentDialog ?? null;
    }
  };
  syncConversationThreads();
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
    closedThreadIds: { current: closedThreadIds },
    conversationThreadsRef: { current: conversationThreads },
    latestRequestedThreadId: { current: "parent-thread" },
    openingSubagentThreads: { current: new Set<string>() },
    machines: [projectMachine],
    projectList: [],
    projectPicker: null,
    selectedProjectKey: "",
    runtimeList,
    openThreads,
    get subagentThreadDialog() {
      return subagentThreadDialog;
    },
    threadOrderByMachine,
    threadLastSeqs: { current: threadLastSeqs },
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
    setProjectActionError: () => undefined,
    setProjectPicker: (
      action: ProjectPickerState | null | ((value: ProjectPickerState | null) => ProjectPickerState | null)
    ) => {
      projectPicker = resolveStateAction(projectPicker, action);
    },
    setProjects: () => undefined,
    setSelectedProjectKey: () => undefined,
    setSubagentThreadDialog: (
      action: SubagentThreadDialogState
        | null
        | ((value: SubagentThreadDialogState | null) => SubagentThreadDialogState | null)
    ) => {
      subagentThreadDialog = resolveStateAction(subagentThreadDialog, action);
      syncConversationThreads();
    },
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
      openThreadCalls.push(threadId);
      openThreadOptions.push(options);
    },
    subscribeThread: (threadId: string, after: number) => {
      subscriptions.push({ threadId, after });
    }
  } as unknown as Parameters<typeof createProjectActions>[1]);

  return {
    actions,
    childThreadId,
    closedThreadIds,
    openThreadCalls,
    openThreadOptions,
    subscriptions,
    threadLastSeqs,
    state: () => ({
      activeMachineId,
      activeWorkspacePath,
      activeTabThreadId,
      activeTabThreadByMachine,
      threadOrderByMachine,
      subagentThreadDialog,
      projectPicker
    })
  };
};

test("the project picker starts at the machine home directory", async () => {
  const requests: string[] = [];
  const testFixture = await fixture({
    fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        cwd: "/home/laop",
        parent: "/home",
        home: "/home/laop",
        entries: [{ name: "projects", path: "/home/laop/projects" }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  testFixture.actions.showProjectPicker({
    key: "machine-a",
    machineId: "machine-a",
    machineType: "local",
    label: "local",
    online: true,
    projectLauncher: true,
    badgeLabel: "local",
    projects: []
  });

  assert.equal(testFixture.state().projectPicker?.path, "~");
  assert.equal(new URL(requests[0], "http://codexhub.test").searchParams.get("path"), "~");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(testFixture.state().projectPicker?.path, "/home/laop");
  assert.deepEqual(testFixture.state().projectPicker?.entries, [{
    name: "projects",
    path: "/home/laop/projects"
  }]);
});

test("opening a subagent shows a dialog immediately and never activates a workspace tab", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const testFixture = await fixture({
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return response;
    }
  });

  const opening = testFixture.actions.openSubagentThread(
    testFixture.childThreadId,
    {
      agentPath: "/root/readme_accuracy",
      assignment: {
        initialMessage: "Review the README",
        model: "gpt-5.6-sol",
        reasoningEffort: "max"
      }
    }
  );

  assert.deepEqual(testFixture.state().subagentThreadDialog, {
    threadId: "child-thread",
    parentThreadId: "parent-thread",
    agentPath: "/root/readme_accuracy",
    assignment: {
      initialMessage: "Review the README",
      model: "gpt-5.6-sol",
      reasoningEffort: "max"
    },
    machineId: "machine-a",
    workingDirectory: "/projects/a",
    status: "loading",
    error: ""
  });
  assert.deepEqual(workspaceSelection(testFixture.state()), {
    activeMachineId: "machine-a",
    activeWorkspacePath: "/projects/a",
    activeTabThreadId: "parent-thread",
    activeTabThreadByMachine: {
      "machine-a": "parent-thread",
      "machine-b": "child-thread"
    },
    threadOrderByMachine: {
      "machine-a": ["parent-thread"],
      "machine-b": ["child-thread"]
    }
  });

  resolveResponse(threadResponse("machine-a", "/projects/a/resumed-child"));
  await opening;

  assert.deepEqual(requests, [{
    url: "/api/machines/machine-a/threads",
    method: "POST",
    body: {
      action: "resume",
      threadId: "child-thread",
      cwd: "/projects/a"
    }
  }]);
  assert.equal(testFixture.state().subagentThreadDialog?.status, "ready");
  assert.equal(testFixture.state().subagentThreadDialog?.thread?.workingDirectory, "/projects/a/resumed-child");
  assert.deepEqual(testFixture.openThreadCalls, []);
  assert.deepEqual(testFixture.subscriptions, []);
  assert.equal(testFixture.threadLastSeqs.get("child-thread"), 31);
  assert.equal(testFixture.closedThreadIds.has("child-thread"), false);
  assert.equal(testFixture.state().activeTabThreadId, "parent-thread");
});

test("nested subagent navigation resolves its parent from the dialog conversation registry", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const revokedUrls: string[] = [];
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => revokedUrls.push(url)
  });
  try {
    const testFixture = await fixture({
      dialogParentOnly: true,
      dialogParentAttachmentUrl: "blob:dialog-parent-image",
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), method: init?.method ?? "GET" });
        return threadResponse("machine-a", "/projects/a/nested-child");
      }
    });

    await testFixture.actions.openSubagentThread(testFixture.childThreadId, {
      parentThreadId: "parent-thread",
      agentPath: "/root/nested-review"
    });

    assert.deepEqual(requests, [{
      url: "/api/machines/machine-a/threads",
      method: "POST"
    }]);
    assert.deepEqual(revokedUrls, []);
    assert.equal(testFixture.state().subagentThreadDialog?.status, "ready");
    assert.equal(testFixture.state().subagentThreadDialog?.parentThreadId, "parent-thread");
    assert.equal(testFixture.state().subagentThreadDialog?.parentDialog?.threadId, "parent-thread");
    assert.equal(testFixture.state().subagentThreadDialog?.thread?.workingDirectory, "/projects/a/nested-child");
    assert.equal(testFixture.state().activeTabThreadId, "parent-thread");
    const { releaseDialogOnlyThreadAttachments } = await import("../src/web/helpers/subagentThreadDialog.js");
    releaseDialogOnlyThreadAttachments(testFixture.state().subagentThreadDialog, ["child-thread"]);
    assert.deepEqual(revokedUrls, ["blob:dialog-parent-image"]);
  } finally {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectUrl
    });
  }
});

test("nested subagent retry retains its dialog-only parent routing after a transient failure", async () => {
  const requests: string[] = [];
  let attempt = 0;
  const testFixture = await fixture({
    dialogParentOnly: true,
    fetchImpl: async (input) => {
      requests.push(String(input));
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: "temporary runtime failure" }), {
          status: 409,
          headers: { "content-type": "application/json" }
        });
      }
      return threadResponse("machine-a", "/projects/a/nested-child");
    }
  });

  const options = {
    parentThreadId: "parent-thread",
    agentPath: "/root/nested-review"
  };
  await testFixture.actions.openSubagentThread(testFixture.childThreadId, options);

  assert.equal(testFixture.state().subagentThreadDialog?.status, "error");
  assert.equal(testFixture.state().subagentThreadDialog?.error, "temporary runtime failure");
  assert.equal(testFixture.state().subagentThreadDialog?.parentDialog?.threadId, "parent-thread");

  await testFixture.actions.openSubagentThread(testFixture.childThreadId, options);

  assert.deepEqual(requests, [
    "/api/machines/machine-a/threads",
    "/api/machines/machine-a/threads"
  ]);
  assert.equal(testFixture.state().subagentThreadDialog?.status, "ready");
  assert.equal(testFixture.state().subagentThreadDialog?.thread?.workingDirectory, "/projects/a/nested-child");
  assert.equal(testFixture.state().activeTabThreadId, "parent-thread");
});

test("opening an attached subagent loads its snapshot without resuming or changing cwd", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const attachedChild = thread("child-thread", "machine-a", "/projects/a/worktree");
  const testFixture = await fixture({
    machineAThreads: [attachedChild],
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return threadResponse("machine-a", "/projects/a/worktree");
    }
  });

  await testFixture.actions.openSubagentThread(testFixture.childThreadId);

  assert.deepEqual(requests, [{ url: "/api/threads/child-thread", method: "GET" }]);
  assert.equal(testFixture.state().subagentThreadDialog?.thread?.workingDirectory, "/projects/a/worktree");
  assert.equal(testFixture.state().activeWorkspacePath, "/projects/a");
  assert.equal(testFixture.state().activeTabThreadId, "parent-thread");
  assert.deepEqual(testFixture.openThreadCalls, []);
});

test("an offline parent machine reports the failure inside the dialog", async () => {
  const testFixture = await fixture({
    machineAOnline: false,
    fetchImpl: async () => {
      throw new Error("offline Open must not make a request");
    }
  });

  await testFixture.actions.openSubagentThread(testFixture.childThreadId);

  assert.equal(testFixture.state().subagentThreadDialog?.status, "error");
  assert.equal(
    testFixture.state().subagentThreadDialog?.error,
    "Cannot open the subagent thread while its machine runtime is offline."
  );
  assert.equal(testFixture.state().activeTabThreadId, "parent-thread");
});

test("a resume rejection keeps the parent tab and exposes the server reason in the dialog", async () => {
  const testFixture = await fixture({
    fetchImpl: async () => new Response(JSON.stringify({ error: "runtime unavailable" }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })
  });

  await testFixture.actions.openSubagentThread(testFixture.childThreadId);

  assert.equal(testFixture.state().subagentThreadDialog?.status, "error");
  assert.equal(testFixture.state().subagentThreadDialog?.error, "runtime unavailable");
  assert.equal(testFixture.state().activeTabThreadId, "parent-thread");
  assert.deepEqual(testFixture.openThreadCalls, []);
});

test("a mismatched resume response is rejected instead of displaying another machine thread", async () => {
  const testFixture = await fixture({
    fetchImpl: async () => threadResponse("machine-b", "/projects/b")
  });

  await testFixture.actions.openSubagentThread(testFixture.childThreadId);

  assert.equal(testFixture.state().subagentThreadDialog?.status, "error");
  assert.match(testFixture.state().subagentThreadDialog?.error ?? "", /machine-b, not machine-a/);
  assert.equal(testFixture.state().activeTabThreadId, "parent-thread");
});

test("the dialog owns a realtime subscription only while its snapshot is ready", async () => {
  const { subagentThreadSubscriptionIds } = await import("../src/web/helpers/subagentThreadDialog.js");
  const loading: SubagentThreadDialogState = {
    threadId: "child-thread",
    parentThreadId: "parent-thread",
    status: "loading",
    error: ""
  };
  const ready: SubagentThreadDialogState = {
    ...loading,
    status: "ready",
    thread: thread("child-thread", "machine-a", "/projects/a")
  };

  assert.deepEqual(subagentThreadSubscriptionIds(["parent-thread"], loading), ["parent-thread"]);
  assert.deepEqual(subagentThreadSubscriptionIds(["parent-thread"], ready), ["parent-thread", "child-thread"]);
  assert.deepEqual(subagentThreadSubscriptionIds(["parent-thread", "child-thread"], ready), [
    "parent-thread",
    "child-thread"
  ]);
  assert.deepEqual(subagentThreadSubscriptionIds(["parent-thread"], null), ["parent-thread"]);
});

test("realtime records update the dialog snapshot without creating an open thread tab", async () => {
  const { mergeSubagentThreadDialogStream } = await import("../src/web/helpers/subagentThreadDialog.js");
  const dialog: SubagentThreadDialogState = {
    threadId: "child-thread",
    parentThreadId: "parent-thread",
    machineId: "machine-a",
    workingDirectory: "/projects/a",
    status: "ready",
    thread: thread("child-thread", "machine-a", "/projects/a", 31),
    error: ""
  };
  const event: StreamEvent = {
    seq: 32,
    threadId: "child-thread",
    kind: "record",
    thread: {
      ...thread("child-thread", "machine-a", "/projects/a", 32),
      running: true,
      status: "running"
    },
    record: {
      id: "child-record",
      type: "response_item",
      timestamp: "2026-08-03T00:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Working on it" }]
      }
    }
  };

  const next = mergeSubagentThreadDialogStream(dialog, event);

  assert.notEqual(next, dialog);
  assert.equal(next?.thread?.running, true);
  assert.deepEqual(next?.thread?.records.map((record) => record.id), ["child-record"]);
});

const workspaceSelection = (state: ReturnType<Awaited<ReturnType<typeof fixture>>["state"]>) => ({
  activeMachineId: state.activeMachineId,
  activeWorkspacePath: state.activeWorkspacePath,
  activeTabThreadId: state.activeTabThreadId,
  activeTabThreadByMachine: state.activeTabThreadByMachine,
  threadOrderByMachine: state.threadOrderByMachine
});


test("cross-window sidebar opens the explicit remote target without inferring project from cwd", async () => {
  const fixtureState = await fixture({ fetchImpl: async () => { throw new Error("No fetch expected"); } });
  const projectTarget = { machineId: "machine-registered", path: "/project" };
  await fixtureState.actions.switchMachineThread("another-window-thread", {
    machineId: "machine-registered", workingDirectory: "/workspace", projectTarget
  });
  assert.deepEqual(fixtureState.openThreadCalls, ["another-window-thread"]);
  assert.deepEqual(fixtureState.openThreadOptions, [{
    expectedMachineId: "machine-registered", preferredWorkingDirectory: "/workspace", projectTarget
  }]);
  assert.equal(fixtureState.state().activeMachineId, "machine-registered");
});

test("CodexHub CLI dialog opens the advertised machine without resuming on the parent", async () => {
  const requests: string[] = [];
  const f = await fixture({ fetchImpl: async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return threadResponse("machine-b", "/projects/b");
  } });
  await f.actions.openSubagentThread(f.childThreadId, { parentThreadId: "parent-thread", origin: "codexhub", machineId: "machine-b" });
  assert.equal(f.state().subagentThreadDialog?.status, "ready");
  assert.equal(f.state().subagentThreadDialog?.origin, "codexhub");
  assert.equal(f.state().subagentThreadDialog?.machineId, "machine-b");
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^GET .*\/api\/threads\/child-thread$/);
  assert.deepEqual(f.openThreadCalls, []);
  assert.equal(f.state().activeTabThreadId, "parent-thread");
});

test("missing CLI thread never triggers inferred resume or changes the parent tab", async () => {
  let requests = 0;
  const f = await fixture({ fetchImpl: async () => { requests++; return threadResponse("machine-a", "/projects/a"); } });
  await f.actions.openSubagentThread("unadvertised-id", { parentThreadId: "parent-thread", origin: "codexhub" });
  assert.equal(requests, 0);
  assert.equal(f.state().subagentThreadDialog?.status, "error");
  assert.match(f.state().subagentThreadDialog?.error ?? "", /当前后端未找到/);
  assert.equal(f.state().activeTabThreadId, "parent-thread");
});
