import { asRecord } from "../core/codexRecord.js";
import type { CodexRecord } from "../core/codexRecord.js";
import type { CodexRecordView } from "../core/codexRecordView.js";
import { formatUpdatePlanCompact, parseUpdatePlanArguments } from "./updatePlanView.js";

export type CompactRecordView = CodexRecordView & {
  inspectRecord?: CodexRecord;
  inspectCallText?: string;
  inspectText?: string;
};

export type CompactRecordViewState = {
  views: CompactRecordView[];
  toolIndexes: Map<string, number>;
  turnIndexes: Map<string, number>;
  runtimeMessageIndexes: Map<string, number>;
  runtimeMessageCounts: Map<string, number>;
  runtimeMessageRoles: Map<string, Set<string>>;
  eventRun?: {
    key: string;
    index: number;
    count: number;
  };
};

export type CompactRecordViewChange = {
  view: CompactRecordView;
  appended: boolean;
  previousId?: string;
};

export const createCompactRecordViewState = (): CompactRecordViewState => ({
  views: [],
  toolIndexes: new Map(),
  turnIndexes: new Map(),
  runtimeMessageIndexes: new Map(),
  runtimeMessageCounts: new Map(),
  runtimeMessageRoles: new Map()
});

export const compactToolViews = (views: CodexRecordView[]): CompactRecordView[] => {
  const state = createCompactRecordViewState();
  for (const view of views) compactRecordView(state, view);
  return state.views;
};

export const compactRecordView = (
  state: CompactRecordViewState,
  view: CodexRecordView
): CompactRecordViewChange => {
  const eventChange = compactEventView(state, view);
  if (eventChange) return eventChange;

  if (view.role !== "tool") {
    state.eventRun = undefined;
    const compactView = view;
    state.views.push(compactView);
    return { view: compactView, appended: true };
  }

  state.eventRun = undefined;
  const payload = asRecord(view.record.payload);
  if (view.status === "pending") {
    const callId = compactToolCallId(view);
    state.toolIndexes.set(callId, state.views.length);
    const compactView: CompactRecordView = {
      ...view,
      id: `compact-tool:${callId}`,
      label: formatCompactToolLabel(view),
      text: formatCompactToolCall(view),
      inspectCallText: view.text
    };
    state.views.push(compactView);
    return { view: compactView, appended: true };
  }

  const callId = compactToolCallId(view);
  const callIndex = state.toolIndexes.get(callId);
  if (callIndex == null || payload?.type !== "function_call_output") {
    const compactView = view;
    state.views.push(compactView);
    return { view: compactView, appended: true };
  }

  const callView = state.views[callIndex];
  const compactView: CompactRecordView = {
    ...callView,
    text: view.status === "failed" && view.text ? [callView.text, `Output:\n${view.text.trimEnd()}`].join("\n\n") : callView.text,
    at: view.at ?? callView.at,
    status: view.status,
    record: callView.record,
    inspectRecord: view.record,
    inspectText: view.text
  };
  state.views[callIndex] = compactView;
  return { view: compactView, appended: false, previousId: callView.id };
};

const compactEventView = (
  state: CompactRecordViewState,
  view: CodexRecordView
): CompactRecordViewChange | null => {
  const payload = asRecord(view.record.payload);
  if (!payload) return null;

  if (view.record.type === "response_item" && payload.type === "message") {
    return compactRuntimeMessage(state, view, payload);
  }

  if (view.record.type !== "event_msg") return null;
  const eventType = typeof payload.type === "string" ? payload.type : "";
  if (eventType === "task_started") return compactTurnStarted(state, view, payload);
  if (eventType === "task_complete" || eventType === "turn_aborted") return compactTurnFinished(state, view, payload, eventType);
  if (eventType === "thread_goal_updated" || eventType === "thread_goal_cleared") return compactRepeatedEvent(state, view, "goal");
  if (eventType === "context_compaction" || eventType === "compacted") return compactRepeatedEvent(state, view, "context");
  return null;
};

const compactTurnStarted = (
  state: CompactRecordViewState,
  view: CodexRecordView,
  payload: Record<string, unknown>
): CompactRecordViewChange => {
  state.eventRun = undefined;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : view.id;
  state.turnIndexes.set(turnId, state.views.length);
  const compactView: CompactRecordView = {
    ...view,
    id: `compact-turn:${turnId}`,
    label: "turn",
    text: formatTurnStarted(payload),
    status: "pending"
  };
  state.views.push(compactView);
  return { view: compactView, appended: true };
};

const compactTurnFinished = (
  state: CompactRecordViewState,
  view: CodexRecordView,
  payload: Record<string, unknown>,
  eventType: string
): CompactRecordViewChange | null => {
  state.eventRun = undefined;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
  const index = turnId ? state.turnIndexes.get(turnId) : undefined;
  if (index == null) return null;

  const started = state.views[index];
  const compactView: CompactRecordView = {
    ...started,
    text: eventType === "turn_aborted" ? formatTurnAborted(payload) : formatTurnCompleted(payload),
    at: view.at ?? started.at,
    status: eventType === "turn_aborted" ? "failed" : "completed",
    inspectRecord: view.record,
    inspectText: view.text
  };
  state.views[index] = compactView;
  return { view: compactView, appended: false, previousId: started.id };
};

