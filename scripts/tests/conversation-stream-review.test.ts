import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { runConversation } from "../../src/cli/conversation.js";
import { ConversationStreamRenderer } from "../../src/cli/conversationStreamRenderer.js";

type Mode = "delayed" | "rejected" | "timeout" | "no-wait" | "budget";
const fixture = async (mode: Mode) => {
  const sockets = new Set<WebSocket>();
  let subscriptions = 0;
  const turns: string[] = [];
  const requests: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    for await (const _chunk of request) { /* consume request */ }
    if (mode === "budget") await delay(80);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/machines") {
      response.end(JSON.stringify({ machines: [{ machineId: "m", type: "local", online: true }] }));
    } else if (request.url?.includes("/turn")) {
      turns.push(request.url);
      response.end(JSON.stringify({ ok: true, delivery: "turn", submissionId: "submission", lastSeq: 10 }));
      if (mode === "delayed" || mode === "budget") {
        const timer = setTimeout(() => {
          timers.delete(timer);
          for (const socket of sockets) {
            socket.send(JSON.stringify({ type: "thread", kind: "thread", threadId: "t", historical: true, seq: 8,
              records: [record("late-history", "historical answer")] }));
            socket.send(JSON.stringify({ type: "record", kind: "record", threadId: "t", seq: 9,
              record: record("live", "new answer") }));
            socket.send(JSON.stringify({ type: "done", kind: "done", threadId: "t", seq: 10 }));
          }
        }, 30);
        timers.add(timer);
      }
    } else {
      response.end(JSON.stringify({ threadId: "t", workingDirectory: "/tmp", runtime: { machineId: "m" } }));
    }
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", socket => {
    subscriptions++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", () => {
      if (mode === "timeout") return;
      if (mode === "rejected") {
        socket.send(JSON.stringify({ type: "error", threadId: "t", message: "subscription refused" }));
        return;
      }
      socket.send(JSON.stringify({ type: "thread", kind: "thread", threadId: "t", historical: true, seq: 1,
        records: [record("old", "old answer")] }));
      socket.send(JSON.stringify({ type: "thread_subscribed", threadId: "t" }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`, sockets, turns, requests,
    get subscriptions() { return subscriptions; },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
};

const record = (id: string, text: string) => ({ id, type: "event_msg", payload: { type: "agent_message", message: text } });

test("conversation waits for delayed live barrier and excludes late historical records", async () => {
  const f = await fixture("delayed");
  try {
    const result = await runConversation({ baseUrl: f.url, operation: "send", threadId: "t", input: "hello", timeoutSeconds: 1 });
    assert.deepEqual(result.assistant, ["new answer"]);
  } finally { await f.close(); }
});

for (const mode of ["rejected", "timeout"] as const) {
  test(`conversation closes its socket after subscription ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(runConversation({ baseUrl: f.url, operation: "send", threadId: "t", input: "hello", timeoutSeconds: mode === "rejected" ? 1 : 0.05 }),
        mode === "rejected" ? /subscription refused/ : /timed out/);
      // Socket close is asynchronous; parallel suites may delay its delivery.
      const closeDeadline = Date.now() + 1000;
      while (f.sockets.size && Date.now() < closeDeadline) await delay(10);
      assert.equal(f.sockets.size, 0, "failed subscription must release its socket");
      assert.deepEqual(f.turns, [], "subscription failure must not submit a turn");
    } finally { await f.close(); }
  });
}

test("no-wait does not create a realtime subscription or request execution waiting", async () => {
  const f = await fixture("no-wait");
  try {
    const result = await runConversation({ baseUrl: f.url, operation: "send", threadId: "t", input: "hello", noWait: true });
    assert.equal(result.waited, false);
    assert.equal(f.subscriptions, 0);
    assert.deepEqual(f.turns, ["/api/threads/t/turn"]);
  } finally { await f.close(); }
});

test("interrupt before the next request prevents rename and turn submission", async () => {
  const f = await fixture("no-wait");
  try {
    await assert.rejects(runConversation({
      baseUrl: f.url, operation: "start", input: "hello", name: "cancelled", cwd: "/tmp", noWait: true,
      onThreadReady: () => { process.emit("SIGINT"); }
    }), /Interrupted/);
    assert.deepEqual(f.requests, ["GET /api/machines", "POST /api/machines/m/threads"]);
  } finally { await f.close(); }
});

test("conversation timeout is shared across preparation and execution phases", async () => {
  const f = await fixture("budget");
  try {
    await assert.rejects(runConversation({
      baseUrl: f.url, operation: "start", input: "hello", name: "budget", cwd: "/tmp", timeoutSeconds: 0.2
    }), /conversation timed out after 0.2s/);
    assert.equal(f.turns.length, 0, "an expired preparation budget must not submit a turn");
  } finally { await f.close(); }
});

test("tool completion prints one status and hides buffered output", () => {
  let output = "";
  const renderer = new ConversationStreamRenderer(chunk => { output += chunk; });
  const body = Array.from({ length: 300 }, (_, i) => `output-line-${String(i + 1).padStart(3, "0")}`).join("\n");
  const update = (status: string, aggregated_output: string) => renderer.event({
    kind: "record", threadId: "t", record: {
      id: "shell", type: "response_item", payload: {
        type: "local_shell_call", status, action: { type: "exec", command: ["printf"] }, aggregated_output
      }
    }
  });
  update("in_progress", "");
  update("in_progress", body);
  assert.ok(!output.includes("output-line-001"));
  update("completed", body);
  update("completed", body);
  assert.equal((output.match(/\[tool_result\]/g) ?? []).length, 1);
  assert.doesNotMatch(output, /output-line-/);
  assert.ok(!output.includes("output-line-150"));
});
