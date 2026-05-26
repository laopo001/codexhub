import { asRecord } from "../core/codexRecord.js";
import type { CodexRecord } from "../core/codexRecord.js";
import type { CodexRecordView } from "../core/codexRecordView.js";

export type CompactRecordView = CodexRecordView & {
  inspectRecord?: CodexRecord;
  inspectCallText?: string;
  inspectText?: string;
};

export type CompactRecordViewState = {
  views: CompactRecordView[];
  toolIndexes: Map<string, number>;
};

export type CompactRecordViewChange = {
  view: CompactRecordView;
  appended: boolean;
  previousId?: string;
};

export const createCompactRecordViewState = (): CompactRecordViewState => ({
  views: [],
  toolIndexes: new Map()
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
  if (view.role !== "tool") {
    const compactView = view;
    state.views.push(compactView);
    return { view: compactView, appended: true };
  }

  const payload = asRecord(view.record.payload);
  if (view.status === "pending") {
    const callId = compactToolCallId(view);
    state.toolIndexes.set(callId, state.views.length);
    const compactView: CompactRecordView = {
      ...view,
      id: `compact-tool:${callId}`,
      label: view.label.replace(/^tool call:\s*/i, "tool: "),
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

const compactToolCallId = (view: CodexRecordView) => {
  const payload = asRecord(view.record.payload);
  return typeof payload?.call_id === "string" ? payload.call_id : view.id;
};

const formatCompactToolCall = (view: CodexRecordView) => {
  const payload = asRecord(view.record.payload);
  if (payload?.type !== "function_call") return view.text;
  const name = typeof payload.name === "string" ? payload.name : "tool";
  const args = parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "");
  if (name === "write_stdin" && args) return formatWriteStdinSummary(args);
  if (name === "exec_command" && typeof args?.cmd === "string") return `$ ${args.cmd}`;
  if (args) return `${name} ${JSON.stringify(args)}`;
  return view.text;
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
