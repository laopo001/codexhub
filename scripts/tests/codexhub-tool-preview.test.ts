import assert from "node:assert/strict";
import test from "node:test";
import { recordsToViews } from "../../src/core/codexRecordView.js";
import { codexhubToolCallFromMessage, refreshCodexhubToolCall, codexhubAttachedThread, codexhubProgressLines } from "../../src/web/helpers/codexhubToolCall.js";
import type { RuntimeSummary, WebRecordView } from "../../src/web/types.js";

const childId = "01a0803a-5615-7d80-98f4-68d74f89185b";
const command = "codexhub start '检查登录问题' --name '登录检查' --model gpt-5.6-luna --effort xhigh --cwd /workspace --stream";
const shell = (output: string): WebRecordView => recordsToViews([{ id: "shell", type: "response_item", payload: {
  type: "local_shell_call", call_id: "shell-call", status: "in_progress", action: { command: ["/usr/bin/zsh", "-lc", command] }, aggregated_output: output
} }])[0];

test("CLI shell preview learns start ID only from output and refreshes detached progress", () => {
  const initial = codexhubToolCallFromMessage(shell(""), "parent")!;
  assert.equal(initial.invocation.name, "登录检查");
  assert.equal(initial.threadId, undefined);
  const updated = shell(`Thread ID: ${childId}\n[commentary]\n正在检查调用路径`);
  const call = refreshCodexhubToolCall(initial, [updated.record]);
  assert.equal(call.threadId, childId);
  assert.match(call.output, /正在检查调用路径/);
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

test("mini preview retains only a bounded recent output window", () => {
  const lines = codexhubProgressLines(`Thread ID: ${childId}\n` + Array.from({ length: 30 }, (_, i) => `${i}:${"x".repeat(400)}`).join("\n"));
  assert.equal(lines.split("\n").length, 8);
  assert.ok(lines.length < 1700);
  assert.match(lines, /^22:/);
  assert.doesNotMatch(lines, /Thread ID:/);
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
