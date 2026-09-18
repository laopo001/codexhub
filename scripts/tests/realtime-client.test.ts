import assert from "node:assert/strict";
import test from "node:test";
import { CodexHubRealtimeClient, parseRealtimeMessage } from "../../src/shared/realtimeClient.js";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function"
      ? listener as unknown as Listener
      : ((event: { data?: unknown }) => listener.handleEvent(event as unknown as Event));
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  send(value: string) {
    this.sent.push(JSON.parse(value) as Record<string, unknown>);
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  message(value: unknown) {
    this.emit("message", JSON.stringify(value));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  private emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

test("realtime client replays advanced cursors and thread subscriptions after reconnect", async () => {
  const sockets: FakeSocket[] = [];
  const client = new CodexHubRealtimeClient({
    url: "ws://localhost/api/events/ws",
    reconnectDelayMs: 0,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    onMessage: () => undefined
  });

  client.connect();
  client.subscribeThread("thread-1");
  sockets[0].open();
  assert.deepEqual(sockets[0].sent, [
    { type: "hello", runtimesAfter: 0, projectsAfter: 0, tasksAfter: 0, connectionsAfter: 0 },
    { type: "subscribe_thread", threadId: "thread-1", after: 0 }
  ]);

  sockets[0].message({ type: "runtimes", seq: 7 });
  sockets[0].message({
    type: "record_delta",
    seq: 5,
    thread: { threadId: "thread-1" },
    delta: { recordId: "record-1", field: "aggregated_output", append: "next" }
  });
  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);

  sockets[1].open();
  assert.deepEqual(sockets[1].sent, [
    { type: "hello", runtimesAfter: 7, projectsAfter: 0, tasksAfter: 0, connectionsAfter: 0 },
    { type: "subscribe_thread", threadId: "thread-1", after: 5 }
  ]);
  client.disconnect();
});

test("realtime canonical snapshots reset a stale thread cursor", async () => {
  const sockets: FakeSocket[] = [];
  const client = new CodexHubRealtimeClient({
    url: "ws://localhost/api/events/ws",
    reconnectDelayMs: 0,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    onMessage: () => undefined
  });

  client.connect();
  client.subscribeThread("thread-1", 100);
  sockets[0].open();
  sockets[0].message({
    type: "thread",
    seq: 2,
    thread: { threadId: "thread-1" },
    snapshot: {
      snapshotId: "snapshot-1",
      page: 0,
      reset: true,
      complete: true
    },
    records: []
  });
  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  sockets[1].open();

  assert.deepEqual(sockets[1].sent.at(-1), {
    type: "subscribe_thread",
    threadId: "thread-1",
    after: 2
  });
  client.disconnect();
});

test("realtime client does not commit a paged snapshot cursor before the final page", async () => {
  const sockets: FakeSocket[] = [];
  const client = new CodexHubRealtimeClient({
    url: "ws://localhost/api/events/ws",
    reconnectDelayMs: 0,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    onMessage: () => undefined
  });

  client.connect();
  client.subscribeThread("thread-1", 100);
  sockets[0].open();
  sockets[0].message({
    type: "thread",
    seq: 2,
    thread: { threadId: "thread-1" },
    snapshot: {
      snapshotId: "snapshot-1",
      page: 0,
      reset: true,
      complete: false
    },
    records: [{ id: "page-0" }]
  });
  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  sockets[1].open();

  assert.deepEqual(sockets[1].sent.at(-1), {
    type: "subscribe_thread",
    threadId: "thread-1",
    after: 100
  });

  sockets[1].message({
    type: "thread",
    seq: 2,
    thread: { threadId: "thread-1" },
    snapshot: {
      snapshotId: "snapshot-2",
      page: 0,
      reset: true,
      complete: false
    },
    records: [{ id: "page-0" }]
  });
  sockets[1].message({
    type: "thread",
    seq: 2,
    thread: { threadId: "thread-1" },
    snapshot: {
      snapshotId: "snapshot-2",
      page: 1,
      reset: false,
      complete: true
    },
    records: [{ id: "page-1" }]
  });
  sockets[1].close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  sockets[2].open();

  assert.deepEqual(sockets[2].sent.at(-1), {
    type: "subscribe_thread",
    threadId: "thread-1",
    after: 2
  });
  client.disconnect();
});

test("realtime parser rejects malformed and unknown messages", () => {
  assert.equal(parseRealtimeMessage("not-json"), null);
  assert.equal(parseRealtimeMessage(JSON.stringify({ type: "unknown" })), null);
  assert.deepEqual(parseRealtimeMessage(JSON.stringify({ kind: "projects", seq: 2 })), {
    kind: "projects",
    seq: 2,
    type: "projects"
  });
});

test("open tabs replay after reconnect and wait for server capability before announcing", async () => {
  const sockets: FakeSocket[] = [];
  const client = new CodexHubRealtimeClient({
    url: "ws://localhost/api/events/ws",
    reconnectDelayMs: 0,
    webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
    onMessage: () => undefined
  });
  const tabs = [{ machineId: "ssh", threadId: "remote", workingDirectory: "/workspace" }];
  client.setOpenThreads(tabs);
  client.connect();
  sockets[0].open();
  sockets[0].message({ type: "ready" });
  assert.equal(sockets[0].sent.some((message) => message.type === "set_open_threads"), false);
  sockets[0].message({ type: "ready", openThreadPresence: true });
  assert.deepEqual(sockets[0].sent.at(-1), { type: "set_open_threads", threads: tabs });
  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  sockets[1].open();
  assert.equal(sockets[1].sent.some((message) => message.type === "set_open_threads"), false);
  sockets[1].message({ type: "ready", openThreadPresence: true });
  assert.deepEqual(sockets[1].sent.at(-1), { type: "set_open_threads", threads: tabs });
  client.setOpenThreads([]);
  assert.deepEqual(sockets[1].sent.at(-1), { type: "set_open_threads", threads: [] });
  client.disconnect();
});
