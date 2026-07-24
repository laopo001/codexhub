import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchAppServerCommand,
  type AppServerCollaborationMode,
  type AppServerCommandHost
} from "../../src/cli/appServerCommandDispatcher.js";
import type { SessionCommand, SessionModelCatalogResult } from "../../src/shared/threadTypes.js";

const command = (value: Partial<SessionCommand> & Pick<SessionCommand, "type">): SessionCommand => ({
  seq: 1,
  commandId: "command-1",
  workingDirectory: "/tmp/project",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...value
});

const createHost = (options: {
  defaultModel?: string | null;
  models?: unknown;
  collaborationModes?: unknown;
  reviewResult?: unknown;
  cachedThreadSettings?: {
    model?: string | null;
    modelReasoningEffort?: string | null;
    collaborationMode?: "plan" | "default" | null;
  };
  configThreadSettings?: {
    model?: string | null;
    modelReasoningEffort?: string | null;
    collaborationMode?: "plan" | "default" | null;
  };
  failPlanResetCount?: number;
} = {}) => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const synced: string[] = [];
  const settingsReads = { cached: 0, config: 0 };
  const planResetModes: AppServerCommandHost["planResetModes"] = new Map();
  let cachedThreadSettings = options.cachedThreadSettings;
  let remainingPlanResetFailures = options.failPlanResetCount ?? 0;
  const host: AppServerCommandHost = {
    defaultModel: options.defaultModel === null ? undefined : options.defaultModel ?? "fallback-model",
    permissionParams: { approvalPolicy: "never" },
    listThreads: async () => [],
    listModels: async () => ({
      models: (options.models ?? [{ id: "model-1", model: "gpt-model-1" }]) as SessionModelCatalogResult["models"]
    }),
    listPermissionProfiles: async () => ({ profiles: [] }),
    listCollaborationModes: async () => options.collaborationModes ?? ({
      data: [
        { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
        { name: "Default", mode: "default", model: null, reasoning_effort: null }
      ]
    }),
    cachedThreadSettings: () => {
      settingsReads.cached += 1;
      return cachedThreadSettings;
    },
    readThreadSettings: async () => {
      settingsReads.config += 1;
      return options.configThreadSettings ?? { collaborationMode: "default" };
    },
    cacheThreadCollaborationMode: (_threadId, value) => {
      cachedThreadSettings = {
        model: value.settings.model,
        modelReasoningEffort: value.settings.reasoning_effort,
        collaborationMode: value.mode
      };
    },
    planResetModes,
    listCommandPalette: async (cwd) => ({
      palette: { cwd, generatedAt: new Date(0).toISOString(), entries: [] }
    }),
    bindThread: () => undefined,
    unbindThread: async () => undefined,
    syncThreadTurns: async () => undefined,
    startThread: async () => ({ threadId: "started" }),
    loadThread: async (threadId) => ({ threadId }),
    ensureThreadLoaded: async (threadId) => threadId,
    rememberDefaultThread: async () => undefined,
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "thread/settings/update") {
        if (remainingPlanResetFailures > 0) {
          remainingPlanResetFailures -= 1;
          throw new Error("reset unavailable");
        }
      }
      if (method === "review/start") {
        return options.reviewResult ?? { reviewThreadId: "thread-1", turn: { id: "turn-review" } };
      }
      if (method === "thread/fork") return { thread: { id: "thread-forked" } };
      return {};
    },
    scheduleThreadSync: (threadId) => synced.push(threadId),
    captureThreadSettingsResponse: async () => undefined,
    forwardThreadExecutionChanged: async () => undefined,
    resolveApprovalRequest: () => undefined,
    resolveUserInputRequest: () => undefined,
    markBridgeStartedUnknownThread: () => undefined,
    markThreadLoaded: () => undefined,
    markBridgeStartedThread: () => undefined
  };
  return {
    host,
    requests,
    synced,
    settingsReads,
    planResetModes,
    setCachedThreadSettings: (value: typeof cachedThreadSettings) => {
      cachedThreadSettings = value;
    }
  };
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

