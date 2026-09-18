import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  startAttachedCodexhubSession,
  type HeadlessSessionTransportCallbacks,
  type HeadlessSessionTransportFactory
} from "../src/cli/codexhubSessionRuntime.js";
import type { AppServerSocketLike } from "../src/core/appServerTunnel.js";

type Listener = {
  callback: (event: { data?: unknown }) => void;
  once: boolean;
};

const waitForCondition = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(20);
  }
  throw new Error(`condition was not met after ${timeoutMs}ms`);
};

class CurrentProtocolSocket implements AppServerSocketLike {
  readyState = 1;
  resumeRequests = 0;
  unsubscribeRequests = 0;
  readonly resumeParams: Record<string, unknown>[] = [];
  readonly startParams: Record<string, unknown>[] = [];
  readonly turnsListParams: Record<string, unknown>[] = [];
  readonly backgroundTerminalParams: Record<string, unknown>[] = [];
  readonly clientResponses: Array<{ id: string | number; result: unknown }> = [];
  backgroundTerminals: unknown[];
  private readonly requestCounts = new Map<string, number>();
  private readonly listeners = new Map<"message" | "error" | "close", Listener[]>();
  private failedTurnPage = false;

  constructor(private readonly options: {
    validResume?: boolean;
    overloadOnceFor?: string;
    errorFor?: string;
    completeTurnImmediately?: boolean;
    userAgent?: string;
    models?: unknown[];
    permissionProfiles?: unknown[];
    skills?: unknown[];
    pluginList?: unknown;
    pluginReads?: Record<string, unknown>;
    turnPages?: unknown[][];
    turnSnapshots?: unknown[][][];
    failTurnPageOnce?: number;
    repeatTurnCursor?: boolean;
    delayTurnListResponseMs?: number;
    backgroundTerminals?: unknown[];
    generatedTitle?: string;
    generatedCommitMessage?: string;
  } = {}) {
    this.backgroundTerminals = options.backgroundTerminals ?? [];
  }

  send(data: string) {
    const message = JSON.parse(data) as { id?: string | number; method?: string; params?: unknown; result?: unknown };
    if (message.id === undefined) return;
    if (!message.method && Object.prototype.hasOwnProperty.call(message, "result")) {
      this.clientResponses.push({ id: message.id, result: message.result });
      return;
    }
    const params = message.params as Record<string, unknown> | undefined;
    const method = message.method ?? "";
    const requestCount = (this.requestCounts.get(method) ?? 0) + 1;
    this.requestCounts.set(method, requestCount);
    if (this.options.overloadOnceFor === method && requestCount === 1) {
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ id: message.id, error: { code: -32001, message: "overloaded" } })
      }));
      return;
    }
    if (this.options.errorFor === method) {
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ id: message.id, error: { code: -32000, message: `${method} failed` } })
      }));
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize") {
      result = {
        userAgent: this.options.userAgent ?? "codex_cli_rs/0.144.4",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux"
      };
    } else if (message.method === "thread/start") {
      this.startParams.push(params ?? {});
      result = {
        thread: params?.ephemeral === true && (this.options.generatedTitle || this.options.generatedCommitMessage)
          ? { ...currentThread("structured-helper", stringParam(params, "cwd") ?? "/tmp/current-protocol"), ephemeral: true }
          : currentThread("default-thread", stringParam(params, "cwd") ?? "/tmp/current-protocol")
      };
    } else if (message.method === "thread/resume") {
      this.resumeRequests += 1;
      this.resumeParams.push(params ?? {});
      result = {
        thread: this.options.validResume
          ? currentThread(stringParam(params, "threadId") ?? "resumed-thread", stringParam(params, "cwd") ?? "/tmp/current-protocol")
          : {}
      };
    } else if (message.method === "thread/unsubscribe") {
      this.unsubscribeRequests += 1;
      result = { status: "unsubscribed" };
    } else if (message.method === "thread/read") {
      result = { thread: currentThread(stringParam(params, "threadId") ?? "default-thread", "/tmp/current-protocol") };
    } else if (message.method === "thread/goal/get") {
      result = { goal: null };
    } else if (message.method === "thread/turns/list") {
      this.turnsListParams.push(params ?? {});
      const cursor = stringParam(params, "cursor");
      const pageIndex = cursor?.startsWith("turn-page-")
        ? Number(cursor.slice("turn-page-".length))
        : 0;
      if (this.options.failTurnPageOnce === pageIndex && !this.failedTurnPage) {
        this.failedTurnPage = true;
        queueMicrotask(() => this.emit("message", {
          data: JSON.stringify({
            id: message.id,
            error: { code: -32000, message: `thread/turns/list page ${pageIndex} failed` }
          })
        }));
        return;
      }
      const snapshots = this.options.turnSnapshots;
      const pages = snapshots
        ? snapshots[Math.min(requestCount - 1, snapshots.length - 1)] ?? [[]]
        : this.options.turnPages ?? [[]];
      result = {
        data: pages[pageIndex] ?? [],
        nextCursor: this.options.repeatTurnCursor
          ? "turn-page-1"
          : pageIndex + 1 < pages.length
            ? `turn-page-${pageIndex + 1}`
            : null
      };
    } else if (message.method === "thread/backgroundTerminals/list") {
      this.backgroundTerminalParams.push(params ?? {});
      result = { data: this.backgroundTerminals, nextCursor: null };
    } else if (message.method === "account/rateLimits/read") {
      result = {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null
        }
      };
    } else if (message.method === "model/list") {
      result = {
        data: this.options.models ?? [],
        nextCursor: null
      };
    } else if (message.method === "permissionProfile/list") {
      result = {
        data: this.options.permissionProfiles ?? [],
        nextCursor: null
      };
    } else if (message.method === "skills/list") {
      result = {
        data: [{
          cwd: stringParam(params, "cwd") ?? "/tmp/current-protocol",
          skills: this.options.skills ?? []
        }]
      };
    } else if (message.method === "plugin/list") {
      result = this.options.pluginList ?? { marketplaces: [], featuredPluginIds: [] };
    } else if (message.method === "plugin/read") {
      result = this.options.pluginReads?.[stringParam(params, "pluginName") ?? ""] ?? {};
    } else if (message.method === "turn/start") {
      result = { turn: { id: "immediate-turn" } };
    }
    const respond = () => {
      this.emit("message", {
        data: JSON.stringify({ id: message.id, result })
      });
      if (
        message.method === "thread/start"
        && params?.ephemeral === true
        && (this.options.generatedTitle || this.options.generatedCommitMessage)
      ) {
        this.emit("message", {
          data: JSON.stringify({
            method: "thread/started",
            params: { thread: (result as { thread: unknown }).thread }
          })
        });
      }
      if (
        message.method === "turn/start"
        && stringParam(params, "threadId") === "structured-helper"
        && (this.options.generatedTitle || this.options.generatedCommitMessage)
      ) {
        const structured = this.options.generatedCommitMessage
          ? { message: this.options.generatedCommitMessage }
          : { title: this.options.generatedTitle };
        const item = { id: "structured-item", type: "agentMessage", text: JSON.stringify(structured) };
        this.emit("message", {
          data: JSON.stringify({
            method: "item/completed",
            params: { threadId: "structured-helper", turnId: "immediate-turn", item }
          })
        });
        this.emit("message", {
          data: JSON.stringify({
            method: "turn/completed",
            params: {
              threadId: "structured-helper",
              turn: {
                id: "immediate-turn",
                status: "completed",
                itemsView: "full",
                error: null,
                startedAt: 1,
                completedAt: 2,
                durationMs: 1000,
                items: [item]
              }
            }
          })
        });
      }
      if (message.method === "turn/start" && this.options.completeTurnImmediately) {
        this.emit("message", {
          data: JSON.stringify({
            method: "turn/completed",
            params: {
              threadId: stringParam(params, "threadId"),
              turn: {
                id: "immediate-turn",
                status: "completed",
                itemsView: "full",
                error: null,
                startedAt: 1,
                completedAt: 2,
                durationMs: 1000,
                items: []
              }
            }
          })
        });
      }
    };
    if (message.method === "thread/turns/list" && (this.options.delayTurnListResponseMs ?? 0) > 0) {
      setTimeout(respond, this.options.delayTurnListResponseMs);
    } else {
      queueMicrotask(respond);
    }
  }

  requestCount(method: string) {
    return this.requestCounts.get(method) ?? 0;
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(
    type: "message" | "error" | "close",
    callback: (event: { data?: unknown }) => void,
    options?: { once?: boolean }
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, once: options?.once === true });
    this.listeners.set(type, listeners);
  }

  emitServerRequest(message: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: "message" | "error" | "close", event: { data?: unknown }) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((listener) => !listener.once));
    for (const listener of listeners) listener.callback(event);
  }
}

