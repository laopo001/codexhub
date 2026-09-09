import {
  codexhubEndReceiptMatches,
  codexhubStopReceipt,
  type codexhubAttachedThread,
  type CodexhubToolCall
} from "./codexhubToolCall.js";

export type CodexhubToolStatus = { text: string; running: boolean };

/** 历史卡片保留命令结果；浮动任务只在命令成功后使用当前线程状态。 */
export const codexhubToolStatus = (
  call: CodexhubToolCall,
  target: ReturnType<typeof codexhubAttachedThread>,
  mode: "history" | "task" = "history"
): CodexhubToolStatus => {
  const operation = call.lastOperation ?? call.invocation.operation;
  const verb = { start: "启动", send: "发送", stop: "停止", end: "结束" }[operation];
  const label = (text: string, running = false): CodexhubToolStatus => ({ text, running });
  if (call.status === "failed") return label(`${verb}失败`);
  if (call.status === "terminated") {
    return label(operation === "start" && call.threadId ? "监听已中断" : `${verb}已中断`);
  }

  let success: string | undefined;
  if (operation === "end" && codexhubEndReceiptMatches(call)) return label("已结束");
  if (operation === "stop") {
    const receipt = codexhubStopReceipt(call);
    if (receipt) success = receipt === "stopped" ? "已停止" : "原已空闲";
  }
  // start 持续监听，创建成功后 shell 仍可能处于 in_progress。
  if (operation === "start" && call.threadId) success = "已启动";
  if (operation === "send" && call.status === "completed") success = "已发送";

  if (!success) {
    if (call.status === "in_progress") return label(`${verb}中`, true);
    if (call.status === "pending" || call.status === undefined) return label(`等待${verb}`);
    return label(operation === "start" ? "未获取 Thread ID" : `${verb}未确认`);
  }
  if (mode === "history") return label(success);
  if (!target) return label("当前后端未找到线程");
  if (!target.runtime.online) return label("离线");
  if (target.thread.status === "waiting") return label("等待输入");
  return target.thread.running ? label("运行中", true) : label("待续接");
};
