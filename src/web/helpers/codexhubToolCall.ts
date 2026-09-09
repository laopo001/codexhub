import { recordsToViews } from "../../core/codexRecordView.js";
import { compareCodexRecords, orderCodexRecords } from "../../shared/recordIdentity.js";
import { asRecord, type CodexRecord } from "../../shared/recordTypes.js";
import { parseJsonObject } from "../../shared/toolFormatting.js";
import { parseCodexhubInvocation, codexhubThreadIdFromOutput, type CodexhubInvocation } from "./codexhubInvocation.js";
import type { RuntimeSummary, WebRecordView } from "../types.js";

type CodexhubRecordSource = Pick<CodexRecord, "id" | "order" | "historyOrder" | "timestamp">;

export type CodexhubToolCall = {
  parentThreadId: string;
  recordId: string;
  invocation: CodexhubInvocation;
  threadId?: string;
  message?: string;
  messageRecordId?: string;
  output: string;
  status?: WebRecordView["status"];
  lastOperation?: CodexhubInvocation["operation"];
  lastOperationSource?: CodexhubRecordSource;
  messageSource?: CodexhubRecordSource;
};

export type CodexhubToolTaskState = {
  parentThreadId: string;
  tasks: CodexhubToolCall[];
  endedThreadIds: ReadonlySet<string>;
};

const codexhubShellStatus = (message: WebRecordView, payload: Record<string, unknown>): WebRecordView["status"] => {
  const exitCode = payload.exit_code;
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
    if (exitCode === -1) return "terminated";
    if (exitCode !== 0) return "failed";
    return "completed";
  }

  const rawStatus = typeof payload.status === "string"
    ? payload.status.trim().replace(/[-\s]+/g, "_").toLowerCase()
    : "";
  if (rawStatus === "terminated" || rawStatus === "cancelled" || rawStatus === "canceled"
    || rawStatus === "interrupted" || rawStatus === "aborted") return "terminated";
  return message.status;
};

const recordSource = (record: CodexRecord): CodexhubRecordSource => {
  const source: CodexhubRecordSource = { id: record.id };
  if (typeof record.order === "number" && Number.isFinite(record.order)) source.order = record.order;
  if (typeof record.historyOrder === "number" && Number.isFinite(record.historyOrder)) source.historyOrder = record.historyOrder;
  if (typeof record.timestamp === "string") source.timestamp = record.timestamp;
  return source;
};

const refreshSource = (previous: CodexhubRecordSource | undefined, record: CodexRecord) => {
  const source = recordSource(record);
  if (previous?.id !== source.id) return source;
  return {
    ...previous,
    ...source
  };
};

const mergeSources = (previous: CodexhubRecordSource | undefined, incoming: CodexhubRecordSource): CodexhubRecordSource =>
  previous?.id === incoming.id ? { ...previous, ...incoming } : incoming;

const withOperationSource = (call: CodexhubToolCall, record: CodexRecord): CodexhubToolCall => ({
  ...call,
  lastOperationSource: refreshSource(call.lastOperationSource, record)
});

const withMessageSource = (call: CodexhubToolCall, record: CodexRecord): CodexhubToolCall => call.invocation.operation === "send"
  ? {
      ...call,
      messageRecordId: record.id,
      messageSource: refreshSource(call.messageSource, record)
    }
  : call;

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
  const call = { parentThreadId, recordId: message.record.id, invocation,
    threadId: invocation.threadId ?? codexhubThreadIdFromOutput(output), message: invocation.input,
    messageRecordId: invocation.operation === "send" ? message.record.id : undefined,
    output, status: codexhubShellStatus(message, payload),
    lastOperation: invocation.operation } satisfies CodexhubToolCall;
  return withOperationSource(withMessageSource(call, message.record), message.record);
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
  const view = recordsToViews([record])[0];
  const refreshed = { ...call, output, status: view ? codexhubShellStatus(view, payload) : call.status,
    threadId: call.invocation.threadId ?? codexhubThreadIdFromOutput(output) ?? call.threadId,
    lastOperation: call.invocation.operation };
  return withOperationSource(withMessageSource(refreshed, record), record);
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

type SourceKind = "operation" | "message";