const stringParam = (params: Record<string, unknown> | undefined, key: string) =>
  typeof params?.[key] === "string" ? params[key] : undefined;

const currentThread = (id: string, cwd: string) => ({
  id,
  sessionId: "session-current",
  forkedFromId: null,
  preview: "",
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 1,
  status: { type: "idle" },
  path: null,
  cwd,
  cliVersion: "0.144.4",
  source: "appServer",
  threadSource: "user",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: []
});

const transportFactory: HeadlessSessionTransportFactory = (_context, callbacks) => ({
  start: () => callbacks.onState("online", "online"),
  stop: () => undefined,
  sendEvent: () => undefined,
  sendHeartbeat: () => undefined
});

test("attached runtime can handshake for its protocol version without creating a default thread", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket();
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    appServerTransportFactory: async () => socket,
    ensureDefaultThread: false,
    machineId: "machine-runtime-only",
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return transportFactory(transportContext, nextCallbacks);
    }
  });
  try {
    assert.equal(session.threadId, undefined);
    assert.equal(socket.requestCount("initialize"), 1);
    assert.equal(socket.requestCount("thread/start"), 0);
    assert.equal(callbacks?.registration().cliVersion, "0.144.4");
  } finally {
    await session.stop();
  }
});

test("attached runtime injects developer instructions only into explicit thread creation", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket();
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    appServerTransportFactory: async () => socket,
    ensureDefaultThread: false,
    machineId: "machine-developer-instructions",
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return transportFactory(transportContext, nextCallbacks);
    }
  });
  try {
    assert.ok(callbacks);
    await callbacks.handleCommand({
      seq: 1,
      commandId: "instructed-thread",
      type: "start_thread",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      creationOptions: { developerInstructions: "Review without editing." }
    });
    await callbacks.handleCommand({
      seq: 2,
      commandId: "plain-thread",
      type: "start_thread",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString()
    });
    assert.equal(socket.startParams[0].developerInstructions, "Review without editing.");
    assert.equal(Object.hasOwn(socket.startParams[1], "developerInstructions"), false);
  } finally {
    await session.stop();
  }
});

