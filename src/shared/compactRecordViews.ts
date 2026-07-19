import { asRecord, type CodexRecord, type CodexRecordView } from "./recordTypes.js";
import { formatCompactNumber, formatWriteStdinSummary, parseJsonObject } from "./toolFormatting.js";
import { formatUpdatePlanCompact, parseUpdatePlanArguments } from "./updatePlanView.js";

/** compact/simple 消息模式使用的 record view，保留 inspect 所需的原始信息。 */
export type CompactRecordView = CodexRecordView & {
  inspectRecord?: CodexRecord;
  inspectCallText?: string;
  inspectText?: string;
  toolBatch?: {
    key: string;
    count: number;
    labels: string[];
    expanded?: boolean;
  };
};

/** compact record view 转换过程中的聚合状态。 */
export type CompactRecordViewState = {
  views: CompactRecordView[];
  toolIndexes: Map<string, number>;
  turnIndexes: Map<string, number>;
  internalMessageIndexes: Map<string, number>;
  internalMessageCounts: Map<string, number>;
  internalMessageRoles: Map<string, Set<string>>;
  eventRun?: {
    key: string;
    index: number;
    count: number;
  };
};

/** 单条 record view compact 后的增量结果。 */
export type CompactRecordViewChange = {
  view: CompactRecordView;
  appended: boolean;
  previousId?: string;
};

export const createCompactRecordViewState = (): CompactRecordViewState => ({
  views: [],
  toolIndexes: new Map(),
  turnIndexes: new Map(),
  internalMessageIndexes: new Map(),
  internalMessageCounts: new Map(),
  internalMessageRoles: new Map()
});

export const compactToolViews = (views: CodexRecordView[]): CompactRecordView[] => {
  const state = createCompactRecordViewState();
  for (const view of views) compactRecordView(state, view);
  return state.views;
};

