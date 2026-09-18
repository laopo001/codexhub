import assert from "node:assert/strict";
import test from "node:test";
import { recordsToViews } from "../src/core/codexRecordView.js";
import {
  aggregateCodexhubToolTasks,
  codexhubAttachedThread,
  codexhubEndReceiptMatches,
  codexhubStopReceipt,
  codexhubToolCallFromMessage,
  refreshCodexhubToolCall
} from "../src/web/helpers/codexhubToolCall.js";
import type { CodexRecord } from "../src/shared/recordTypes.js";
import type { RuntimeSummary, WebRecordView } from "../src/web/types.js";

const childId = "01a0803a-5615-7d80-98f4-68d74f89185b";
const command = [
  `/usr/bin/zsh -lc "codexhub start - --name 'Breeze dialogue repair' --cwd /workspace/videos --model gpt-5.6-luna --effort xhigh <<'TASK'`,
  "Review the dialogue instructions and keep the existing voice bindings.",
  "TASK\""
].join("\n");
const shell = (output: string, status: "in_progress" | "completed" = "in_progress"): WebRecordView => recordsToViews([{ id: "shell", type: "response_item", payload: {
  type: "local_shell_call", call_id: "shell-call", status, action: { command: [command] }, aggregated_output: output
} }])[0];

test("CLI shell preview learns start ID only from output and refreshes detached progress", () => {
  const initial = codexhubToolCallFromMessage(shell(""), "parent")!;
  assert.equal(initial.invocation.name, "Breeze dialogue repair");
  assert.equal(initial.status, "in_progress");
  assert.equal(initial.threadId, undefined);
  const updated = shell(`Thread ID: ${childId}\n[commentary]\nReviewing the dialogue instructions.`, "completed");
  const call = refreshCodexhubToolCall(initial, [updated.record]);
  assert.equal(call.threadId, childId);
  assert.equal(call.status, "completed");
  assert.match(call.output, /Reviewing the dialogue instructions/);
});

test("function-call preview uses associated inspector output", () => {
  const [view] = recordsToViews([{ id: "exec", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: command }) } }]);
  const call = codexhubToolCallFromMessage({ ...view, inspectText: `Thread ID: ${childId}\nprogress` }, "parent");
  assert.equal(call?.threadId, childId);
  assert.equal(codexhubToolCallFromMessage({ ...view, record: { ...view.record, payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `echo '${command}'` }) } } }, "parent"), null);
});

test("thread preview resolves exact advertised thread and never guesses a backend", () => {
  const runtimes = ["a", "b"].map(machineId => ({ machineId, online: true, threads: [{ threadId: childId }] })) as RuntimeSummary[];
  assert.equal(codexhubAttachedThread(childId, runtimes), undefined);
  assert.equal(codexhubAttachedThread(childId, runtimes, "b")?.runtime.machineId, "b");
  assert.equal(codexhubAttachedThread("missing", runtimes), undefined);
  assert.equal(codexhubAttachedThread(undefined, runtimes), undefined);
});

const record = (id: string, command: string, output: string, status: "in_progress" | "completed" = "completed"): CodexRecord => ({
  id,
  type: "response_item",
  payload: {
    type: "local_shell_call",
    call_id: id,
    status,
    action: { command: [command] },
    aggregated_output: output
  }
});

const start = (id: string, name: string, threadId: string, output = `Thread ID: ${threadId}`) =>
  record(id, `codexhub start 'start ${name}' --name '${name}'`, output);
const send = (id: string, threadId: string, output: string, input = "follow up") =>
  record(id, `codexhub send ${threadId} '${input}'`, output);
const stop = (id: string, threadId: string, output = "stopped") =>
  record(id, `codexhub stop ${threadId}`, output);
const end = (id: string, threadId: string, output: string, status: "in_progress" | "completed" = "completed") =>
  record(id, `codexhub end ${threadId}`, output, status);

