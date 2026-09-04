import assert from "node:assert/strict";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import test from "node:test";
import { ThreadHub } from "../../src/core/threadHub.js";
import { registerThreadRoutes } from "../../src/server/threadRoutes.js";

const sessionId = "history-pagination-session";
const threadId = "history-pagination-thread";

const turn = (index: number) => ({
  id: `turn-${index}`,
  status: "completed",
  startedAt: null,
  completedAt: null,
  items: [{
    type: "userMessage",
    id: `user-${index}`,
    content: [{ type: "text", text: `question ${index}` }]
  }]
});

const createHub = () => {
  const hub = new ThreadHub();
  hub.registerSession({ sessionId, machineId: sessionId, workingDirectory: "/tmp/history-pagination" });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [turn(2), turn(3)],
    snapshotId: "history-snapshot-1",
    page: 0,
    head: true,
    complete: false
  });
  return hub;
};

const applyPage = async (
  hub: ThreadHub,
  after: number,
  turns: unknown[],
  page: number,
  complete: boolean
) => {
  const commands = await hub.waitSessionCommands(sessionId, after, 1_000);
  const command = commands.commands.find((item) => item.type === "load_thread_history");
  assert.ok(command);
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns,
    snapshotId: command.historySnapshotId,
    page,
    head: false,
    complete
  });
  hub.resolveSessionCommand(sessionId, command.commandId, {
    loaded: true,
    snapshotId: command.historySnapshotId,
    page,
    complete
  });
  return { command, cursor: commands.cursor };
};

const routeContext = (hub: ThreadHub) => ({
  connectionSnapshotEvent: () => ({ seq: 0, kind: "connections" }),
  connectionSubscribers: new Set(),
  forceReleaseThreadRecordSubscription: () => undefined,
  markStaleSessions: () => ({ offline: 0, removed: 0 }),
  machines: {},
  projectSnapshotEvent: () => ({ seq: 0, kind: "projects" }),
  projectSubscribers: new Set(),
  publishProjects: () => undefined,
  releaseThreadRecordSubscription: () => undefined,
  retainThreadRecordSubscription: () => undefined,
  resolveDeveloperInstruction: () => null,
  taskSnapshotEvent: () => ({ seq: 0, kind: "tasks" }),
  taskSubscribers: new Set(),
  threads: hub,
  waitForSession: async () => undefined
});

test("history HTTP await drives one page at a time and returns complete records without duplicates", async () => {
  const hub = createHub();
  const head = hub.getThreadPage(threadId, { limit: 50 });
  const before = head.history?.oldestRecordId;
  assert.ok(before);
  assert.equal(head.history?.hasOlder, true);

  const pending = hub.loadThreadHistoryPage(threadId, { before, limit: 4 });
  const first = await applyPage(hub, 0, [turn(1)], 1, false);
  const second = await applyPage(hub, first.cursor, [turn(0)], 2, true);
  const page = await pending;

  assert.equal(second.command.historySnapshotId, first.command.historySnapshotId);
  assert.deepEqual(page.history, {
    hasOlder: false,
    oldestRecordId: page.records[0]?.id,
    newestRecordId: page.records.at(-1)?.id,
    loadedRecordCount: page.records.length
  });
  assert.equal(new Set(page.records.map((record) => record.id)).size, page.records.length);
  assert.equal(hub.getThread(threadId)?.records.length, new Set(hub.getThread(threadId)?.records.map((record) => record.id)).size);
});

test("history page requests for the same snapshot and page share one command", async () => {
  const hub = createHub();
  const head = hub.getThreadPage(threadId, { limit: 50 });
  const before = head.history?.oldestRecordId;
  assert.ok(before);

  const first = hub.loadThreadHistoryPage(threadId, { before, limit: 24 });
  const second = hub.loadThreadHistoryPage(threadId, { before, limit: 24 });
  const page = await applyPage(hub, 0, [turn(1), turn(0)], 1, true);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(page.command.type, "load_thread_history");
  assert.deepEqual(firstResult.records.map((record) => record.id), secondResult.records.map((record) => record.id));
  assert.equal((await hub.waitSessionCommands(sessionId, page.cursor, 1)).commands.length, 0);
});

