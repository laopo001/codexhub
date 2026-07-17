import assert from "node:assert/strict";
import test from "node:test";
import {
  startAttachedCodexhubSession,
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
  private readonly listeners = new Map<"message" | "error" | "close", Listener[]>();

  send(data: string) {
    const message = JSON.parse(data) as { id?: string | number; method?: string; params?: unknown };
    if (message.id === undefined) return;
    const params = message.params as { threadId?: string; cwd?: string } | undefined;
    let result: unknown = {};
    if (message.method === "thread/start") {
      result = { thread: currentThread("default-thread", params?.cwd ?? "/tmp/current-protocol") };
    } else if (message.method === "thread/resume") {
      this.resumeRequests += 1;
      result = { thread: {} };
    } else if (message.method === "thread/read") {
      result = { thread: currentThread(params?.threadId ?? "default-thread", "/tmp/current-protocol") };
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
    }
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({ id: message.id, result })
    }));
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

  private emit(type: "message" | "error" | "close", event: { data?: unknown }) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((listener) => !listener.once));
    for (const listener of listeners) listener.callback(event);
  }
}

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