test("attached runtime persists the model catalog cache", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhub-runtime-model-cache."));
  const previousDataDirectory = process.env.CODEX_HUB_DATA_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HUB_DATA_DIR = dataDirectory;
  process.env.CODEX_HOME = path.join(dataDirectory, "codex-home");
  const models = [{
    id: "catalog-gpt-test",
    model: "gpt-test",
    displayName: "GPT Test",
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High reasoning" }],
    serviceTiers: [{ id: "fast", name: "Fast" }]
  }];
  let firstCallbacks: HeadlessSessionTransportCallbacks | undefined;
  let firstSession: Awaited<ReturnType<typeof startAttachedCodexhubSession>> | undefined;
  let secondSession: Awaited<ReturnType<typeof startAttachedCodexhubSession>> | undefined;
  try {
    const firstSocket = new CurrentProtocolSocket({ models });
    firstSession = await startAttachedCodexhubSession({
      apiBase: "http://127.0.0.1:1",
      appServerUrl: "ws://127.0.0.1:1",
      appServerTransportFactory: async () => firstSocket,
      machineId: "machine-model-cache",
      cwd: "/tmp/current-protocol",
      transportFactory: (transportContext, callbacks) => {
        firstCallbacks = callbacks;
        return transportFactory(transportContext, callbacks);
      }
    });
    assert.ok(firstCallbacks);
    const live = await firstCallbacks.handleCommand(modelListCommand("live-models"));
    assert.equal((live as { source?: string }).source, "live");
    assert.equal(firstSocket.requestCount("model/list"), 1);
    await firstSession.stop();
    firstSession = undefined;

    const secondSocket = new CurrentProtocolSocket({ models });
    let secondCallbacks: HeadlessSessionTransportCallbacks | undefined;
    secondSession = await startAttachedCodexhubSession({
      apiBase: "http://127.0.0.1:1",
      appServerUrl: "ws://127.0.0.1:1",
      appServerTransportFactory: async () => secondSocket,
      machineId: "machine-model-cache",
      cwd: "/tmp/current-protocol",
      transportFactory: (transportContext, callbacks) => {
        secondCallbacks = callbacks;
        return transportFactory(transportContext, callbacks);
      }
    });
    assert.ok(secondCallbacks);
    const cached = await secondCallbacks.handleCommand(modelListCommand("cached-models"));
    assert.equal((cached as { source?: string }).source, "cache");
    assert.equal(secondSocket.requestCount("model/list"), 0);
    const refreshed = await secondCallbacks.handleCommand({
      ...modelListCommand("refreshed-models"),
      refresh: true
    });
    assert.equal((refreshed as { source?: string }).source, "live");
    assert.equal(secondSocket.requestCount("model/list"), 1);
  } finally {
    await firstSession?.stop();
    await secondSession?.stop();
    restoreEnv("CODEX_HUB_DATA_DIR", previousDataDirectory);
    restoreEnv("CODEX_HOME", previousCodexHome);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("attached runtime loads permission profiles live without persistent caching", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({
    permissionProfiles: [{
      id: ":workspace",
      description: "Workspace access",
      allowed: true
    }]
  });
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    appServerTransportFactory: async () => socket,
    machineId: "machine-permission-profiles",
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return transportFactory(transportContext, nextCallbacks);
    }
  });
  try {
    assert.ok(callbacks);
    const first = await callbacks.handleCommand(permissionListCommand("live-permissions-1"));
    const second = await callbacks.handleCommand(permissionListCommand("live-permissions-2"));
    assert.equal((first as { source?: string }).source, undefined);
    assert.equal(
      (second as { profiles?: Array<{ id?: string }> }).profiles?.[0]?.id,
      ":workspace"
    );
    assert.equal(socket.requestCount("permissionProfile/list"), 2);
  } finally {
    await session.stop();
  }
});

test("attached runtime loads command palette plugins live without persistent caching", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const skills = [{
    name: "demo:inspect",
    description: "Inspect the demo project",
    enabled: true,
    path: "/tmp/demo/SKILL.md",
    scope: "repo"
  }];
  const socket = new CurrentProtocolSocket({
    skills,
    pluginList: {
      marketplaces: [{
        path: "/tmp/marketplace",
        plugins: [{ id: "demo@1.0.0", name: "demo", installed: true, enabled: true }]
      }],
      featuredPluginIds: []
    },
    pluginReads: {
      demo: {
        plugin: {
          summary: {
            name: "demo",
            interface: {
              displayName: "Demo",
              description: "Demo plugin"
            }
          },
          skills
        }
      }
    }
  });
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    appServerTransportFactory: async () => socket,
    machineId: "machine-command-palette",
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return transportFactory(transportContext, nextCallbacks);
    }
  });
  try {
    assert.ok(callbacks);
    const first = await callbacks.handleCommand(commandPalettePluginCommand("live-plugins-1"));
    const second = await callbacks.handleCommand(commandPalettePluginCommand("live-plugins-2"));
    assert.equal((first as { source?: string }).source, undefined);
    assert.equal(
      (second as { palette?: { entries?: Array<{ name?: string }> } }).palette?.entries?.[0]?.name,
      "demo"
    );
    assert.equal(socket.requestCount("skills/list"), 2);
    assert.equal(socket.requestCount("plugin/list"), 2);
    assert.equal(socket.requestCount("plugin/read"), 2);
  } finally {
    await session.stop();
  }
});

