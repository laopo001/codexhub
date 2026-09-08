import { recordsToViews } from "../../core/codexRecordView.js";
import { asRecord, type CodexRecord } from "../../shared/recordTypes.js";
import { parseJsonObject } from "../../shared/toolFormatting.js";
import { parseCodexhubInvocation, codexhubThreadIdFromOutput, type CodexhubInvocation } from "./codexhubInvocation.js";
import type { RuntimeSummary, WebRecordView } from "../types.js";

export type CodexhubToolCall = {
  parentThreadId: string;
  recordId: string;
  invocation: CodexhubInvocation;
  threadId?: string;
  output: string;
  status?: WebRecordView["status"];
};

export const codexhubToolCallFromMessage = (message: WebRecordView, parentThreadId: string): CodexhubToolCall | null => {
  const payload = asRecord(message.record.payload);
  if (!payload || message.role !== "tool") return null;
  const args = typeof payload.arguments === "string" ? parseJsonObject(payload.arguments) : asRecord(payload.arguments);
  const command = payload.type === "local_shell_call" ? asRecord(payload.action)?.command
    : payload.type === "function_call" && /(?:^|\.)exec_command$/.test(String(payload.name)) ? args?.cmd : undefined;
  if (typeof command !== "string" && !(Array.isArray(command) && command.every(item => typeof item === "string"))) return null;
  const invocation = parseCodexhubInvocation(command as string | string[]);
  if (!invocation) return null;
  const output = typeof payload.aggregated_output === "string" ? payload.aggregated_output
    : message.inspectText ?? (typeof asRecord(message.inspectRecord?.payload)?.output === "string" ? String(asRecord(message.inspectRecord?.payload)?.output) : "");
  return { parentThreadId, recordId: message.record.id, invocation,
    threadId: invocation.threadId ?? codexhubThreadIdFromOutput(output), output, status: message.status };
};

export const refreshCodexhubToolCall = (call: CodexhubToolCall, records: readonly CodexRecord[]): CodexhubToolCall => {
  const record = records.find(item => item.id === call.recordId);
  const payload = asRecord(record?.payload);
  if (!record || !payload) return call;
  const result = typeof payload.call_id === "string" ? [...records].reverse().find(item => {
    const p = asRecord(item.payload);
    return p?.call_id === payload.call_id && p?.type === "function_call_output";
  }) : undefined;
  const output = typeof payload.aggregated_output === "string" ? payload.aggregated_output
    : typeof asRecord(result?.payload)?.output === "string" ? String(asRecord(result?.payload)?.output) : call.output;
  return { ...call, output, status: recordsToViews([record])[0]?.status ?? call.status, threadId: call.invocation.threadId ?? codexhubThreadIdFromOutput(output) ?? call.threadId };
};

// Only an attached thread advertised by this backend is eligible. Never resume
// a guessed thread using the parent's cwd or connect to a URL found in shell text.
export const codexhubAttachedThread = (threadId: string | undefined, runtimes: readonly RuntimeSummary[], machineId?: string) => {
  if (!threadId) return undefined;
  const matches = runtimes.flatMap(runtime => runtime.threads.filter(thread => thread.threadId === threadId)
    .map(thread => ({ runtime, thread })));
  const eligible = machineId ? matches.filter(item => item.runtime.machineId === machineId) : matches;
  return eligible.length === 1 ? eligible[0] : undefined;
};

export const codexhubProgressLines = (output: string) => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .split(/\r?\n/).filter(line => line.trim() && !/^(?:Thread ID:|codexhub backend:)/.test(line))
  .slice(-8).map(line => line.length > 200 ? `${line.slice(0, 200)}…` : line).join("\n");
