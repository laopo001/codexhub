import assert from "node:assert/strict";
import test from "node:test";
import {
  startAttachedCodexhubSession,
  type HeadlessSessionTransportCallbacks,
  type HeadlessSessionTransportFactory
} from "../../src/cli/codexhubSessionRuntime.js";
import type { AppServerSocketLike } from "../../src/core/appServerTunnel.js";

type Listener = {
  callback: (event: { data?: unknown }) => void;
  once: boolean;
};

class CurrentProtocolSocket implements AppServerSocketLike {
  readyState = 1;
  resumeRequests = 0;
  unsubscribeRequests = 0;
  readonly resumeParams: Record<string, unknown>[] = [];
  readonly clientResponses: Array<{ id: string | number; result: unknown }> = [];
  private readonly requestCounts = new Map<string, number>();
  private readonly listeners = new Map<"message" | "error" | "close", Listener[]>();

  constructor(private readonly options: {
    validResume?: boolean;
    overloadOnceFor?: string;
    errorFor?: string;
    completeTurnImmediately?: boolean;
    userAgent?: string;
  } = {}) {}

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
      result = { thread: currentThread("default-thread", stringParam(params, "cwd") ?? "/tmp/current-protocol") };
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
    } else if (message.method === "turn/start") {
      result = { turn: { id: "immediate-turn" } };
    }
    queueMicrotask(() => {
      this.emit("message", {
        data: JSON.stringify({ id: message.id, result })
      });
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
    });
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

test("attached runtime rejects and does not cache malformed thread/resume responses", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const socket = new CurrentProtocolSocket();
  const forwardedEvents: unknown[] = [];
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
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
  const socket = new CurrentProtocolSocket({ validResume: true });
  let callbacks: HeadlessSessionTransportCallbacks | undefined;
  const session = await startAttachedCodexhubSession({
    apiBase: "http://127.0.0.1:1",
    appServerUrl: "ws://127.0.0.1:1",
    appServerTransportFactory: async () => socket,
    cwd: "/tmp/current-protocol",
    transportFactory: (transportContext, nextCallbacks) => {
      callbacks = nextCallbacks;
      return transportFactory(transportContext, nextCallbacks);
    }
  });
  try {
    await session.ensureThread("history-thread");
    assert.equal(socket.resumeParams.at(-1)?.excludeTurns, true);
    assert.ok(callbacks);
    const baseCommand = {
      seq: 1,
      commandId: "subscription-command",
      workingDirectory: "/tmp/current-protocol",
      createdAt: new Date(0).toISOString(),
      threadId: "history-thread"
    };
    await callbacks.handleCommand({ ...baseCommand, type: "subscribe_thread_records" });
    await callbacks.handleCommand({ ...baseCommand, seq: 2, commandId: "unsubscribe-command", type: "unsubscribe_thread_records" });
    assert.equal(socket.unsubscribeRequests, 1);
    await callbacks.handleCommand({ ...baseCommand, seq: 3, commandId: "resubscribe-command", type: "subscribe_thread_records" });
    assert.equal(socket.resumeRequests, 2);
    assert.equal(socket.resumeParams.at(-1)?.excludeTurns, true);
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

test("runtime projects a fast turn/start response before its completion notification", async (context) => {
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
      const value = event as { type?: string; running?: boolean; turnId?: string };
      return value.type === "thread_execution_changed"
        && value.running === true
        && value.turnId === "immediate-turn";
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
      appServerTransportFactory: async () => socket,
      cwd: "/tmp/current-protocol",
      transportFactory
    }),
    /0\.144\.4 or newer.*found 0\.143\.9/
  );
});