export const collapseHistoricalToolBatches = (
  views: CompactRecordView[],
  expandedBatchKeys: Set<string> = new Set()
): CompactRecordView[] => {
  const segments: Array<{ kind: "view"; view: CompactRecordView } | { kind: "toolBatch"; key: string; views: CompactRecordView[] }> = [];
  let currentBatch: CompactRecordView[] = [];

  const flushBatch = () => {
    if (!currentBatch.length) return;
    segments.push({ kind: "toolBatch", key: compactToolBatchKey(currentBatch), views: currentBatch });
    currentBatch = [];
  };

  for (const view of views) {
    if (isBatchableToolView(view)) {
      currentBatch.push(view);
      continue;
    }
    flushBatch();
    segments.push({ kind: "view", view });
  }
  flushBatch();

  const latestBatchKey = [...segments].reverse().find((segment) => segment.kind === "toolBatch")?.key;
  const collapsedViews: CompactRecordView[] = [];
  for (const segment of segments) {
    if (segment.kind === "view") {
      collapsedViews.push(segment.view);
      continue;
    }
    const isLatestBatch = segment.key === latestBatchKey;
    if (isLatestBatch) {
      collapsedViews.push(...segment.views);
      continue;
    }
    const isExpanded = expandedBatchKeys.has(segment.key);
    collapsedViews.push(compactToolBatchSummary(segment.key, segment.views, isExpanded));
    if (isExpanded) collapsedViews.push(...segment.views);
  }
  return collapsedViews;
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
  if (view.status === "pending" || view.status === "in_progress") {
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
    statusText: view.statusText,
    statusDurationMs: view.statusDurationMs ?? callView.statusDurationMs,
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

  if (view.record.type === "response_item" && payload.type === "message" && isInternalMessage(payload)) {
    return compactInternalMessage(state, view, payload);
  }

  if (view.record.type !== "event_msg") return null;
  const eventType = typeof payload.type === "string" ? payload.type : "";
  if (eventType === "task_started") return compactTurnStarted(state, view, payload);
  if (eventType === "task_complete" || eventType === "turn_aborted") return compactTurnFinished(state, view, payload, eventType);
  if (eventType === "thread_goal_updated" || eventType === "thread_goal_cleared") return compactRepeatedEvent(state, view, "goal");
  if (eventType === "context_compaction") return compactRepeatedEvent(state, view, "context");
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
    status: "in_progress"
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
    statusDurationMs: view.statusDurationMs,
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

const compactInternalMessage = (
  state: CompactRecordViewState,
  view: CodexRecordView,
  payload: Record<string, unknown>
): CompactRecordViewChange => {
  state.eventRun = undefined;
  const turnId = compactTurnId(view) ?? "unscoped";
  const index = state.internalMessageIndexes.get(turnId);
  const role = typeof payload.role === "string" ? payload.role : "unknown";
  const roles = state.internalMessageRoles.get(turnId) ?? new Set<string>();
  roles.add(role);
  state.internalMessageRoles.set(turnId, roles);

  if (index == null) {
    state.internalMessageIndexes.set(turnId, state.views.length);
    state.internalMessageCounts.set(turnId, 1);
    const compactView: CompactRecordView = {
      ...view,
      id: `compact-internal-message:${turnId}`,
      label: "internal messages"
    };
    state.views.push(compactView);
    return { view: compactView, appended: true };
  }

  const previous = state.views[index];
  const count = (state.internalMessageCounts.get(turnId) ?? 1) + 1;
  state.internalMessageCounts.set(turnId, count);
  const compactView: CompactRecordView = {
    ...previous,
    text: `${count} internal messages\nroles: ${[...roles].join(", ")}`,
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

const compactToolBatchKey = (views: CompactRecordView[]) => {
  const first = views[0];
  const turnId = compactTurnId(first) ?? "unscoped";
  return `${turnId}:${first.record.id}`;
};

const compactToolBatchSummary = (key: string, views: CompactRecordView[], expanded = false): CompactRecordView => {
  const first = views[0];
  const last = views.at(-1) ?? first;
  const labels = compactToolBatchLabels(views);
  const status = compactToolBatchStatus(views);
  const count = views.length;
  return {
    id: `compact-tool-batch:${key}`,
    role: "tool",
    label: "tools",
    text: [
      `${count} tool call${count === 1 ? "" : "s"}`,
      labels.length ? labels.join(", ") : null
    ].filter(Boolean).join("\n"),
    at: last.at ?? first.at,
    status,
    statusText: status,
    statusDurationMs: compactToolBatchDurationMs(views),
    record: first.record,
    toolBatch: {
      key,
      count,
      labels,
      expanded
    }
  };
};

const compactToolBatchLabels = (views: CompactRecordView[]) => {
  const counts = new Map<string, number>();
  for (const view of views) {
    const label = view.label.replace(/^tool(?: call)?:\s*/i, "").trim() || view.label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} ${label}`);
};

const compactToolBatchStatus = (views: CompactRecordView[]): CodexRecordView["status"] => {
  if (views.some((view) => view.status === "failed")) return "failed";
  if (views.some((view) => view.status === "in_progress")) return "in_progress";
  if (views.some((view) => view.status === "pending")) return "pending";
  return "completed";
};

const compactToolBatchDurationMs = (views: CompactRecordView[]) => {
  let total = 0;
  let hasDuration = false;
  for (const view of views) {
    if (typeof view.statusDurationMs !== "number" || !Number.isFinite(view.statusDurationMs)) continue;
    total += Math.max(0, view.statusDurationMs);
    hasDuration = true;
  }
  return hasDuration ? total : undefined;
};

const isBatchableToolView = (view: CompactRecordView) => view.role === "tool" && !view.toolBatch;

const compactTurnId = (view: CodexRecordView) => {
  const parts = view.record.id.split(":");
  return parts[0] === "app" && parts.length >= 3 ? parts[2] : undefined;
};

const isInternalMessage = (payload: Record<string, unknown>) =>
  payload.role !== "user" && payload.role !== "assistant";

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