test("task aggregation deduplicates starts, updates from send, retains idle rows, and ignores unrelated sends", () => {
  const first = "01a0803a-5615-7d80-98f4-68d74f89185b";
  const second = "01a0803a-5615-7d80-98f4-68d74f89186c";
  const unrelated = "01a0803a-5615-7d80-98f4-68d74f89186d";
  const initialRecords = [start("start-a", "A", first), start("start-a-duplicate", "A duplicate", first), start("start-b", "B", second), send("send-unrelated", unrelated, "ignored")];
  let state = aggregateCodexhubToolTasks(undefined, "parent", initialRecords);
  assert.deepEqual(state.tasks.map(task => task.invocation.name), ["A", "B"]);
  assert.equal(state.tasks.find(task => task.threadId === first)?.message, "start A");

  const oldSend = send("send-a-old", first, "updated by old send", "old send");
  const latestSend = send("send-a-latest", first, "updated by send", "latest send");
  state = aggregateCodexhubToolTasks(state, "parent", [...initialRecords, oldSend, latestSend]);
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks.find(task => task.threadId === first)?.output, "updated by send");
  assert.equal(state.tasks.find(task => task.threadId === first)?.message, "latest send");

  state = aggregateCodexhubToolTasks(state, "parent", [...initialRecords, oldSend]);
  assert.equal(state.tasks.length, 2, "a narrower history window must not remove an idle task");
  assert.equal(state.tasks.find(task => task.threadId === first)?.message, "latest send", "an older send must not revert the latest message");
});

test("real single-element zsh records update the row through multiple sends and survive history narrowing", () => {
  const threadId = "01a0803a-5615-7d80-98f4-68d74f89185b";
  const serialized = (operation: "start" | "send", input: string, recordId: string) => {
    const command = operation === "start"
      ? [
          `/usr/bin/zsh -lc "codexhub start - --name 'real record' <<'TASK'`,
          input,
          "TASK\""
        ].join("\n")
      : [
          `/usr/bin/zsh -lc "codexhub send ${threadId} - <<'TASK'`,
          input,
          "TASK\""
        ].join("\n");
    return record(recordId, command, operation === "start" ? `Thread ID: ${threadId}` : `accepted ${recordId}`);
  };
  const initial = serialized("start", "start instruction", "real-start");
  const firstSend = serialized("send", "first latest instruction", "real-send-1");
  const secondSend = serialized("send", "second latest instruction", "real-send-2");
  const compound = record(
    "real-compound",
    `kill -TERM 123\ncodexhub send ${threadId} - <<'TASK'\nunsafe\nTASK`,
    "should be ignored"
  );

  let state = aggregateCodexhubToolTasks(undefined, "parent", [initial]);
  assert.equal(state.tasks[0]?.message, "start instruction");
  state = aggregateCodexhubToolTasks(state, "parent", [initial, firstSend, compound]);
  assert.equal(state.tasks[0]?.message, "first latest instruction");
  state = aggregateCodexhubToolTasks(state, "parent", [initial, firstSend, secondSend, compound]);
  assert.equal(state.tasks[0]?.message, "second latest instruction");
  state = aggregateCodexhubToolTasks(state, "parent", [initial, firstSend, compound]);
  assert.equal(state.tasks[0]?.message, "second latest instruction", "an older send must not win after history narrows");
});

test("stop and unconfirmed end do not replace the latest send message", () => {
  const threadId = "01a0803a-5615-7d80-98f4-68d74f89185b";
  const initial = start("start", "A", threadId);
  let state = aggregateCodexhubToolTasks(undefined, "parent", [initial, send("send", threadId, "sent", "keep this message")]);
  state = aggregateCodexhubToolTasks(state, "parent", [
    initial,
    send("send", threadId, "sent", "keep this message"),
    stop("stop", threadId),
    end("end", threadId, "end was not confirmed")
  ]);
  assert.equal(state.tasks[0]?.invocation.name, "A");
  assert.equal(state.tasks[0]?.message, "keep this message");
  assert.equal(state.tasks[0]?.lastOperation, "end");
  assert.equal(state.tasks[0]?.status, "completed");
});

