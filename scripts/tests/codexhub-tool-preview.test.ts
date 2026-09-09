import assert from "node:assert/strict";
import test from "node:test";
import { recordsToViews } from "../../src/core/codexRecordView.js";
import { aggregateCodexhubToolTasks, codexhubToolCallFromMessage, refreshCodexhubToolCall, codexhubAttachedThread } from "../../src/web/helpers/codexhubToolCall.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { RuntimeSummary, WebRecordView } from "../../src/web/types.js";

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
const send = (id: string, threadId: string, output: string) =>
  record(id, `codexhub send ${threadId} 'follow up'`, output);
const end = (id: string, threadId: string, output: string, status: "in_progress" | "completed" = "completed") =>
  record(id, `codexhub end ${threadId}`, output, status);

test("task aggregation deduplicates starts, updates from send, retains idle rows, and ignores unrelated sends", () => {
  const first = "01a0803a-5615-7d80-98f4-68d74f89185b";
  const second = "01a0803a-5615-7d80-98f4-68d74f89186c";
  const unrelated = "01a0803a-5615-7d80-98f4-68d74f89186d";
  const initialRecords = [start("start-a", "A", first), start("start-a-duplicate", "A duplicate", first), start("start-b", "B", second), send("send-unrelated", unrelated, "ignored")];
  let state = aggregateCodexhubToolTasks(undefined, "parent", initialRecords);
  assert.deepEqual(state.tasks.map(task => task.invocation.name), ["A", "B"]);

  state = aggregateCodexhubToolTasks(state, "parent", [...initialRecords, send("send-a", first, "updated by send")]);
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks.find(task => task.threadId === first)?.output, "updated by send");

  state = aggregateCodexhubToolTasks(state, "parent", []);
  assert.equal(state.tasks.length, 2, "a narrower history window must not remove an idle task");
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

test("CLI tool preview retains the original shell inspector affordance", async () => {
  const browserGlobal = globalThis as unknown as { window?: { location: { search: string } } };
  browserGlobal.window ??= { location: { search: "" } };
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MessageCard } = await import("../../src/web/helpers/components.js");
  const html = renderToStaticMarkup(createElement(MessageCard, { message: shell(`Thread ID: ${childId}`), threadId: "parent", renderMode: "raw", markdownEnabled: false, onInspect: () => undefined }));
  assert.match(html, /查看原始工具详情/);
  assert.match(html, /codexhubTaskPreview/);
});
