import assert from "node:assert/strict";
import test from "node:test";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import {
  latestAgentMessageFromRecords,
  threadActivityTitleFromRecords
} from "../../src/shared/threadActivity.js";

const record = (id: string, payload: unknown): CodexRecord => ({
  id,
  type: "event_msg",
  payload
});

test("thread activity title gives the current Goal precedence over user input", () => {
  assert.equal(threadActivityTitleFromRecords([
    record("user-1", { type: "user_message", message: "first request" }),
    record("goal-1", {
      type: "thread_goal_updated",
      threadId: "thread-1",
      goal: { threadId: "thread-1", objective: "finish the implementation", status: "active" }
    }),
    record("user-2", { type: "user_message", message: "latest follow-up" })
  ], "thread-1"), "Goal: finish the implementation");
});

test("completed or cleared Goals fall back to the latest ordinary user input", () => {
  const user = record("user-1", { type: "user_message", message: "latest request" });
  assert.equal(threadActivityTitleFromRecords([
    user,
    record("goal-complete", {
      type: "thread_goal_updated",
      threadId: "thread-1",
      goal: { threadId: "thread-1", objective: "finished work", status: "complete" }
    })
  ], "thread-1"), "latest request");
  assert.equal(threadActivityTitleFromRecords([
    user,
    record("goal-clear", { type: "thread_goal_cleared", threadId: "thread-1" })
  ], "thread-1"), "latest request");
});

test("latest user message supports app-server content blocks and compacts long text", () => {
  const title = threadActivityTitleFromRecords([
    record("old", { type: "user_message", message: "old request" }),
    record("latest", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "line one" }, { type: "input_text", text: "line two" }]
    })
  ]);
  assert.equal(title, "line one line two");

  const longTitle = threadActivityTitleFromRecords([
    record("long", { type: "user_message", message: "x".repeat(200) })
  ]);
  assert.equal(longTitle?.length, 160);
  assert.equal(longTitle?.endsWith("…"), true);
});

test("latest Agent activity message follows the canonical commentary/final-answer order", () => {
  assert.equal(latestAgentMessageFromRecords([
    record("commentary-1", { type: "agent_message", phase: "commentary", message: "先检查运行状态" }),
    record("tool", { type: "function_call", name: "exec_command" }),
    record("final-1", { type: "agent_message", phase: "final_answer", message: "已经完成第一步" }),
    record("commentary-2", {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "继续处理第二步" }]
    })
  ]), "继续处理第二步");
});

test("latest Agent activity message ignores non-visible phases and compacts content", () => {
  const message = latestAgentMessageFromRecords([
    record("reasoning", { type: "agent_message", phase: "analysis", message: "internal" }),
    record("commentary", {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }]
    })
  ]);

  assert.equal(message, "line one line two");
});
