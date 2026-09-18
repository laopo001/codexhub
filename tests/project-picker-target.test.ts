import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSummary, ThreadPickerState } from "../src/web/types.js";

let candidateResponse: unknown[] = [];
let candidateRequests: string[] = [];

test("generic runtime thread picker keeps project origin unresolved", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    candidateRequests.push(String(input));
    return new Response(JSON.stringify({ threads: candidateResponse }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const { createProjectActions } = await import("../src/web/appActions/projectActions.js");
  globalThis.fetch = originalFetch;
  const runtime: RuntimeSummary = {
    machineId: "machine-a",
    workingDirectory: "/workspace-root",
    online: true,
    status: "online",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    threads: []
  };
  let picker: ThreadPickerState | null = null;
  const context = {
    activeRuntime: runtime,
    runtimeList: [runtime],
    threadPicker: null,
    setActiveMachineId: () => undefined,
    setActiveWorkspacePath: () => undefined,
    setThreadPicker: (value: ThreadPickerState | null | ((current: ThreadPickerState | null) => ThreadPickerState | null)) => {
      picker = typeof value === "function" ? value(picker) : value;
    }
  } as unknown as Parameters<typeof createProjectActions>[0];

  const actions = createProjectActions(context, {} as Parameters<typeof createProjectActions>[1]);
  actions.openThreadPicker(runtime);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const currentPicker = picker as ThreadPickerState | null;
  assert.equal(currentPicker?.workingDirectory, "/workspace-root");
  assert.equal(currentPicker?.projectTarget, undefined);
});

test("selected sidebar project supplies the thread picker default when no key is persisted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ threads: [] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const { createProjectActions } = await import("../src/web/appActions/projectActions.js");
  const runtime: RuntimeSummary = {
    machineId: "machine-a",
    workingDirectory: "/home/laop/.config/codexhub",
    online: true,
    status: "online",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    threads: []
  };
  let picker: ThreadPickerState | null = null;
  const selectedProject = {
    projectId: "project-videos",
    machineId: "machine-a",
    path: "/home/laop/projects/comfyui-sdk/videos",
    name: "videos",
    machineOnline: true
  } as unknown as import("../src/web/types.js").ProjectSummary;
  const context = {
    activeRuntime: runtime,
    activeWorkspacePath: selectedProject.path,
    projectList: [selectedProject],
    runtimeList: [runtime],
    selectedProject,
    selectedProjectKey: "",
    threadPicker: null,
    setActiveMachineId: () => undefined,
    setActiveWorkspacePath: () => undefined,
    setProjectActionError: () => undefined,
    setTaskError: () => undefined,
    setThreadPicker: (value: ThreadPickerState | null | ((current: ThreadPickerState | null) => ThreadPickerState | null)) => {
      picker = typeof value === "function" ? value(picker) : value;
    }
  } as unknown as Parameters<typeof createProjectActions>[0];
  try {
    const actions = createProjectActions(context, {} as Parameters<typeof createProjectActions>[1]);
    await actions.openSelectedProjectThreadPicker();
    const currentPicker = picker as ThreadPickerState | null;
    assert.equal(currentPicker?.workingDirectory, selectedProject.path);
    assert.deepEqual(currentPicker?.projectTarget, { machineId: "machine-a", path: selectedProject.path });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("thread picker path selection updates cwd origin and reloads matching candidates", async () => {
  const { createProjectActions } = await import("../src/web/appActions/projectActions.js");
  const candidate = (threadId: string, cwd: string) => ({
    threadId,
    cwd,
    path: `/sessions/${threadId}.jsonl`,
    title: threadId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    firstUserMessage: "",
    lastAssistantMessage: "",
    artifactCount: 0,
    messageCount: 0
  });
  candidateResponse = [candidate("thread-b", "/repo/b")];
  candidateRequests = [];
  try {
    const context = {
      threadPicker: {
        machineId: "machine-a",
        workingDirectory: "/repo/a",
        projectTarget: { machineId: "machine-a", path: "/repo/a" },
        preparingRuntime: false,
        loading: false,
        error: "old error",
        candidates: [candidate("thread-a", "/repo/a")],
        searchQuery: "old query",
        acting: null,
        worktreeBranch: "",
        worktreeBaseRef: "",
        worktreePath: "",
        selectingInstructions: true
      } satisfies ThreadPickerState,
      projectList: [{ machineId: "machine-a", path: "/repo/b" }],
      setThreadPicker: (value: ThreadPickerState | null | ((current: ThreadPickerState | null) => ThreadPickerState | null)) => {
        context.threadPicker = (typeof value === "function" ? value(context.threadPicker) : value) as ThreadPickerState;
      }
    } as unknown as Parameters<typeof createProjectActions>[0];
    const actions = createProjectActions(context, {} as Parameters<typeof createProjectActions>[1]);

    await actions.selectThreadPickerWorkingDirectory("/repo/b");

    const currentPicker = context.threadPicker;
    assert.ok(currentPicker);
    assert.equal(currentPicker.workingDirectory, "/repo/b");
    assert.deepEqual(currentPicker.projectTarget, { machineId: "machine-a", path: "/repo/b" });
    assert.equal(currentPicker.searchQuery, "");
    assert.equal(currentPicker.selectingInstructions, false);
    assert.deepEqual(currentPicker.candidates, [candidate("thread-b", "/repo/b")]);
    assert.match(candidateRequests[0] ?? "", /\/api\/machines\/machine-a\/thread-candidates\?limit=20&cwd=%2Frepo%2Fb$/);
  } finally {
    candidateResponse = [];
    candidateRequests = [];
  }
});