test("attached runtime generates a title in an invisible ephemeral thread", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({ validResume: true, generatedTitle: "接入自动标题" });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    appServerTransportFactory: async () => socket,
    machineId: "machine-title-generation",
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    assert.ok(callbacks);
    const result = await callbacks.handleCommand({
      seq: 1,
      commandId: "title-command",
      type: "suggest_thread_title",
      workingDirectory: "/tmp/current-protocol",
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: "source-thread",
      input: "User: Add automatic titles",
      options: { model: "gpt-title", modelReasoningEffort: "low" }
    });
    assert.deepEqual(result, { title: "接入自动标题" });
    assert.equal(socket.requestCount("thread/fork"), 0);
    assert.equal(socket.requestCount("thread/start"), 2);
    assert.equal(socket.requestCount("turn/start"), 1);
    assert.equal(socket.requestCount("thread/unsubscribe"), 1);
    assert.equal(forwardedEvents.some((event) =>
      (event as { threadId?: string }).threadId === "structured-helper"
    ), false);
  } finally {
    await session.stop();
  }
});

test("attached runtime generates a commit message in an invisible ephemeral thread", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({ generatedCommitMessage: "feat: add SCM generation" });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    appServerTransportFactory: async () => socket,
    machineId: "machine-commit-generation",
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    assert.ok(callbacks);
    const result = await callbacks.handleCommand({
      seq: 1,
      commandId: "commit-command",
      type: "generate_commit_message",
      workingDirectory: "/tmp/current-protocol",
      createdAt: "2026-01-01T00:00:00.000Z",
      input: "diff --git a/a.ts b/a.ts",
      options: { model: "gpt-5.6-luna", modelReasoningEffort: "low" }
    });
    assert.deepEqual(result, { message: "feat: add SCM generation" });
    assert.equal(socket.requestCount("turn/start"), 1);
    assert.equal(socket.requestCount("thread/unsubscribe"), 1);
    assert.equal(forwardedEvents.some((event) =>
      (event as { threadId?: string }).threadId === "structured-helper"
    ), false);
  } finally {
    await session.stop();
  }
});

const modelListCommand = (commandId: string) => ({
  seq: 1,
  commandId,
  type: "list_models" as const,
  workingDirectory: "/tmp/current-protocol",
  createdAt: new Date(0).toISOString(),
  includeHidden: false
});

const permissionListCommand = (commandId: string) => ({
  seq: 1,
  commandId,
  type: "list_permission_profiles" as const,
  workingDirectory: "/tmp/current-protocol",
  createdAt: new Date(0).toISOString()
});

const commandPalettePluginCommand = (commandId: string) => ({
  seq: 1,
  commandId,
  type: "list_command_palette" as const,
  workingDirectory: "/tmp/current-protocol",
  createdAt: new Date(0).toISOString(),
  commandPalettePart: "plugins" as const
});

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

test("attached runtime rejects and does not cache malformed thread/resume responses", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket();
  const forwardedEvents: unknown[] = [];
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, callbacks) => {
      const transport = transportFactory(transportContext, callbacks);
      return {
        ...transport,
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    await assert.rejects(
      session.ensureThread("malformed-thread"),
      /thread\/resume did not return thread\.id/
    );
    await assert.rejects(
      session.ensureThread("malformed-thread"),
      /thread\/resume did not return thread\.id/
    );
    assert.equal(socket.resumeRequests, 2);
    assert.equal(forwardedEvents.some((event) => {
      const record = event as { type?: string; threadId?: string };
      return record.type === "thread_event" && record.threadId === "malformed-thread";
    }), false);
  } finally {
    await session.stop();
  }
});

test("attached runtime projects and resolves every current command approval decision", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket();
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    socket.emitServerRequest({
      id: 44,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "approval-thread",
        turnId: "approval-turn",
        itemId: "approval-item",
        command: "echo current",
        availableDecisions: [
          "decline",
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "current"] } },
          { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } },
          "accept",
          "decline",
          "acceptForSession",
          "cancel"
        ]
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const event = forwardedEvents.find((candidate) => {
      const value = candidate as { type?: string };
      return value.type === "approval_request";
    }) as { approval?: { approvalId?: string; availableDecisions?: unknown } } | undefined;
    assert.deepEqual(event?.approval?.availableDecisions, [
      "deny",
      { type: "accept_with_execpolicy_amendment", execpolicyAmendment: ["echo", "current"] },
      { type: "apply_network_policy_amendment", networkPolicyAmendment: { host: "example.com", action: "allow" } },
      "approve",
      "approve_for_session",
      "cancel"
    ]);
    assert.ok(callbacks);
    assert.ok(event?.approval?.approvalId);
    await callbacks.handleCommand({
      seq: 1,
      commandId: "approval-command",
      type: "approval_decision",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "approval-thread",
      approvalId: event.approval.approvalId,
      approvalDecision: {
        type: "accept_with_execpolicy_amendment",
        execpolicyAmendment: ["echo", "current"]
      }
    });
    assert.deepEqual(socket.clientResponses.at(-1), {
      id: 44,
      result: {
        decision: {
          acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "current"] }
        }
      }
    });

    socket.emitServerRequest({
      id: 45,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "approval-thread",
        turnId: "approval-turn",
        itemId: "structured-only-item",
        command: "echo structured",
        availableDecisions: [
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "structured"] } }
        ]
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const approvals = forwardedEvents.filter((candidate) => {
      const value = candidate as { type?: string };
      return value.type === "approval_request";
    }) as Array<{ approval?: { availableDecisions?: unknown } }>;
    assert.deepEqual(approvals[1]?.approval?.availableDecisions, [
      { type: "accept_with_execpolicy_amendment", execpolicyAmendment: ["echo", "structured"] }
    ]);

    socket.emitServerRequest({
      id: 46,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "approval-thread",
        turnId: "approval-turn",
        itemId: "network-item",
        command: "curl https://example.com",
        availableDecisions: [
          { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } }
        ]
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const networkEvent = [...forwardedEvents].reverse().find((candidate) => {
      const value = candidate as { approval?: { requestId?: unknown } };
      return value.approval?.requestId === 46;
    }) as { approval?: { approvalId?: string } } | undefined;
    const networkApprovalId = networkEvent?.approval?.approvalId;
    assert.ok(networkApprovalId);
    await callbacks.handleCommand({
      seq: 2,
      commandId: "network-approval-command",
      type: "approval_decision",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "approval-thread",
      approvalId: networkApprovalId,
      approvalDecision: {
        type: "apply_network_policy_amendment",
        networkPolicyAmendment: { host: "example.com", action: "allow" }
      }
    });
    assert.deepEqual(socket.clientResponses.at(-1), {
      id: 46,
      result: {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: "example.com", action: "allow" }
          }
        }
      }
    });
  } finally {
    await session.stop();
  }
});

