import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHub } from "../../src/core/threadHub.js";
import { countCompletedUserTurns } from "../../src/shared/taskNotifications.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { ThreadStreamEvent } from "../../src/shared/threadTypes.js";
import { defaultAppSettings } from "../../src/web/appConfig.js";

const userTurnRecords = (threadId: string, turnId: string, options: {
  includeUserMessage?: boolean;
  status?: "completed" | "aborted" | "inProgress";
  withSteer?: boolean;
} = {}): CodexRecord[] => {
  const records: CodexRecord[] = [];
  if (options.includeUserMessage !== false) {
    records.push({
      id: `app:${threadId}:${turnId}:user:msg-1`,
      sourceThreadId: threadId,
      timestamp: "2026-09-01T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        turn_id: turnId,
        message: `User prompt for ${turnId}`
      }
    });
  }
  if (options.withSteer) {
    records.push({
      id: `app:${threadId}:${turnId}:user:msg-steer`,
      sourceThreadId: threadId,
      timestamp: "2026-09-01T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        turn_id: turnId,
        message: `Steer prompt for ${turnId}`
      }
    });
  }
  if (options.status === "completed" || options.status === undefined) {
    records.push({
      id: `app:${threadId}:${turnId}:event:task_complete`,
      sourceThreadId: threadId,
      timestamp: "2026-09-01T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turnId
      }
    });
  } else if (options.status === "aborted") {
    records.push({
      id: `app:${threadId}:${turnId}:event:turn_aborted`,
      sourceThreadId: threadId,
      timestamp: "2026-09-01T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: turnId
      }
    });
  }
  return records;
};

test("countCompletedUserTurns accurately identifies valid turns and filters invalid/aborted/system turns", () => {
  const records: CodexRecord[] = [];
  for (let i = 1; i <= 9; i += 1) {
    records.push(...userTurnRecords("thread-1", `turn-${i}`, { status: "completed" }));
  }
  assert.equal(countCompletedUserTurns(records), 9);

  // Steer 指令使用相同的 turnId，不增加用户 turn 计数
  records.push(...userTurnRecords("thread-1", "turn-9", { withSteer: true }));
  assert.equal(countCompletedUserTurns(records), 9);

  // 失败或被取消的中断 turn（turn_aborted）不计入
  records.push(...userTurnRecords("thread-1", "turn-10-failed", { status: "aborted" }));
  assert.equal(countCompletedUserTurns(records), 9);

  // 纯系统或工具初始化 turn（无 user_message）不计入
  records.push(...userTurnRecords("thread-1", "turn-system", { includeUserMessage: false, status: "completed" }));
  assert.equal(countCompletedUserTurns(records), 9);

  // 完成第 10 次成功的用户 turn
  records.push(...userTurnRecords("thread-1", "turn-10", { status: "completed" }));
  assert.equal(countCompletedUserTurns(records), 10);
});

test("defaultAppSettings disables auto rename and uses a five-turn interval", () => {
  const defaults = defaultAppSettings();
  assert.equal(defaults.autoGenerateThreadTitle, false);
  assert.equal(defaults.autoGenerateThreadTitleInterval, 5);
});

const applyTurnToHub = (
  hub: ThreadHub,
  sessionId: string,
  threadId: string,
  turnId: string,
  options: {
    status?: "completed" | "aborted";
    includeUserMessage?: boolean;
  } = {}
) => {
  const items: unknown[] = [];
  if (options.includeUserMessage !== false) {
    items.push({
      id: `${turnId}-user-msg`,
      type: "userMessage",
      content: [{ type: "text", text: `Prompt for ${turnId}` }]
    });
  }
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: items[0] ?? { id: `${turnId}-sys`, type: "agentMessage", content: [{ type: "text", text: "sys" }] }
      }
    }
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status: options.status ?? "completed",
          startedAt: 1000,
          completedAt: 2000,
          items
        }
      }
    }
  });
};