test("dispatcher returns official stop and steer RPC responses", async () => {
  const { host, requests } = createHost();
  host.request = async (method, params) => {
    requests.push({ method, params });
    return { method };
  };
  assert.deepEqual(await dispatchAppServerCommand(command({
    type: "stop", threadId: "thread-1", turnId: "turn-1"
  }), host), { method: "turn/interrupt" });
  assert.deepEqual(await dispatchAppServerCommand(command({
    type: "steer", threadId: "thread-1", turnId: "turn-1", input: "guide it"
  }), host), { method: "turn/steer" });
  assert.deepEqual(requests.map((request) => request.method), ["turn/interrupt", "turn/steer"]);
});

test("dispatcher exposes the runtime permission profile catalog without local choices", async () => {
  const { host } = createHost();
  host.listPermissionProfiles = async (cwd, refresh) => {
    assert.equal(cwd, "/tmp/project");
    assert.equal(refresh, true);
    return {
      profiles: [{ id: "team-safe", description: "Team policy", allowed: true }],
      source: "live"
    };
  };
  assert.deepEqual(await dispatchAppServerCommand(command({
    type: "list_permission_profiles",
    refresh: true
  }), host), {
    profiles: [{ id: "team-safe", description: "Team policy", allowed: true }],
    source: "live"
  });
});

test("dispatcher forwards command palette plugin cache refresh and source metadata", async () => {
  const { host } = createHost();
  host.listCommandPalette = async (cwd, part, refresh) => {
    assert.equal(cwd, "/tmp/project");
    assert.equal(part, "plugins");
    assert.equal(refresh, true);
    return {
      palette: {
        cwd,
        generatedAt: "2026-01-01T00:00:00.000Z",
        entries: []
      },
      source: "cache",
      updatedAt: "2026-01-01T00:00:00.000Z",
      stale: false
    };
  };
  assert.deepEqual(await dispatchAppServerCommand(command({
    type: "list_command_palette",
    commandPalettePart: "plugins",
    refresh: true
  }), host), {
    palette: {
      cwd: "/tmp/project",
      generatedAt: "2026-01-01T00:00:00.000Z",
      entries: []
    },
    source: "cache",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stale: false
  });
});

test("dispatcher forwards named permissions and current approval controls", async () => {
  const { host, requests } = createHost();
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "apply it",
    options: {
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          rules: false,
          skill_approval: true,
          request_permissions: false,
          mcp_elicitations: true
        }
      },
      approvalsReviewer: "guardian_subagent",
      permissions: "team-safe",
      sandboxPolicy: { type: "dangerFullAccess" }
    }
  }), host);

  assert.deepEqual(requests, [{
    method: "turn/start",
    params: {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "apply it", text_elements: [] }],
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          rules: false,
          skill_approval: true,
          request_permissions: false,
          mcp_elicitations: true
        }
      },
      approvalsReviewer: "guardian_subagent",
      permissions: "team-safe"
    }
  }]);
});

test("dispatcher requires the current review/start response", async () => {
  const current = createHost({
    reviewResult: { reviewThreadId: "review-thread-1", turn: { id: "review-turn-1" } }
  });
  assert.deepEqual(await dispatchAppServerCommand(command({
    type: "review_thread",
    threadId: "thread-1"
  }), current.host), { ok: true, reviewThreadId: "review-thread-1" });
  assert.deepEqual(current.synced, ["thread-1"]);

  const missingThread = createHost({ reviewResult: { turn: { id: "review-turn-1" } } });
  await assert.rejects(dispatchAppServerCommand(command({
    type: "review_thread",
    threadId: "thread-1"
  }), missingThread.host), /did not return reviewThreadId and turn\.id/);

  const missingTurn = createHost({ reviewResult: { reviewThreadId: "review-thread-1", turn: {} } });
  await assert.rejects(dispatchAppServerCommand(command({
    type: "review_thread",
    threadId: "thread-1"
  }), missingTurn.host), /did not return reviewThreadId and turn\.id/);
});

