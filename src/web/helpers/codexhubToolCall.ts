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
  lastOperation?: CodexhubInvocation["operation"];
};

export type CodexhubToolTaskState = {
  parentThreadId: string;
  tasks: CodexhubToolCall[];
  endedThreadIds: ReadonlySet<string>;
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
    threadId: invocation.threadId ?? codexhubThreadIdFromOutput(output), output, status: message.status,
    lastOperation: invocation.operation };
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
  return { ...call, output, status: recordsToViews([record])[0]?.status ?? call.status,
    threadId: call.invocation.threadId ?? codexhubThreadIdFromOutput(output) ?? call.threadId,
    lastOperation: call.invocation.operation };
};

const taskKey = (call: Pick<CodexhubToolCall, "recordId" | "threadId">) =>
  call.threadId ? `thread:${call.threadId}` : `record:${call.recordId}`;

const findTaskKey = (tasks: Map<string, CodexhubToolCall>, call: CodexhubToolCall) => {
  if (tasks.has(taskKey(call))) return taskKey(call);
  for (const [key, task] of tasks) {
    if (task.recordId === call.recordId) return key;
    if (call.threadId && task.threadId === call.threadId) return key;
  }
  return undefined;
};

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * End is a lifecycle command, so a completed shell record is not enough to
 * remove a task. The CLI receipt must explicitly confirm end and repeat the
 * exact child thread ID.
 */
export const codexhubEndReceiptMatches = (call: CodexhubToolCall): boolean => {
  const threadId = call.invocation.operation === "end" ? call.invocation.threadId : undefined;
  if (!threadId || !isUuid(threadId) || call.status === "failed") return false;

  const escapedThreadId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const textReceipt = new RegExp(
    `^Ended delegation for thread ${escapedThreadId}; cancelled \\d+ queued message\\(s\\), `
      + "canonical running=false; history retained and the thread remains resumable\\.$"
  );
  if (call.output.split(/\r?\n/).some(line => textReceipt.test(line.trim()))) return true;

  for (const candidate of [call.output.trim(), ...call.output.split(/\r?\n/).map(line => line.trim())]) {
    const result = parseJsonObject(candidate);
    if (result?.operation === "end"
      && result.threadId === threadId
      && result.running === false
      && result.idle === true
      && result.historyRetained === true
      && result.resumable === true) return true;
  }
  return false;
};

const emptyTaskState = (parentThreadId: string): CodexhubToolTaskState => ({
  parentThreadId,
  tasks: [],
  endedThreadIds: new Set<string>()
});

/**
 * Aggregate only the current parent's captured records. The previous state is
 * an in-memory Web projection: it keeps rows stable while a history page is
 * temporarily narrower, and its tombstones prevent an old start record from
 * reviving a successfully ended child.
 */
export const aggregateCodexhubToolTasks = (
  previous: CodexhubToolTaskState | undefined,
  parentThreadId: string,
  records: readonly CodexRecord[]
): CodexhubToolTaskState => {
  const prior = previous?.parentThreadId === parentThreadId ? previous : emptyTaskState(parentThreadId);
  const nextTasks = new Map(prior.tasks.map(task => [taskKey(task), task]));
  const endedThreadIds = new Set(prior.endedThreadIds);
  const views = recordsToViews([...records]);
  const currentCalls = views.map(view => codexhubToolCallFromMessage(view, parentThreadId))
    .filter((call): call is CodexhubToolCall => call !== null)
    .map(call => refreshCodexhubToolCall(call, records));

  for (const call of currentCalls) {
    if (call.invocation.operation === "end" && codexhubEndReceiptMatches(call) && call.invocation.threadId) {
      endedThreadIds.add(call.invocation.threadId);
    }
  }

  for (const [key, task] of nextTasks) {
    if (task.threadId && endedThreadIds.has(task.threadId)) nextTasks.delete(key);
  }

  for (const call of currentCalls) {
    if (call.invocation.operation !== "start") continue;
    const existingKey = findTaskKey(nextTasks, call);
    if (!call.threadId && call.status === "failed") {
      if (existingKey) nextTasks.delete(existingKey);
      continue;
    }
    if (call.threadId && endedThreadIds.has(call.threadId)) {
      // A start may have been captured before its output exposed the child ID.
      // Once the same record resolves to a tombstoned ID, remove that pending
      // record as well so an old start cannot remain visible.
      if (existingKey) nextTasks.delete(existingKey);
      continue;
    }

    if (existingKey) {
      const existing = nextTasks.get(existingKey)!;
      if (existing.recordId === call.recordId) {
        nextTasks.delete(existingKey);
        nextTasks.set(taskKey(call), { ...existing, ...call, threadId: call.threadId ?? existing.threadId });
      }
      continue;
    }
    nextTasks.set(taskKey(call), call);
  }

  for (const [key, task] of nextTasks) {
    if (!task.threadId || endedThreadIds.has(task.threadId)) continue;
    const related = currentCalls.filter(call => call.invocation.operation !== "start" && call.threadId === task.threadId).at(-1);
    if (!related) continue;
    nextTasks.set(key, {
      ...task,
      output: related.output || task.output,
      status: related.status ?? task.status,
      lastOperation: related.invocation.operation
    });
  }

  return { parentThreadId, tasks: [...nextTasks.values()], endedThreadIds };
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
