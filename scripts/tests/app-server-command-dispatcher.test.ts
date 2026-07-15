import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchAppServerCommand,
  type AppServerCommandHost
} from "../../src/cli/appServerCommandDispatcher.js";
import type { SessionCommand } from "../../src/shared/threadTypes.js";

const command = (value: Partial<SessionCommand> & Pick<SessionCommand, "type">): SessionCommand => ({
  seq: 1,
  commandId: "command-1",
  workingDirectory: "/tmp/project",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...value
});

const createHost = () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const synced: string[] = [];
  const host: AppServerCommandHost = {
    defaultModel: "fallback-model",
    permissionParams: { approvalPolicy: "never" },
    listThreads: async () => [],
    listModels: async () => [{ id: "model-1" }],
    listCommandPalette: async () => ({ entries: [] }),
    bindThread: () => undefined,
    unbindThread: () => undefined,
    syncThreadTurns: async () => undefined,
    startThread: async () => ({ threadId: "started" }),
    loadThread: async (threadId) => ({ threadId }),
    ensureThreadLoaded: async (threadId) => threadId,
    rememberDefaultThread: async () => undefined,
    request: async (method, params) => {
      requests.push({ method, params });
      return method === "review/start" ? { turn: { id: "turn-review" } } : {};
    },
    scheduleThreadSync: (threadId) => synced.push(threadId),
    forwardThreadExecutionChanged: async () => undefined,
    resolveApprovalRequest: () => undefined,
    resolveUserInputRequest: () => undefined,
    markBridgeStartedUnknownThread: () => undefined,
    markThreadLoaded: () => undefined,
    markBridgeStartedThread: () => undefined
  };
  return { host, requests, synced };
};

test("dispatcher maps compact commands to official app-server RPC and sync", async () => {
  const { host, requests, synced } = createHost();
  const result = await dispatchAppServerCommand(command({
    type: "compact_thread",
    threadId: "thread-1"
  }), host);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(requests, [{ method: "thread/compact/start", params: { threadId: "thread-1" } }]);
  assert.deepEqual(synced, ["thread-1"]);
});

test("dispatcher applies one-turn plan and goal options before turn/start", async () => {
  const { host, requests } = createHost();
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "ship it",
    options: { collaborationMode: "plan", goalMode: true, model: "gpt-test" }
  }), host);

  assert.equal(requests[0].method, "thread/goal/set");
  assert.deepEqual(requests[0].params, {
    threadId: "thread-1",
    objective: "ship it",
    status: "active"
  });
  assert.equal(requests[1].method, "turn/start");
  assert.deepEqual(requests[1].params, {
    threadId: "thread-1",
    cwd: "/tmp/project",
    input: [{
      type: "text",
      text: "Plan mode is active for this turn.\n\nUser request:\nship it",
      text_elements: []
    }],
    model: "gpt-test"
  });
});