test("failed or unconfirmed end retains the task, while an exact successful receipt tombstones it", () => {
  const threadId = "01a0803a-5615-7d80-98f4-68d74f89185b";
  let state = aggregateCodexhubToolTasks(undefined, "parent", [start("start", "A", threadId)]);
  const failedText = `Error: Ended delegation for thread ${threadId}; canonical running=false.`;
  state = aggregateCodexhubToolTasks(state, "parent", [start("start", "A", threadId), end("failed-end", threadId, failedText, "completed")]);
  assert.equal(state.tasks.length, 1, "a failed end must remain visible");

  const success = `Ended delegation for thread ${threadId}; cancelled 0 queued message(s), canonical running=false; history retained and the thread remains resumable.`;
  state = aggregateCodexhubToolTasks(state, "parent", [start("start", "A", threadId), end("end", threadId, success)]);
  assert.equal(state.tasks.length, 0);
  state = aggregateCodexhubToolTasks(state, "parent", [start("start", "A", threadId)]);
  assert.equal(state.tasks.length, 0, "the end tombstone must prevent a later history start from reviving the task");
});

test("JSON end receipt removes only the exact child and clears a pending start", () => {
  const threadId = "01a0803a-5615-7d80-98f4-68d74f89185b";
  const json = JSON.stringify({ operation: "end", threadId, stopped: true, running: false, idle: true, cancelledSubmissionIds: [], queueRemaining: 0, historyRetained: true, resumable: true });
  let state = aggregateCodexhubToolTasks(undefined, "parent", [start("start", "A", threadId, "")]);
  assert.equal(state.tasks.length, 1);
  state = aggregateCodexhubToolTasks(state, "parent", [start("start", "A", threadId), end("end", threadId, json)]);
  assert.equal(state.tasks.length, 0);
});

test("a failed start without a child ID does not leave a permanent placeholder", () => {
  const failed = record("failed-start", "codexhub start 'broken' --name 'Broken'", "spawn failed", "completed");
  const failedView = recordsToViews([{ ...failed, payload: { ...(failed.payload as Record<string, unknown>), status: "failed" } }]);
  const state = aggregateCodexhubToolTasks(undefined, "parent", [failedView[0].record]);
  assert.equal(state.tasks.length, 0);
});

test("CodexHub shell boundary maps nonzero exits to failed and -1 to terminated", () => {
  const operations = [
    ["start", start("exit-start", "A", childId)],
    ["send", send("exit-send", childId, "send output")],
    ["stop", stop("exit-stop", childId, "stop output")],
    ["end", end("exit-end", childId, "end output")]
  ] as const;
  for (const [, base] of operations) {
    const failedRecord = {
      ...base,
      payload: { ...(base.payload as Record<string, unknown>), exit_code: 1 }
    };
    const terminatedRecord = {
      ...base,
      payload: { ...(base.payload as Record<string, unknown>), exit_code: -1 }
    };
    assert.equal(codexhubToolCallFromMessage(recordsToViews([failedRecord])[0], "parent")?.status, "failed");
    assert.equal(codexhubToolCallFromMessage(recordsToViews([terminatedRecord])[0], "parent")?.status, "terminated");
  }
});

test("stop receipts require the exact target and accept text or the control JSON shape", () => {
  const stoppedText = "Stopped thread " + childId + "; canonical running=false.";
  const idleText = "Thread " + childId + " was already idle; canonical running=false.";
  const json = JSON.stringify({ operation: "stop", threadId: childId, stopped: false, running: false, idle: true });
  const makeCall = (output: string, status: "pending" | "in_progress" | "completed" | "failed" | "terminated" = "completed") => {
    const base = stop("stop-" + status + "-" + output.length, childId, output);
    const viewRecord = status === "completed" ? base : {
      ...base,
      payload: { ...(base.payload as Record<string, unknown>), status }
    };
    return codexhubToolCallFromMessage(recordsToViews([viewRecord])[0], "parent")!;
  };
  assert.equal(codexhubStopReceipt(makeCall(stoppedText)), "stopped");
  assert.equal(codexhubStopReceipt(makeCall(idleText)), "idle");
  assert.equal(codexhubStopReceipt(makeCall(json)), "idle");
  assert.equal(codexhubStopReceipt(makeCall(stoppedText, "in_progress")), "stopped");
  assert.equal(codexhubStopReceipt(makeCall(stoppedText, "failed")), undefined);
  assert.equal(codexhubStopReceipt(makeCall(stoppedText, "terminated")), undefined);
  assert.equal(codexhubStopReceipt(makeCall(stoppedText.replace(childId, "01a0803a-5615-7d80-98f4-68d74f89186c"))), undefined);
});