const sourceRecordId = (call: CodexhubToolCall, kind: SourceKind) => kind === "operation"
  ? call.lastOperationSource?.id ?? call.recordId
  : call.messageSource?.id ?? call.messageRecordId;

const sourceHasCanonicalPosition = (call: CodexhubToolCall, kind: SourceKind) => kind === "operation"
  ? call.lastOperationSource?.order !== undefined
    || call.lastOperationSource?.historyOrder !== undefined
    || call.lastOperationSource?.timestamp !== undefined
  : call.messageSource?.order !== undefined
    || call.messageSource?.historyOrder !== undefined
    || call.messageSource?.timestamp !== undefined;

const sourceRecord = (call: CodexhubToolCall, kind: SourceKind): CodexRecord => {
  const source = kind === "operation" ? call.lastOperationSource : call.messageSource;
  return {
    ...(source ?? { id: sourceRecordId(call, kind) ?? call.recordId }),
    type: "response_item",
    payload: null
  };
};

const compareSources = (
  incoming: CodexhubToolCall,
  current: CodexhubToolCall,
  kind: SourceKind,
  currentIndexes: ReadonlyMap<string, number>
): number | undefined => {
  const incomingId = sourceRecordId(incoming, kind);
  const currentId = sourceRecordId(current, kind);
  if (!incomingId || !currentId) return undefined;
  if (incomingId === currentId) return 0;

  if (sourceHasCanonicalPosition(incoming, kind) && sourceHasCanonicalPosition(current, kind)) {
    const comparison = compareCodexRecords(sourceRecord(incoming, kind), sourceRecord(current, kind));
    if (comparison !== 0) return comparison;
  }

  const incomingIndex = currentIndexes.get(incomingId);
  const currentIndex = currentIndexes.get(currentId);
  if (incomingIndex !== undefined && currentIndex !== undefined && incomingIndex !== currentIndex) {
    return incomingIndex - currentIndex;
  }
  return undefined;
};

const applyOperation = (task: CodexhubToolCall, incoming: CodexhubToolCall): CodexhubToolCall => ({
  ...task,
  ...(incoming.threadId && !task.threadId ? { threadId: incoming.threadId } : {}),
  output: incoming.output,
  status: incoming.status,
  lastOperation: incoming.invocation.operation,
  lastOperationSource: mergeSources(task.lastOperationSource, incoming.lastOperationSource ?? { id: incoming.recordId })
});

const mergeLatestOperation = (
  task: CodexhubToolCall,
  incoming: CodexhubToolCall,
  currentIndexes: ReadonlyMap<string, number>
) => {
  const incomingId = sourceRecordId(incoming, "operation");
  const currentId = sourceRecordId(task, "operation");
  if (incomingId && incomingId === currentId) return applyOperation(task, incoming);
  const comparison = compareSources(incoming, task, "operation", currentIndexes);
  return comparison !== undefined && comparison > 0 ? applyOperation(task, incoming) : task;
};

const applyMessage = (task: CodexhubToolCall, incoming: CodexhubToolCall): CodexhubToolCall => ({
  ...task,
  message: incoming.invocation.input,
  messageRecordId: incoming.messageRecordId ?? incoming.recordId,
  messageSource: mergeSources(task.messageSource, incoming.messageSource ?? { id: incoming.recordId })
});

const mergeLatestMessage = (
  task: CodexhubToolCall,
  incoming: CodexhubToolCall,
  currentIndexes: ReadonlyMap<string, number>
) => {
  if (incoming.invocation.operation !== "send" || typeof incoming.invocation.input !== "string") return task;
  if (!task.messageRecordId) return applyMessage(task, incoming);
  const comparison = compareSources(incoming, task, "message", currentIndexes);
  return comparison !== undefined && comparison >= 0 ? applyMessage(task, incoming) : task;
};

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const receiptOperation = (call: CodexhubToolCall) => call.lastOperation ?? call.invocation.operation;
const receiptThreadId = (call: CodexhubToolCall) => call.threadId ?? call.invocation.threadId;
const receiptCandidates = (output: string) => [output.trim(), ...output.split(/\r?\n/).map(line => line.trim())].filter(Boolean);

const jsonReceiptCandidates = (output: string) => receiptCandidates(output)
  .map(candidate => parseJsonObject(candidate))
  .filter((candidate): candidate is Record<string, unknown> => candidate !== null);

