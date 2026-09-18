import assert from "node:assert/strict";
import test from "node:test";
import { codexhubToolStatus } from "../src/web/helpers/codexhubToolStatus.js";
import { codexhubAttachedThread, type CodexhubToolCall } from "../src/web/helpers/codexhubToolCall.js";
import type { RuntimeSummary } from "../src/web/types.js";

const threadId = "01a086e5-6aa1-7171-b56c-a7b1b3f353d4";
const call = (operation: CodexhubToolCall["invocation"]["operation"], overrides: Partial<CodexhubToolCall> = {}): CodexhubToolCall => ({
  parentThreadId: "parent", recordId: operation, invocation: { operation, threadId },
  threadId, lastOperation: operation, status: "completed", output: "", ...overrides
});
const target = (online = true, running = true, status = "running") => codexhubAttachedThread(threadId, [{
  machineId: "local", online, threads: [{ threadId, running, status }]
}] as RuntimeSummary[]);
const stopReceipt = `Stopped thread ${threadId}; canonical running=false.`;
const endReceipt = `Ended delegation for thread ${threadId}; cancelled 0 queued message(s), canonical running=false; history retained and the thread remains resumable.`;

test("command failures and interruptions take precedence over all current thread states", () => {
  for (const [operation, verb] of [["start", "启动"], ["send", "发送"], ["stop", "停止"], ["end", "结束"]] as const) {
    for (const current of [target(), target(true, false, "idle"), target(true, true, "waiting"), target(false), undefined]) {
      for (const mode of ["history", "task"] as const) {
        assert.deepEqual(codexhubToolStatus(call(operation, { status: "failed" }), current, mode), { text: `${verb}失败`, running: false });
        assert.deepEqual(codexhubToolStatus(call(operation, { status: "terminated" }), current, mode), {
          text: operation === "start" ? "监听已中断" : `${verb}已中断`, running: false
        });
      }
    }
  }
});

test("pending and executing controls do not report a missing confirmation prematurely", () => {
  for (const [operation, verb] of [["start", "启动"], ["send", "发送"], ["stop", "停止"], ["end", "结束"]] as const) {
    for (const mode of ["history", "task"] as const) {
      const pending = call(operation, { status: "pending", threadId: operation === "start" ? undefined : threadId });
      assert.deepEqual(codexhubToolStatus(pending, target(), mode), { text: `等待${verb}`, running: false });
      assert.deepEqual(codexhubToolStatus({ ...pending, status: "in_progress" }, target(), mode), { text: `${verb}中`, running: true });
    }
  }
});

test("history cards keep command outcomes when the thread runs again or goes offline", () => {
  const cases = [
    [call("start", { status: "in_progress" }), "已启动"],
    [call("send"), "已发送"],
    [call("stop", { output: stopReceipt }), "已停止"],
    [call("stop", { output: `Thread ${threadId} was already idle; canonical running=false.` }), "原已空闲"],
    [call("end", { output: endReceipt }), "已结束"]
  ] as const;
  for (const [command, text] of cases) {
    for (const current of [target(), target(false), undefined]) {
      assert.deepEqual(codexhubToolStatus(command, current), { text, running: false });
    }
  }
  assert.equal(codexhubToolStatus(call("start", { threadId: undefined }), target()).text, "未获取 Thread ID");
});

test("floating tasks show live state only after successful commands", () => {
  for (const command of [call("start", { status: "in_progress" }), call("send"), call("stop", { output: stopReceipt })]) {
    assert.deepEqual(codexhubToolStatus(command, target(), "task"), { text: "运行中", running: true });
    assert.deepEqual(codexhubToolStatus(command, target(true, true, "waiting"), "task"), { text: "等待输入", running: false });
    assert.equal(codexhubToolStatus(command, target(true, false, "idle"), "task").text, "待续接");
    assert.equal(codexhubToolStatus(command, target(false), "task").text, "离线");
    assert.equal(codexhubToolStatus(command, undefined, "task").text, "当前后端未找到线程");
  }
});

test("control confirmation requires the correct thread and is rejected after failure or termination", () => {
  for (const [operation, receipt, verb] of [["stop", stopReceipt, "停止"], ["end", endReceipt, "结束"]] as const) {
    for (const output of ["", receipt.replace(threadId, "01a086e5-6aa1-7171-b56c-a7b1b3f353d5")]) {
      assert.equal(codexhubToolStatus(call(operation, { output }), target(), "task").text, `${verb}未确认`);
    }
    assert.equal(codexhubToolStatus(call(operation, { output: receipt, status: "failed" }), target()).text, `${verb}失败`);
    assert.equal(codexhubToolStatus(call(operation, { output: receipt, status: "terminated" }), target()).text, `${verb}已中断`);
  }
});
