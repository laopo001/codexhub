import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHub } from "../../src/core/threadHub.js";

const applyCompaction = (
  hub: ThreadHub,
  sessionId: string,
  threadId: string,
  turnId: string,
  status: "completed" | "failed" = "completed"
) => {
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: `compaction-${turnId}`, type: "contextCompaction", status }
      }
    }
  });
};

const nextCommands = (hub: ThreadHub, sessionId: string, cursor = 0) =>
  hub.waitSessionCommands(sessionId, cursor, 100);

test("auto rename is disabled unless enabled", async () => {
  const hub = new ThreadHub({}, { autoGenerateThreadTitle: () => false });
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/project" });
  hub.attachSessionThread("session", "thread", "/tmp/project");

  applyCompaction(hub, "session", "thread", "turn-1");
  assert.equal((await nextCommands(hub, "session")).commands.length, 0);
});

test("each completed compaction triggers rename with all user messages and the previous title", async () => {
  const hub = new ThreadHub({}, { autoGenerateThreadTitle: () => true });
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/project" });
  hub.attachSessionThread("session", "thread", "/tmp/project");
  const thread = hub.getThread("thread");
  assert.ok(thread);
  thread.records.push(
    {
      id: "user-1",
      sourceThreadId: "thread",
      timestamp: "2026-09-01T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "First request" }
    },
    {
      id: "user-2",
      sourceThreadId: "thread",
      timestamp: "2026-09-01T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Second request" }]
      }
    }
  );

  applyCompaction(hub, "session", "thread", "turn-1");
  let batch = await nextCommands(hub, "session");
  const suggest = batch.commands.find((command) => command.type === "suggest_thread_title");
  assert.ok(suggest);
  assert.match(String(suggest.input), /Previous title: thread/);
  assert.match(String(suggest.input), /First request/);
  assert.match(String(suggest.input), /Second request/);

  hub.resolveSessionCommand("session", suggest.commandId, { title: "New title" });
  batch = await nextCommands(hub, "session", batch.cursor);
  const rename = batch.commands.find((command) => command.type === "rename_thread");
  assert.ok(rename);
  hub.resolveSessionCommand("session", rename.commandId, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hub.getThread("thread")?.title, "New title");

  applyCompaction(hub, "session", "thread", "turn-2");
  batch = await nextCommands(hub, "session", batch.cursor);
  assert.ok(batch.commands.some((command) => command.type === "suggest_thread_title"));
});

test("failed compaction does not trigger auto rename", async () => {
  const hub = new ThreadHub({}, { autoGenerateThreadTitle: () => true });
  hub.registerSession({ sessionId: "session", machineId: "machine", workingDirectory: "/tmp/project" });
  hub.attachSessionThread("session", "thread", "/tmp/project");

  applyCompaction(hub, "session", "thread", "turn-1", "failed");
  assert.equal((await nextCommands(hub, "session")).commands.length, 0);
});