const receiptIsEligible = (call: CodexhubToolCall) => call.status !== "failed" && call.status !== "terminated";

export const codexhubStopReceipt = (call: CodexhubToolCall): "stopped" | "idle" | undefined => {
  if (receiptOperation(call) !== "stop" || !receiptIsEligible(call)) return undefined;
  const threadId = receiptThreadId(call);
  if (!threadId || !isUuid(threadId)) return undefined;

  const text = `Stopped thread ${threadId}; canonical running=false.`;
  const idleText = `Thread ${threadId} was already idle; canonical running=false.`;
  if (receiptCandidates(call.output).some(candidate => candidate === text)) return "stopped";
  if (receiptCandidates(call.output).some(candidate => candidate === idleText)) return "idle";

  for (const result of jsonReceiptCandidates(call.output)) {
    if (result.operation !== "stop" || result.threadId !== threadId
      || result.running !== false || result.idle !== true || typeof result.stopped !== "boolean") continue;
    return result.stopped ? "stopped" : "idle";
  }
  return undefined;
};

/**
 * End is a lifecycle command, so a completed shell record is not enough to
 * remove a task. The CLI receipt must explicitly confirm end and repeat the
 * exact child thread ID.
 */
export const codexhubEndReceiptMatches = (call: CodexhubToolCall): boolean => {
  if (receiptOperation(call) !== "end" || !receiptIsEligible(call)) return false;
  const threadId = receiptThreadId(call);
  if (!threadId || !isUuid(threadId)) return false;

  const escapedThreadId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const textReceipt = new RegExp(
    `^Ended delegation for thread ${escapedThreadId}; cancelled \\d+ queued message\\(s\\), `
      + "canonical running=false; history retained and the thread remains resumable\\.$"
  );
  if (receiptCandidates(call.output).some(line => textReceipt.test(line))) return true;

  for (const result of jsonReceiptCandidates(call.output)) {
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
  const orderedRecords = orderCodexRecords([...records]);
  const views = recordsToViews(orderedRecords);
  const currentCalls = views.map(view => codexhubToolCallFromMessage(view, parentThreadId))
    .filter((call): call is CodexhubToolCall => call !== null)
    .map(call => refreshCodexhubToolCall(call, orderedRecords));
  const currentOperationIndexes = new Map<string, number>();
  for (const [index, call] of currentCalls.entries()) {
    const sourceId = sourceRecordId(call, "operation");
    if (sourceId) currentOperationIndexes.set(sourceId, index);
  }

  for (const call of currentCalls) {
    const threadId = receiptThreadId(call);
    if (call.invocation.operation === "end" && codexhubEndReceiptMatches(call) && threadId) {
      endedThreadIds.add(threadId);
    }
  }

  for (const [key, task] of nextTasks) {
    if (task.threadId && endedThreadIds.has(task.threadId)) nextTasks.delete(key);
  }

  for (const call of currentCalls) {
    if (call.invocation.operation !== "start") continue;
    const existingKey = findTaskKey(nextTasks, call);
    const existing = existingKey ? nextTasks.get(existingKey) : undefined;
    if (!call.threadId && !existing?.threadId && (call.status === "failed" || call.status === "terminated")) {
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
        let updated: CodexhubToolCall = { ...existing, threadId: call.threadId ?? existing.threadId };
        updated = mergeLatestOperation(updated, call, currentOperationIndexes);
        if (updated.message === undefined && call.message !== undefined) updated = { ...updated, message: call.message };
        nextTasks.set(taskKey(updated), updated);
      }
      continue;
    }
    nextTasks.set(taskKey(call), call);
  }

  for (const [key, task] of nextTasks) {
    if (!task.threadId || endedThreadIds.has(task.threadId)) continue;
    let updated = task;
    for (const call of currentCalls) {
      if (call.invocation.operation === "start") continue;
      if (call.threadId === task.threadId) updated = mergeLatestOperation(updated, call, currentOperationIndexes);
    }
    for (const call of currentCalls) {
      if (call.threadId === task.threadId) updated = mergeLatestMessage(updated, call, currentOperationIndexes);
    }
    nextTasks.set(key, updated);
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