test("dispatcher applies one-turn plan and goal options before turn/start", async () => {
  const { host, requests } = createHost();
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "ship it",
    options: {
      collaborationMode: "plan",
      goalMode: true,
      model: "gpt-test",
      modelReasoningEffort: "ultra"
    }
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
      text: "ship it",
      text_elements: []
    }],
    collaborationMode: {
      mode: "plan",
      settings: {
        model: "gpt-test",
        reasoning_effort: "medium",
        developer_instructions: null
      }
    }
  });
  assert.deepEqual(requests[2], {
    method: "thread/settings/update",
    params: {
      threadId: "thread-1",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-test",
          reasoning_effort: "ultra",
          developer_instructions: null
        }
      }
    }
  });
});

test("dispatcher resolves structured Plan from the live default model catalog", async () => {
  const { host, requests } = createHost({
    defaultModel: null,
    models: [
      { id: "catalog-other", model: "model-other", isDefault: false },
      { id: "catalog-default", model: "model-default", isDefault: true }
    ],
    configThreadSettings: { model: null, modelReasoningEffort: null }
  });
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "plan it",
    options: { collaborationMode: "plan", model: null }
  }), host);

  const modeModel = (request: typeof requests[number]) => (request.params as {
    collaborationMode: { settings: { model: string } };
  }).collaborationMode.settings.model;
  assert.equal(modeModel(requests[0]), "model-default");
  assert.equal(modeModel(requests[1]), "model-default");
});

test("dispatcher clears old Plan model and effort when Auto is explicit", async () => {
  const { host, requests, settingsReads } = createHost({
    defaultModel: null,
    models: [{ id: "catalog-default", model: "model-default", isDefault: true }],
    cachedThreadSettings: {
      model: "model-old",
      modelReasoningEffort: "high",
      collaborationMode: "default"
    },
    configThreadSettings: {
      model: null,
      modelReasoningEffort: null,
      collaborationMode: "default"
    }
  });
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "plan with defaults",
    options: {
      collaborationMode: "plan",
      model: null,
      modelReasoningEffort: null
    }
  }), host);

  const plan = (requests[0].params as { collaborationMode: AppServerCollaborationMode }).collaborationMode;
  const reset = (requests[1].params as { collaborationMode: AppServerCollaborationMode }).collaborationMode;
  assert.deepEqual(plan.settings, {
    model: "model-default",
    reasoning_effort: "medium",
    developer_instructions: null
  });
  assert.deepEqual(reset.settings, {
    model: "model-default",
    reasoning_effort: null,
    developer_instructions: null
  });
  assert.equal(settingsReads.config, 1);
});

test("dispatcher requires the official collaboration mode masks", async () => {
  const { host } = createHost({
    collaborationModes: {
      data: [{ name: "Default", mode: "default", model: null, reasoning_effort: null }]
    }
  });
  await assert.rejects(dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "plan it",
    options: { collaborationMode: "plan", model: "gpt-test" }
  }), host), /did not provide plan mode/);
});

test("dispatcher forwards ultra as turn/start effort", async () => {
  const { host, requests, settingsReads } = createHost();
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "delegate this",
    options: { modelReasoningEffort: "ultra" }
  }), host);

  assert.deepEqual(requests, [{
    method: "turn/start",
    params: {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{
        type: "text",
        text: "delegate this",
        text_elements: []
      }],
      effort: "ultra"
    }
  }]);
  assert.equal("collaborationMode" in (requests[0].params as Record<string, unknown>), false);
  assert.equal(settingsReads.cached, 1);
  assert.equal(settingsReads.config, 0);
});

test("dispatcher sends an explicit Default collaboration mode for Chat turns", async () => {
  const { host, requests, settingsReads } = createHost({
    cachedThreadSettings: {
      model: "gpt-current",
      modelReasoningEffort: "high",
      collaborationMode: "plan"
    },
    configThreadSettings: {
      model: "gpt-default",
      modelReasoningEffort: "medium",
      collaborationMode: "default"
    }
  });
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "implement this",
    options: {
      collaborationMode: "default",
      model: "gpt-current",
      modelReasoningEffort: "ultra"
    }
  }), host);

  assert.deepEqual(requests, [{
    method: "turn/start",
    params: {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "implement this", text_elements: [] }],
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-current",
          reasoning_effort: "ultra",
          developer_instructions: null
        }
      }
    }
  }]);
  assert.equal(settingsReads.config, 1);
  assert.deepEqual(host.cachedThreadSettings("thread-1"), {
    model: "gpt-current",
    modelReasoningEffort: "ultra",
    collaborationMode: "default"
  });
});