test("runtime excludes resume turns and unsubscribes app-server thread records", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({
    validResume: true,
    turnPages: [
      [{ id: "newest-turn" }, { id: "next-newest-turn" }],
      [{ id: "old-turn" }]
    ]
  });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    await session.ensureThread("history-thread");
    assert.equal(socket.resumeParams.at(-1)?.excludeTurns, true);
    assert.equal(Object.hasOwn(socket.resumeParams.at(-1) ?? {}, "developerInstructions"), false);
    assert.ok(callbacks);
    const baseCommand = {
      seq: 1,
      commandId: "subscription-command",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "history-thread"
    };
    await callbacks.handleCommand({ ...baseCommand, type: "subscribe_thread_records" });
    assert.deepEqual(socket.turnsListParams.slice(0, 1), [
      {
        threadId: "history-thread",
        limit: 50,
        sortDirection: "desc",
        itemsView: "full"
      }
    ]);
    const snapshots = forwardedEvents.filter((event) =>
      (event as { type?: string }).type === "thread_turns_snapshot"
    ) as Array<{
      turns: Array<{ id?: string }>;
      head?: boolean;
      complete?: boolean;
      snapshotId?: string;
      page?: number;
    }>;
    assert.deepEqual(snapshots.slice(0, 1).map((snapshot) => ({
      ids: snapshot.turns.map((turn) => turn.id),
      head: snapshot.head,
      complete: snapshot.complete,
      page: snapshot.page
    })), [
      {
        ids: ["next-newest-turn", "newest-turn"],
        head: true,
        complete: false,
        page: 0
      }
    ]);
    assert.equal(typeof snapshots[0].snapshotId, "string");
    assert.equal(snapshots[0].complete, false);
    await callbacks.handleCommand({
      ...baseCommand,
      seq: 2,
      commandId: "history-page-command",
      type: "load_thread_history",
      historySnapshotId: snapshots[0].snapshotId,
      historyPage: 1
    });
    assert.deepEqual(socket.turnsListParams.at(-1), {
      threadId: "history-thread",
      cursor: "turn-page-1",
      limit: 50,
      sortDirection: "desc",
      itemsView: "full"
    });
    const loadedPage = forwardedEvents.filter((event) =>
      (event as { type?: string }).type === "thread_turns_snapshot"
    ).at(-1) as typeof snapshots[number];
    assert.deepEqual(loadedPage.turns.map((turn) => turn.id), ["old-turn"]);
    assert.equal(loadedPage.head, false);
    assert.equal(loadedPage.complete, true);
    assert.equal(loadedPage.snapshotId, snapshots[0].snapshotId);
    await callbacks.handleCommand({ ...baseCommand, seq: 3, commandId: "unsubscribe-command", type: "unsubscribe_thread_records" });
    assert.equal(socket.unsubscribeRequests, 1);
    await callbacks.handleCommand({ ...baseCommand, seq: 4, commandId: "resubscribe-command", type: "subscribe_thread_records" });
    assert.equal(socket.resumeRequests, 2);
    assert.equal(socket.resumeParams.at(-1)?.excludeTurns, true);
    const reboundHead = forwardedEvents.filter((event) =>
      (event as { type?: string; head?: boolean }).type === "thread_turns_snapshot"
      && (event as { head?: boolean }).head === true
    ).at(-1) as { snapshotId?: string } | undefined;
    assert.notEqual(reboundHead?.snapshotId, snapshots[0].snapshotId);
    await assert.rejects(callbacks.handleCommand({
      ...baseCommand,
      seq: 5,
      commandId: "stale-history-page-command",
      type: "load_thread_history",
      historySnapshotId: snapshots[0].snapshotId,
      historyPage: 1
    }), /Stale thread history snapshot/);
  } finally {
    await session.stop();
  }
});

test("runtime projects per-thread experimental background terminals and refreshes them", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({
    validResume: true,
    backgroundTerminals: [{
      itemId: "background-item",
      processId: "background-process",
      command: "pnpm run tts:script -- --script script.md",
      cwd: "/tmp/current-protocol",
      osPid: 12345,
      cpuPercent: 2.5,
      rssKb: 4096
    }]
  });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-background-terminals",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    assert.ok(callbacks);
    await callbacks.handleCommand({
      seq: 1,
      commandId: "background-subscription",
      type: "subscribe_thread_records",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "background-thread"
    });
    await waitForCondition(() => forwardedEvents.some((event) => {
      const value = event as { type?: string; threadId?: string; terminals?: unknown[] };
      return value.type === "thread_background_terminals"
        && value.threadId === "background-thread"
        && value.terminals?.length === 1;
    }));
    const event = [...forwardedEvents].reverse().find((candidate) => {
      const value = candidate as { type?: string; threadId?: string };
      return value.type === "thread_background_terminals" && value.threadId === "background-thread";
    }) as { terminals?: Array<Record<string, unknown>> } | undefined;
    assert.deepEqual(event?.terminals?.[0], socket.backgroundTerminals[0]);
    assert.equal(socket.backgroundTerminalParams.at(-1)?.threadId, "background-thread");

    socket.backgroundTerminals = [];
    await waitForCondition(() => forwardedEvents.some((candidate) => {
      const value = candidate as { type?: string; threadId?: string; terminals?: unknown[] };
      return value.type === "thread_background_terminals"
        && value.threadId === "background-thread"
        && value.terminals?.length === 0;
    }), 4_000);
  } finally {
    await session.stop();
  }
});