test("a refreshed live head retains already cached older records", () => {
  const hub = createHub();
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [turn(1)],
    snapshotId: "history-snapshot-1",
    page: 1,
    head: false,
    complete: true
  });
  const olderRecordId = hub.getThread(threadId)?.records.find((record) => record.id.includes("turn-1"))?.id;
  assert.ok(olderRecordId);

  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [turn(2), turn(3)],
    snapshotId: "history-snapshot-2",
    page: 0,
    head: true,
    complete: false
  });
  assert.equal(hub.getThread(threadId)?.records.some((record) => record.id === olderRecordId), true);
});

test("history HTTP uses the current snapshot after a reconnect and does not append an old page", async () => {
  const hub = createHub();
  const head = hub.getThreadPage(threadId, { limit: 50 });
  const before = head.history?.oldestRecordId;
  assert.ok(before);
  const pending = hub.loadThreadHistoryPage(threadId, { before, limit: 24 });
  const oldCommandBatch = await hub.waitSessionCommands(sessionId, 0, 1_000);
  const oldCommand = oldCommandBatch.commands.find((item) => item.type === "load_thread_history");
  assert.ok(oldCommand);

  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [turn(2), turn(3)],
    snapshotId: "history-snapshot-2",
    page: 0,
    head: true,
    complete: false
  });
  hub.resolveSessionCommand(sessionId, oldCommand.commandId, {
    loaded: false,
    snapshotId: oldCommand.historySnapshotId,
    page: 1,
    complete: false
  });

  const next = await applyPage(hub, oldCommandBatch.cursor, [turn(1), turn(0)], 1, true);
  const result = await pending;
  assert.equal(next.command.historySnapshotId, "history-snapshot-2");
  assert.equal(result.history?.hasOlder, false);
  assert.equal(result.records.some((record) => record.id.includes("turn-99")), false);
});

test("HTTP history route awaits the async history loader", async () => {
  const app = Fastify();
  await app.register(websocket);
  const detail = {
    threadId,
    workingDirectory: "/tmp/history-pagination",
    runtime: { machineId: sessionId, online: true, runnable: true },
    status: "idle",
    running: false,
    title: "history",
    updatedAt: new Date(0).toISOString(),
    messageCount: 1,
    threadUsage: {},
    records: [],
    lastSeq: 0,
    history: { hasOlder: false, loadedRecordCount: 0 }
  };
  let calls = 0;
  registerThreadRoutes(app, {
    ...routeContext({
      loadThreadHistoryPage: async () => {
        calls += 1;
        return detail;
      }
    } as unknown as ThreadHub),
    threads: {
      loadThreadHistoryPage: async () => {
        calls += 1;
        return detail;
      }
    }
  } as never);
  const response = await app.inject({
    method: "GET",
    url: `/api/threads/${threadId}/history?before=record-1&limit=24`
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(response.json().history.hasOlder, false);
  await app.close();
});

test("无效 record cursor 立即拒绝，不能触发全历史扫描", async () => {
  const hub = createHub();
  await assert.rejects(hub.loadThreadHistoryPage(threadId, { before: "invalid-record", limit: 24 }), /cursor not found/);
  const batch = await hub.waitSessionCommands(sessionId, 0, 1);
  assert.equal(batch.commands.some((command) => command.type === "load_thread_history"), false);
});

test("从按需加载的旧消息 Fork 仍使用对应的官方 turn ID", async () => {
  const hub = createHub();
  const before = hub.getThreadPage(threadId).history?.oldestRecordId;
  assert.ok(before);
  const loading = hub.loadThreadHistoryPage(threadId, { before, limit: 24 });
  const olderTurn = turn(1);
  const loaded = await applyPage(hub, 0, [{
    ...olderTurn,
    items: [...olderTurn.items, { type: "agentMessage", id: "older-answer", text: "旧回复", phase: "final_answer" }]
  }], 1, true);
  const page = await loading;
  const record = page.records.find((item) => item.id.endsWith(":agent:older-answer"));
  assert.ok(record);
  const sourceIds = hub.getThread(threadId)!.records.map((item) => item.id);
  const fork = hub.forkThread(threadId, record.id);
  const batch = await hub.waitSessionCommands(sessionId, loaded.cursor, 1_000);
  const command = batch.commands.find((item) => item.type === "fork_thread");
  assert.ok(command);
  assert.equal(command.lastTurnId, "turn-1");
  assert.equal(command.threadId, threadId);
  hub.resolveSessionCommand(sessionId, command.commandId, { threadId: "forked-thread" });
  await fork;
  assert.deepEqual(hub.getThread(threadId)!.records.map((item) => item.id), sourceIds);
});