test("server ThreadHub auto-rename: disabled does not trigger at the configured interval", async () => {
  const hub = new ThreadHub({}, {
    autoGenerateThreadTitleInterval: () => null
  });

  const sessionId = "session-test";
  const threadId = "thread-test";
  hub.registerSession({ sessionId, machineId: "machine-1", workingDirectory: "/tmp/project" });
  hub.attachSessionThread(sessionId, threadId, "/tmp/project");

  for (let i = 1; i <= 5; i += 1) {
    applyTurnToHub(hub, sessionId, threadId, `turn-${i}`);
  }

  // 检查是否有 suggest_thread_title 指令生成
  const batch = await hub.waitSessionCommands(sessionId, 0, 0);
  const suggestCommands = batch.commands.filter((c) => c.type === "suggest_thread_title");
  assert.equal(suggestCommands.length, 0, "No suggest command should be issued when feature is off");
});

test("server ThreadHub auto-rename: default live turns 1..4 do not trigger and the 5th turn does", async () => {
  const hub = new ThreadHub({}, {
    autoGenerateThreadTitleInterval: () => 5
  });

  const sessionId = "session-fresh-5";
  const threadId = "thread-fresh-5";
  hub.registerSession({ sessionId, machineId: "machine-1", workingDirectory: "/tmp/project" });
  hub.attachSessionThread(sessionId, threadId, "/tmp/project");

  // 1. 发送 live turns 1..4：不应触发
  for (let i = 1; i <= 4; i += 1) {
    applyTurnToHub(hub, sessionId, threadId, `turn-${i}`);
  }
  let batch = await hub.waitSessionCommands(sessionId, 0, 0);
  assert.equal(batch.commands.filter((c) => c.type === "suggest_thread_title").length, 0, "Turns 1..4 must not trigger suggest");

  // 2. 发送第 5 次 live turn：应准确触发 milestone 5 的 suggest_thread_title
  applyTurnToHub(hub, sessionId, threadId, "turn-5");
  batch = await hub.waitSessionCommands(sessionId, 0, 100);
  const suggestCmd = batch.commands.find((c) => c.type === "suggest_thread_title");
  assert.ok(suggestCmd, "5th completed user turn must trigger suggest_thread_title");

  // 响应并清理，避免悬挂
  hub.resolveSessionCommand(sessionId, suggestCmd.commandId, { title: "Fresh 5 Title" });
  const renameBatch = await hub.waitSessionCommands(sessionId, batch.cursor, 100);
  const renameCmd = renameBatch.commands.find((c) => c.type === "rename_thread");
  if (renameCmd) {
    hub.resolveSessionCommand(sessionId, renameCmd.commandId, undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hub.getThread(threadId)?.title, "Fresh 5 Title");
});

test("server ThreadHub auto-rename honors a custom three-turn interval", async () => {
  const hub = new ThreadHub({}, {
    autoGenerateThreadTitleInterval: () => 3
  });
  const sessionId = "session-custom-3";
  const threadId = "thread-custom-3";
  hub.registerSession({ sessionId, machineId: "machine-1", workingDirectory: "/tmp/project" });
  hub.attachSessionThread(sessionId, threadId, "/tmp/project");

  applyTurnToHub(hub, sessionId, threadId, "turn-1");
  applyTurnToHub(hub, sessionId, threadId, "turn-2");
  assert.equal((await hub.waitSessionCommands(sessionId, 0, 0)).commands.length, 0);

  applyTurnToHub(hub, sessionId, threadId, "turn-3");
  const batch = await hub.waitSessionCommands(sessionId, 0, 100);
  const suggestCmd = batch.commands.find((command) => command.type === "suggest_thread_title");
  assert.ok(suggestCmd, "Custom interval must trigger on its third completed user turn");
  hub.failSessionCommand(sessionId, suggestCmd.commandId, "test cleanup");
});

test("server ThreadHub auto-rename: historical snapshots do not trigger; live 10th turn triggers with 0 subscribers", async () => {
  const broadcastEvents: ThreadStreamEvent[] = [];
  const hub = new ThreadHub({}, {
    autoGenerateThreadTitleInterval: () => 5
  });

  const sessionId = "session-live";
  const threadId = "thread-live";
  hub.registerSession({ sessionId, machineId: "machine-1", workingDirectory: "/tmp/project" });

  // 1. 模拟历史 snapshot 加载 5 个 turns（historical: true）：验证不触发自动取名
  const historicalTurns = [];
  for (let i = 1; i <= 5; i += 1) {
    historicalTurns.push({
      id: `turn-hist-${i}`,
      status: "completed",
      startedAt: 1000 + i * 10,
      completedAt: 1005 + i * 10,
      items: [
        {
          id: `hist-msg-${i}`,
          type: "userMessage",
          content: [{ type: "text", text: `Hist prompt ${i}` }]
        }
      ]
    });
  }

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "thread/started",
      params: {
        thread: {
          id: threadId,
          cwd: "/tmp/project",
          turns: historicalTurns
        }
      }
    }
  });

  const thread = hub.getThread(threadId);
  assert.ok(thread);
  assert.equal(countCompletedUserTurns(thread.records), 5, "Historical records should reflect 5 completed user turns");

  let commandCursor = 0;
  let batch = await hub.waitSessionCommands(sessionId, commandCursor, 0);
  assert.equal(batch.commands.filter((c) => c.type === "suggest_thread_title").length, 0, "Historical snapshot must not trigger auto rename");

  // 2. 注册 2 个 stream 订阅者
  const unsubscribe1 = hub.subscribe(threadId, 0, (event) => broadcastEvents.push(event));
  const unsubscribe2 = hub.subscribe(threadId, 0, () => undefined);

  // 3. 发送 6..9 次 live turns：不触发
  for (let i = 6; i <= 9; i += 1) {
    applyTurnToHub(hub, sessionId, threadId, `turn-${i}`);
  }
  batch = await hub.waitSessionCommands(sessionId, commandCursor, 0);
  assert.equal(batch.commands.filter((c) => c.type === "suggest_thread_title").length, 0);

  // 4. 显式取消全部订阅（0 个订阅者），证明 server owner 独立处理 live completion
  unsubscribe1();
  unsubscribe2();

  // 5. 发送第 10 次 live turn：server 权威触发 milestone 10
  applyTurnToHub(hub, sessionId, threadId, "turn-10");
  batch = await hub.waitSessionCommands(sessionId, commandCursor, 100);
  const suggestCmd10 = batch.commands.find((c) => c.type === "suggest_thread_title");
  assert.ok(suggestCmd10, "Milestone 10 must trigger on server even with 0 active subscribers");
  commandCursor = batch.cursor;

  hub.resolveSessionCommand(sessionId, suggestCmd10.commandId, { title: "Title for Turn 10" });
  batch = await hub.waitSessionCommands(sessionId, commandCursor, 100);
  const renameCmd10 = batch.commands.find((c) => c.type === "rename_thread");
  assert.ok(renameCmd10);
  hub.resolveSessionCommand(sessionId, renameCmd10.commandId, undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(hub.getThread(threadId)?.title, "Title for Turn 10");

  // 6. 重复发送第 10 次 turn 完成（去重保护）：不应再次触发
  applyTurnToHub(hub, sessionId, threadId, "turn-10");
  batch = await hub.waitSessionCommands(sessionId, commandCursor, 0);
  assert.equal(batch.commands.filter((c) => c.type === "suggest_thread_title").length, 0);
});

test("server ThreadHub auto-rename: failure is best effort and does not block turn completion", async () => {
  const hub = new ThreadHub({}, {
    autoGenerateThreadTitleInterval: () => 5
  });

  const sessionId = "session-fail";
  const threadId = "thread-fail";
  hub.registerSession({ sessionId, machineId: "machine-1", workingDirectory: "/tmp/project" });
  hub.attachSessionThread(sessionId, threadId, "/tmp/project");

  for (let i = 1; i <= 4; i += 1) {
    applyTurnToHub(hub, sessionId, threadId, `turn-${i}`);
  }

  // 第 5 次 turn 到达
  applyTurnToHub(hub, sessionId, threadId, "turn-5");

  const batch = await hub.waitSessionCommands(sessionId, 0, 100);
  const suggestCmd = batch.commands.find((c) => c.type === "suggest_thread_title");
  assert.ok(suggestCmd);

  // 模拟 LLM 错误抛出异常
  hub.failSessionCommand(sessionId, suggestCmd.commandId, "LLM Rate limited");
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 验证 turn 正常保持完成，ThreadHub 没有挂起
  const thread = hub.getThread(threadId);
  assert.ok(thread);
  assert.equal(thread.running, false);
});