test("runtime retries a failed on-demand history page without rereading the head", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({
    validResume: true,
    failTurnPageOnce: 1,
    turnPages: [
      [{ id: "newest-turn" }],
      [{ id: "old-turn" }]
    ]
  });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    assert.ok(callbacks);
    const baseCommand = {
      seq: 1,
      commandId: "retry-subscription-command",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "retry-history-thread"
    };
    await callbacks.handleCommand({ ...baseCommand, type: "subscribe_thread_records" });
    const head = forwardedEvents.find((event) =>
      (event as { type?: string; head?: boolean }).type === "thread_turns_snapshot"
      && (event as { head?: boolean }).head === true
    ) as { snapshotId?: string } | undefined;
    assert.equal(typeof head?.snapshotId, "string");
    await assert.rejects(
      callbacks.handleCommand({
        ...baseCommand,
        commandId: "retry-history-page-command",
        type: "load_thread_history",
        historySnapshotId: head?.snapshotId,
        historyPage: 1
      }),
      /page 1 failed/
    );
    assert.equal(socket.turnsListParams.length, 2);
    await callbacks.handleCommand({
      ...baseCommand,
      commandId: "retry-history-page-command-2",
      type: "load_thread_history",
      historySnapshotId: head?.snapshotId,
      historyPage: 1
    });

    const snapshots = forwardedEvents.filter((event) =>
      (event as { type?: string }).type === "thread_turns_snapshot"
    ) as Array<{ snapshotId?: string; page?: number; complete?: boolean }>;
    assert.deepEqual(snapshots.map((snapshot) => snapshot.page), [0, 1]);
    assert.equal(snapshots[0].complete, false);
    assert.equal(snapshots[1].snapshotId, snapshots[0].snapshotId);
    assert.equal(snapshots[1].complete, true);
  } finally {
    await session.stop();
  }
});

test("runtime stabilizes a successful thread snapshot after a fresh resume", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({
    validResume: true,
    turnSnapshots: [
      [[{ id: "newest-turn" }]],
      [[{ id: "newest-turn" }, { id: "older-turn" }]],
      [[{ id: "newest-turn" }, { id: "older-turn" }]]
    ]
  });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    threadTurnsStabilizationDelaysMs: [5, 10],
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    assert.ok(callbacks);
    await callbacks.handleCommand({
      seq: 1,
      commandId: "stabilized-subscription",
      type: "subscribe_thread_records",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "stabilized-thread"
    });
    await waitForCondition(() => socket.turnsListParams.length >= 3);
    await delay(30);
    assert.equal(socket.turnsListParams.length, 3);
    const snapshots = forwardedEvents.filter((event) =>
      (event as { type?: string }).type === "thread_turns_snapshot"
    ) as Array<{ turns: Array<{ id?: string }>; head?: boolean; complete?: boolean }>;
    assert.deepEqual(snapshots.map((snapshot) => snapshot.turns.map((turn) => turn.id)), [
      ["newest-turn"],
      ["older-turn", "newest-turn"],
      ["older-turn", "newest-turn"]
    ]);
    assert.ok(snapshots.every((snapshot) => snapshot.head === true && snapshot.complete === true));
  } finally {
    await session.stop();
  }
});

test("runtime advances through an empty history page when the cursor advances", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({
    validResume: true,
    turnPages: [
      [{ id: "newest-turn" }],
      [],
      [{ id: "old-turn" }]
    ]
  });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    threadTurnsStabilizationDelaysMs: [],
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    assert.ok(callbacks);
    const baseCommand = {
      seq: 1,
      commandId: "empty-history-subscription",
      type: "subscribe_thread_records" as const,
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "empty-history-thread"
    };
    await callbacks.handleCommand(baseCommand);
    const head = forwardedEvents.find((event) => (event as { head?: boolean }).head === true) as { snapshotId: string };
    await callbacks.handleCommand({
      ...baseCommand,
      commandId: "empty-history-page-1",
      type: "load_thread_history",
      historySnapshotId: head.snapshotId,
      historyPage: 1
    });
    await callbacks.handleCommand({
      ...baseCommand,
      commandId: "empty-history-page-2",
      type: "load_thread_history",
      historySnapshotId: head.snapshotId,
      historyPage: 2
    });
    const snapshots = forwardedEvents.filter((event) =>
      (event as { type?: string }).type === "thread_turns_snapshot"
    ) as Array<{ page?: number; turns: unknown[]; complete?: boolean }>;
    assert.deepEqual(snapshots.map((snapshot) => snapshot.page), [0, 1, 2]);
    assert.deepEqual(snapshots[1].turns, []);
    assert.equal(snapshots[1].complete, false);
    assert.equal(snapshots[2].complete, true);
  } finally {
    await session.stop();
  }
});