test("same shell record updates its current operation from running to completed and failed", () => {
  const initial = start("same-start", "A", childId);
  const pending = { ...initial, payload: { ...(initial.payload as Record<string, unknown>), status: "in_progress" } };
  let state = aggregateCodexhubToolTasks(undefined, "parent", [pending]);
  assert.equal(state.tasks[0]?.status, "in_progress");
  const completed = { ...pending, payload: { ...(pending.payload as Record<string, unknown>), status: "completed", exit_code: 0, aggregated_output: "started" } };
  state = aggregateCodexhubToolTasks(state, "parent", [completed]);
  assert.equal(state.tasks[0]?.status, "completed");
  assert.equal(state.tasks[0]?.output, "started");
  const failed = { ...completed, payload: { ...(completed.payload as Record<string, unknown>), status: "completed", exit_code: 1, aggregated_output: "spawn failed" } };
  state = aggregateCodexhubToolTasks(state, "parent", [failed]);
  assert.equal(state.tasks[0]?.status, "failed");
  assert.equal(state.tasks[0]?.output, "spawn failed");
  assert.equal(state.tasks[0]?.lastOperation, "start");
});

test("same-ID refresh keeps the known position before rejecting an older send", () => {
  const initial = { ...start("same-id-start", "A", childId), order: 1 };
  const pendingBase = send("same-id-send", childId, "running", "latest message");
  const pending = {
    ...pendingBase,
    order: 3,
    payload: { ...(pendingBase.payload as Record<string, unknown>), status: "in_progress" }
  };
  let state = aggregateCodexhubToolTasks(undefined, "parent", [initial, pending]);
  assert.equal(state.tasks[0]?.status, "in_progress");
  assert.equal(state.tasks[0]?.message, "latest message");
  const failed: CodexRecord = {
    id: pending.id,
    type: pending.type,
    payload: { ...(pending.payload as Record<string, unknown>), status: "completed", exit_code: 1, aggregated_output: "failed" }
  };
  const oldSend = { ...send("same-id-old-send", childId, "old output", "old message"), order: 2 };
  state = aggregateCodexhubToolTasks(state, "parent", [initial, failed, oldSend]);
  assert.equal(state.tasks[0]?.status, "failed");
  assert.equal(state.tasks[0]?.output, "failed");
  assert.equal(state.tasks[0]?.message, "latest message");
  assert.equal(state.tasks[0]?.lastOperation, "send");
});

test("terminated start without a child ID is removed, while a child ID keeps the interrupted task", () => {
  const noChildBase = start("terminated-start-empty", "A", childId, "");
  const noChild = { ...noChildBase, payload: { ...(noChildBase.payload as Record<string, unknown>), status: "interrupted" } };
  assert.equal(aggregateCodexhubToolTasks(undefined, "parent", [noChild]).tasks.length, 0);
  const withChildBase = start("terminated-start-child", "B", childId);
  const withChild = { ...withChildBase, payload: { ...(withChildBase.payload as Record<string, unknown>), status: "interrupted" } };
  const state = aggregateCodexhubToolTasks(undefined, "parent", [withChild]);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0]?.status, "terminated");
});

test("canonical operation and message provenance survive a narrowed history page", () => {
  const positioned = (value: CodexRecord, order: number, historyOrder: number, timestamp: string): CodexRecord => ({
    ...value, order, historyOrder, timestamp
  });
  const initial = positioned(start("ordered-start", "A", childId), 10, 10, "2026-09-10T00:00:10.000Z");
  const latest = positioned(send("ordered-latest", childId, "latest output", "latest message"), 30, 30, "2026-09-10T00:00:01.000Z");
  const old = positioned(send("ordered-old", childId, "old output", "old message"), 20, 20, "2026-09-10T00:00:20.000Z");
  let state = aggregateCodexhubToolTasks(undefined, "parent", [initial, latest]);
  assert.equal(state.tasks[0]?.message, "latest message");
  assert.equal(state.tasks[0]?.output, "latest output");
  state = aggregateCodexhubToolTasks(state, "parent", [initial, old]);
  assert.equal(state.tasks[0]?.message, "latest message");
  assert.equal(state.tasks[0]?.output, "latest output");
  assert.equal(state.tasks[0]?.lastOperation, "send");
});