const compactRepeatedEvent = (
  state: CompactRecordViewState,
  view: CodexRecordView,
  key: string
): CompactRecordViewChange => {
  const currentRun = state.eventRun?.key === key ? state.eventRun : undefined;
  if (!currentRun) {
    const compactView = view;
    state.views.push(compactView);
    state.eventRun = { key, index: state.views.length - 1, count: 1 };
    return { view: compactView, appended: true };
  }

  const previous = state.views[currentRun.index];
  const count = currentRun.count + 1;
  const compactView: CompactRecordView = {
    ...view,
    id: previous.id,
    label: previous.label,
    text: `${view.text}\n${count} ${key === "goal" ? "goal updates" : "context events"}`,
    inspectRecord: view.record,
    inspectText: view.text
  };
  state.views[currentRun.index] = compactView;
  state.eventRun = { ...currentRun, count };
  return { view: compactView, appended: false, previousId: previous.id };
};

const compactRuntimeMessage = (
  state: CompactRecordViewState,
  view: CodexRecordView,
  payload: Record<string, unknown>
): CompactRecordViewChange => {
  state.eventRun = undefined;
  const turnId = compactTurnId(view) ?? "unscoped";
  const index = state.runtimeMessageIndexes.get(turnId);
  const role = typeof payload.role === "string" ? payload.role : "unknown";
  const roles = state.runtimeMessageRoles.get(turnId) ?? new Set<string>();
  roles.add(role);
  state.runtimeMessageRoles.set(turnId, roles);

  if (index == null) {
    state.runtimeMessageIndexes.set(turnId, state.views.length);
    state.runtimeMessageCounts.set(turnId, 1);
    const compactView: CompactRecordView = {
      ...view,
      id: `compact-runtime-message:${turnId}`,
      label: "runtime messages"
    };
    state.views.push(compactView);
    return { view: compactView, appended: true };
  }

  const previous = state.views[index];
  const count = (state.runtimeMessageCounts.get(turnId) ?? 1) + 1;
  state.runtimeMessageCounts.set(turnId, count);
  const compactView: CompactRecordView = {
    ...previous,
    text: `${count} runtime messages\nroles: ${[...roles].join(", ")}`,
    at: view.at ?? previous.at,
    inspectRecord: view.record,
    inspectText: view.text
  };
  state.views[index] = compactView;
  return { view: compactView, appended: false, previousId: previous.id };
};

const compactToolCallId = (view: CodexRecordView) => {
  const payload = asRecord(view.record.payload);
  return typeof payload?.call_id === "string" ? payload.call_id : view.id;
};

const compactTurnId = (view: CodexRecordView) => {
  const parts = view.record.id.split(":");
  return parts[0] === "app" && parts.length >= 3 ? parts[2] : undefined;
};

const formatCompactToolCall = (view: CodexRecordView) => {
  const payload = asRecord(view.record.payload);
  if (payload?.type !== "function_call") return view.text;
  const name = typeof payload.name === "string" ? payload.name : "tool";
  const args = parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "");
  if (name === "update_plan" && args) {
    const plan = parseUpdatePlanArguments(args);
    if (plan) return formatUpdatePlanCompact(plan);
  }
  if (name === "write_stdin" && args) return formatWriteStdinSummary(args);
  if (name === "exec_command" && typeof args?.cmd === "string") return `$ ${args.cmd}`;
  if (args) return `${name} ${JSON.stringify(args)}`;
  return view.text;
};

const formatCompactToolLabel = (view: CodexRecordView) => {
  const payload = asRecord(view.record.payload);
  return payload?.type === "function_call" && payload.name === "update_plan"
    ? "Updated Plan"
    : view.label.replace(/^tool call:\s*/i, "tool: ");
};

const formatTurnStarted = (payload: Record<string, unknown>) => [
  "Turn started",
  typeof payload.collaboration_mode_kind === "string" ? `mode: ${payload.collaboration_mode_kind}` : null,
  typeof payload.model_context_window === "number" ? `context: ${formatCompactNumber(payload.model_context_window)}` : null
].filter(Boolean).join("\n");

const formatTurnCompleted = (payload: Record<string, unknown>) => [
  "Turn completed",
  typeof payload.duration_ms === "number" ? `duration: ${formatMilliseconds(payload.duration_ms)}` : null,
  typeof payload.time_to_first_token_ms === "number" ? `first token: ${formatMilliseconds(payload.time_to_first_token_ms)}` : null
].filter(Boolean).join("\n");

const formatTurnAborted = (payload: Record<string, unknown>) => [
  "Turn aborted",
  typeof payload.reason === "string" ? `reason: ${payload.reason}` : null,
  typeof payload.duration_ms === "number" ? `duration: ${formatMilliseconds(payload.duration_ms)}` : null
].filter(Boolean).join("\n");

const formatMilliseconds = (value: number) => {
  if (value >= 60_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
};

const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

const formatWriteStdinSummary = (args: Record<string, unknown>) => {
  const session = typeof args.session_id === "number" || typeof args.session_id === "string" ? `session ${args.session_id}` : "session";
  return `stdin: ${formatWriteStdinChars(args)} -> ${session}`;
};

const formatWriteStdinChars = (args: Record<string, unknown>) => {
  if (typeof args.chars !== "string") return "<missing>";
  if (!args.chars) return "<empty> (poll only; no stdin was written)";
  if (args.chars === "\u0003") return "Ctrl-C (\\u0003)";
  if (args.chars === "\n") return "Enter (\\n)";
  return JSON.stringify(args.chars);
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};