test("runtime deduplicates concurrent history page loads and drops a page after unbind", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({
    validResume: true,
    delayTurnListResponseMs: 30,
    turnPages: [[{ id: "newest-turn" }], [{ id: "old-turn" }], [{ id: "oldest-turn" }]]
  });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    threadTurnsStabilizationDelaysMs: [],
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    assert.ok(callbacks);
    const baseCommand = {
      seq: 1,
      commandId: "dedupe-history-subscription",
      type: "subscribe_thread_records" as const,
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "dedupe-history-thread"
    };
    await callbacks.handleCommand(baseCommand);
    const head = forwardedEvents.find((event) => (event as { head?: boolean }).head === true) as { snapshotId: string };
    const first = callbacks.handleCommand({
      ...baseCommand,
      commandId: "dedupe-history-page-1",
      type: "load_thread_history",
      historySnapshotId: head.snapshotId,
      historyPage: 1
    });
    const second = callbacks.handleCommand({
      ...baseCommand,
      commandId: "dedupe-history-page-2",
      type: "load_thread_history",
      historySnapshotId: head.snapshotId,
      historyPage: 1
    });
    await Promise.all([first, second]);
    assert.equal(socket.turnsListParams.length, 2);

    const unboundLoad = callbacks.handleCommand({
      ...baseCommand,
      commandId: "unbind-race-page",
      type: "load_thread_history",
      historySnapshotId: head.snapshotId,
      historyPage: 2
    });
    await waitForCondition(() => socket.turnsListParams.length === 3);
    await callbacks.handleCommand({ ...baseCommand, commandId: "unbind-race", type: "unsubscribe_thread_records" });
    const result = await unboundLoad;
    assert.deepEqual(result, { loaded: false, snapshotId: head.snapshotId, page: 2, complete: false });
    assert.equal(forwardedEvents.filter((event) => (event as { type?: string }).type === "thread_turns_snapshot").length, 2);
  } finally {
    await session.stop();
  }
});

test("runtime rejects a repeated turns cursor instead of imposing a history page limit", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({
    validResume: true,
    repeatTurnCursor: true,
    turnPages: [
      [{ id: "newest-turn" }],
      [{ id: "old-turn" }]
    ]
  });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    assert.ok(callbacks);
    const baseCommand = {
      seq: 1,
      commandId: "repeated-cursor-subscription",
      type: "subscribe_thread_records" as const,
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "repeated-cursor-thread"
    };
    await callbacks.handleCommand({ ...baseCommand, type: "subscribe_thread_records" });
    const head = forwardedEvents.find((event) =>
      (event as { type?: string; head?: boolean }).type === "thread_turns_snapshot"
      && (event as { head?: boolean }).head === true
    ) as { snapshotId?: string } | undefined;
    assert.equal(typeof head?.snapshotId, "string");
    await assert.rejects(callbacks.handleCommand({
      ...baseCommand,
      commandId: "repeated-cursor-page",
      type: "load_thread_history",
      historySnapshotId: head?.snapshotId,
      historyPage: 1
    }), /repeated cursor/);
    assert.equal(socket.turnsListParams.length, 2);
    await callbacks.handleCommand({
      ...baseCommand,
      seq: 2,
      commandId: "repeated-cursor-unsubscribe",
      type: "unsubscribe_thread_records"
    });
  } finally {
    await session.stop();
  }
});

test("runtime retries explicit app-server overload responses", async (context) => {
  context.mock.method(console, "error", () => undefined);
  context.mock.method(Math, "random", () => 0);
  const socket = new CurrentProtocolSocket({ overloadOnceFor: "initialize" });
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory
  });
  try {
    assert.equal(socket.requestCount("initialize"), 2);
  } finally {
    await session.stop();
  }
});

test("runtime keeps JSON-RPC response errors out of the thread event stream", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({ errorFor: "thread/resume" });
  const forwardedEvents: unknown[] = [];
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, callbacks) => ({
      ...transportFactory(transportContext, callbacks),
      sendEvent: (event) => forwardedEvents.push(event)
    })
  });
  try {
    await assert.rejects(session.ensureThread("rpc-error-thread"), /thread\/resume failed/);
    assert.equal(forwardedEvents.some((event) => {
      const value = event as { type?: string; threadId?: string };
      return value.type === "thread_event" && value.threadId === "rpc-error-thread";
    }), false);
  } finally {
    await session.stop();
  }
});

test("runtime serializes app-server notifications before forwarding them", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket();
  const forwardedEvents: unknown[] = [];
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, callbacks) => ({
      ...transportFactory(transportContext, callbacks),
      sendEvent: (event) => forwardedEvents.push(event)
    })
  });
  try {
    const threadId = "ordered-notification-thread";
    socket.emitServerRequest({
      method: "thread/started",
      params: { thread: currentThread(threadId, "/tmp/current-protocol") }
    });
    socket.emitServerRequest({
      method: "item/completed",
      params: {
        threadId,
        turnId: "ordered-notification-turn",
        completedAtMs: 2_000,
        item: {
          id: "ordered-notification-item",
          type: "agentMessage",
          text: "second notification"
        }
      }
    });
    await waitForCondition(() => forwardedEvents.filter((event) => {
      const value = event as { type?: string; threadId?: string };
      return value.type === "thread_event" && value.threadId === threadId;
    }).length === 2);

    const methods = forwardedEvents.flatMap((event) => {
      const value = event as { type?: string; threadId?: string; message?: { method?: string } };
      return value.type === "thread_event" && value.threadId === threadId && value.message?.method
        ? [value.message.method]
        : [];
    });
    assert.deepEqual(methods, ["thread/started", "item/completed"]);
  } finally {
    await session.stop();
  }
});