test("a latest failed operation stays visible when start or an old send returns", () => {
  const positioned = (value: CodexRecord, order: number): CodexRecord => ({ ...value, order });
  const initial = positioned(start("failure-start", "A", childId), 10);
  const latestSend = positioned(send("failure-send", childId, "latest output", "latest message"), 20);
  const failedStopBase = stop("failure-stop", childId, "stop failed");
  const failedStop = positioned({ ...failedStopBase, payload: {
    ...(failedStopBase.payload as Record<string, unknown>), exit_code: 1
  } }, 40);
  let state = aggregateCodexhubToolTasks(undefined, "parent", [initial, latestSend, failedStop]);
  assert.equal(state.tasks[0]?.lastOperation, "stop");
  assert.equal(state.tasks[0]?.status, "failed");
  assert.equal(state.tasks[0]?.output, "stop failed");
  state = aggregateCodexhubToolTasks(state, "parent", [initial, latestSend]);
  assert.equal(state.tasks[0]?.lastOperation, "stop");
  assert.equal(state.tasks[0]?.status, "failed");
  assert.equal(state.tasks[0]?.output, "stop failed");
  assert.equal(state.tasks[0]?.message, "latest message");
});

test("an unconfirmed empty end output cannot inherit an older successful receipt", () => {
  const positioned = (value: CodexRecord, order: number): CodexRecord => ({ ...value, order });
  const initial = positioned(start("empty-end-start", "A", childId), 10);
  const sendRecord = positioned(send("empty-end-send", childId, "accepted", "latest message"), 20);
  const emptyEnd = positioned(end("empty-end", childId, ""), 30);
  let state = aggregateCodexhubToolTasks(undefined, "parent", [initial, sendRecord]);
  state = aggregateCodexhubToolTasks(state, "parent", [initial, sendRecord, emptyEnd]);
  assert.equal(state.tasks[0]?.lastOperation, "end");
  assert.equal(state.tasks[0]?.output, "");
  assert.equal(codexhubEndReceiptMatches(state.tasks[0]!), false);
});

test("end preview displays confirmed, unconfirmed, and failed receipts distinctly", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CodexhubToolPreview } = await import("../src/web/CodexhubToolPreview.js");
  const receipt = `Ended delegation for thread ${childId}; cancelled 0 queued message(s), canonical running=false; history retained and the thread remains resumable.`;
  const call = codexhubToolCallFromMessage(recordsToViews([end("end-preview", childId, receipt)])[0], "parent")!;
  const render = (overrides = {}) => renderToStaticMarkup(createElement(CodexhubToolPreview, { call: { ...call, ...overrides } }));
  assert.match(render(), /已结束/);
  assert.doesNotMatch(render(), /结束未确认/);
  assert.match(render({ output: "" }), /结束未确认/);
  assert.match(render({ output: receipt.replace(childId, "01a0803a-5615-7d80-98f4-68d74f89186c") }), /结束未确认/);
  assert.match(render({ status: "failed" }), /结束失败/);
});

test("CLI tool preview retains the original shell inspector affordance", async () => {
  const browserGlobal = globalThis as unknown as { window?: { location: { search: string } } };
  browserGlobal.window ??= { location: { search: "" } };
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MessageCard } = await import("../src/web/helpers/components.js");
  const html = renderToStaticMarkup(createElement(MessageCard, { message: shell(`Thread ID: ${childId}`), threadId: "parent", renderMode: "raw", markdownEnabled: false, onInspect: () => undefined }));
  assert.match(html, /查看原始工具详情/);
  assert.match(html, /codexhubTaskPreview/);
});