test("dispatcher repairs sticky Plan before starting an Ultra turn", async () => {
  const { host, requests, settingsReads } = createHost({
    cachedThreadSettings: {
      model: "gpt-current",
      modelReasoningEffort: "ultra",
      collaborationMode: "plan"
    },
    configThreadSettings: {
      model: "gpt-current",
      modelReasoningEffort: "high",
      collaborationMode: "default"
    }
  });
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "delegate this",
    options: { modelReasoningEffort: "ultra" }
  }), host);

  assert.deepEqual(requests, [{
    method: "thread/settings/update",
    params: {
      threadId: "thread-1",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-current",
          reasoning_effort: "ultra",
          developer_instructions: null
        }
      }
    }
  }, {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "delegate this", text_elements: [] }],
      effort: "ultra"
    }
  }]);
  assert.equal(settingsReads.config, 1);
});

test("dispatcher retries the exact Default mode after a Plan reset fails", async (context) => {
  const errors: string[] = [];
  context.mock.method(console, "error", (...values: unknown[]) => errors.push(values.join(" ")));
  const { host, requests, settingsReads, planResetModes, setCachedThreadSettings } = createHost({
    failPlanResetCount: 1
  });
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "plan this",
    options: {
      collaborationMode: "plan",
      model: "gpt-test",
      modelReasoningEffort: "high"
    }
  }), host);

  assert.equal(requests[0]?.method, "turn/start");
  assert.equal(requests[1]?.method, "thread/settings/update");
  assert.match(errors.join("\n"), /failed to reset Plan collaboration mode/);
  assert.deepEqual(planResetModes.get("thread-1"), {
    mode: "default",
    settings: {
      model: "gpt-test",
      reasoning_effort: "high",
      developer_instructions: null
    }
  });
  setCachedThreadSettings({
    model: "gpt-test",
    modelReasoningEffort: "medium",
    collaborationMode: "plan"
  });

  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "implement this"
  }), host);

  assert.deepEqual(requests[2], requests[1]);
  assert.equal(requests[3]?.method, "turn/start");
  assert.equal(planResetModes.has("thread-1"), false);

  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "continue"
  }), host);

  assert.equal(requests.length, 5);
  assert.equal(requests[4]?.method, "turn/start");
  assert.equal(settingsReads.config, 1);
});

test("dispatcher replaces a failed Plan reset with the next Plan settings", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const { host, requests, planResetModes } = createHost({ failPlanResetCount: 1 });
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "first plan",
    options: {
      collaborationMode: "plan",
      model: "model-old",
      modelReasoningEffort: "high"
    }
  }), host);
  await dispatchAppServerCommand(command({
    type: "turn",
    threadId: "thread-1",
    input: "second plan",
    options: {
      collaborationMode: "plan",
      model: "model-new",
      modelReasoningEffort: "ultra"
    }
  }), host);

  const secondReset = requests.at(-1);
  assert.equal(secondReset?.method, "thread/settings/update");
  assert.deepEqual(secondReset?.params, {
    threadId: "thread-1",
    collaborationMode: {
      mode: "default",
      settings: {
        model: "model-new",
        reasoning_effort: "ultra",
        developer_instructions: null
      }
    }
  });
  assert.equal(planResetModes.has("thread-1"), false);
});

test("dispatcher forks through the selected lastTurnId", async () => {
  const { host, requests } = createHost();
  await dispatchAppServerCommand(command({
    type: "fork_thread",
    threadId: "thread-1",
    lastTurnId: "turn-3"
  }), host);

  assert.deepEqual(requests, [{
    method: "thread/fork",
    params: {
      threadId: "thread-1",
      lastTurnId: "turn-3",
      cwd: "/tmp/project",
      model: "fallback-model",
      approvalPolicy: "never",
      threadSource: "user"
    }
  }]);
});