test("runtime marks a fast turn/start response provisional before completion", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({
    validResume: true,
    completeTurnImmediately: true
  });
  const forwardedEvents: unknown[] = [];
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        ...transportFactory(transportContext, nextCallbacks),
        sendEvent: (event) => forwardedEvents.push(event)
      };
    }
  });
  try {
    assert.ok(callbacks);
    await callbacks.handleCommand({
      seq: 1,
      commandId: "immediate-command",
      type: "turn",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "immediate-thread",
      input: "finish immediately"
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const runningIndex = forwardedEvents.findIndex((event) => {
      const value = event as {
        type?: string;
        running?: boolean;
        turnId?: string;
        provisional?: boolean;
      };
      return value.type === "thread_execution_changed"
        && value.running === true
        && value.turnId === "immediate-turn"
        && value.provisional === true;
    });
    const completedIndex = forwardedEvents.findIndex((event) => {
      const value = event as { type?: string; message?: { method?: string } };
      return value.type === "thread_event" && value.message?.method === "turn/completed";
    });
    assert.ok(runningIndex >= 0);
    assert.ok(completedIndex > runningIndex);
    assert.equal(forwardedEvents.slice(completedIndex + 1).some((event) => {
      const value = event as { type?: string; running?: boolean; turnId?: string };
      return value.type === "thread_execution_changed"
        && value.running === true
        && value.turnId === "immediate-turn";
    }), false);
  } finally {
    await session.stop();
  }
});

test("attached runtime rejects app-server versions below the protocol baseline", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket({ userAgent: "codex_cli_rs/0.143.9" });
  await assert.rejects(
    startAttachedCodexhubSession({
      apiBase: "http://127.0.0.1:1",
      appServerUrl: "ws://127.0.0.1:1",
      machineId: "machine-current-protocol",
    appServerTransportFactory: async () => socket,
      cwd: "/tmp/current-protocol",
      transportFactory
    }),
    /0\.144\.4 or newer.*found 0\.143\.9/
  );
});

test("旧页响应不能覆盖后续头页的分页代次", async () => {
 const events: any[]=[];
 const socket=new CurrentProtocolSocket({validResume:true,turnPages:[[{id:"turn-head",items:[],status:"completed"}],[{id:"turn-old",items:[],status:"completed"}]]});
 const originalSend=socket.send.bind(socket);let pending:any;
 socket.send=(data:string)=>{const msg=JSON.parse(data);if(msg.method==="thread/turns/list"&&msg.params?.cursor){pending=msg;return;}originalSend(data);};
 let callbacks:any;
 const session=await startAttachedCodexhubSession({apiBase:"http://127.0.0.1:1",appServerUrl:"ws://127.0.0.1:1",machineId:"audit",cwd:"/tmp/current-protocol",appServerTransportFactory:async()=>socket,transportFactory:(context,next)=>{callbacks=next;return {...transportFactory(context,next),sendEvent:(e:any)=>events.push(e)};}});
 const command={seq:1,commandId:"start",type:"subscribe_thread_records",threadId:"thread-a",workingDirectory:"/tmp/current-protocol",createdAt:new Date().toISOString()};
 try{
 await callbacks.handleCommand(command);
 const headA=events.filter(e=>e.type==="thread_turns_snapshot"&&e.head).at(-1);
 const loading=callbacks.handleCommand({...command,type:"load_thread_history",commandId:"old",historySnapshotId:headA.snapshotId,historyPage:1});
 await waitForCondition(()=>!!pending);
 await callbacks.handleCommand({...command,commandId:"refresh"});
 const headB=events.filter(e=>e.type==="thread_turns_snapshot"&&e.head).at(-1);
 assert.notEqual(headA.snapshotId,headB.snapshotId);
 socket.emitServerRequest({id:pending.id,result:{data:[],nextCursor:"WRONG-OLD-CURSOR"}});
 let answer:any;try{answer=await loading;}catch(e){answer={loaded:false};}
 assert.equal(answer.loaded,false,"旧snapshot返回后应被丢弃，而不是覆盖新分页状态");
 }finally{await session.stop();}
});

test("历史cursor跨页循环必须立即拒绝", async () => {
 const events:any[]=[];
 const socket=new CurrentProtocolSocket({validResume:true,turnPages:[[{id:"head",items:[],status:"completed"}],[]]});
 const send=socket.send.bind(socket);
 socket.send=(data:string)=>{const msg=JSON.parse(data);if(msg.method==='thread/turns/list'&&msg.params?.cursor){queueMicrotask(()=>socket.emitServerRequest({id:msg.id,result:{data:[],nextCursor:msg.params.cursor==='turn-page-1'?'turn-page-2':'turn-page-1'}}));return;}send(data);};
 let callbacks:any;
 const session=await startAttachedCodexhubSession({apiBase:'http://127.0.0.1:1',appServerUrl:'ws://127.0.0.1:1',machineId:'cycle-audit',cwd:'/tmp/current-protocol',appServerTransportFactory:async()=>socket,transportFactory:(context,next)=>{callbacks=next;return {...transportFactory(context,next),sendEvent:(e:any)=>events.push(e)};}});
 const command={seq:1,commandId:'start',type:'subscribe_thread_records',threadId:'thread-a',workingDirectory:'/tmp/current-protocol',createdAt:new Date().toISOString()};
 try{
 await callbacks.handleCommand(command);
 const head=events.filter(e=>e.type==='thread_turns_snapshot'&&e.head).at(-1);
 await callbacks.handleCommand({...command,type:'load_thread_history',commandId:'page1',historySnapshotId:head.snapshotId,historyPage:1});
 await assert.rejects(callbacks.handleCommand({...command,type:'load_thread_history',commandId:'page2',historySnapshotId:head.snapshotId,historyPage:2}),/cursor/i);
 }finally{await session.stop();}
});
