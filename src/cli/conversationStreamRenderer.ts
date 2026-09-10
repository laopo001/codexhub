import { recordsToViews, type CodexRecordView } from "../core/codexRecordView.js";
import { type CodexRecord } from "../shared/recordTypes.js";

import { toolPresentation } from "./conversationToolPresentation.js";

export type ConversationThreadTarget = {
  threadId: string;
  machineId: string;
  cwd: string;
};

export type ConversationStreamEvent =
  | {
      kind: "record";
      threadId: string;
      seq?: number;
      record: CodexRecord;
    }
  | {
      kind: "record_delta";
      threadId: string;
      seq?: number;
      delta: { recordId: string; field: "aggregated_output"; append: string };
      record?: CodexRecord;
    };

export type ConversationStreamError = { message: string };

type StreamWriter = (chunk: string) => void;

type AssistantStreamState = {
  id: string;
  text: string;
  wroteText: boolean;
};

/**
 * CLI-only presentation boundary. It consumes canonical CodexHub records and
 * never reads app-server events or the backend transcript directly.
 */
export class ConversationStreamRenderer {
  private readonly previousViews = new Map<string, CodexRecordView>();
  private readonly tools = new Map<string, { name: string; called: boolean; completed: boolean }>();
  private assistantStream: AssistantStreamState | undefined;

  constructor(private readonly write: StreamWriter = (chunk) => process.stdout.write(chunk)) {}

  threadStarted(target: ConversationThreadTarget) {
    this.write(`Thread ID: ${target.threadId}\n`);
  }

  event(event: ConversationStreamEvent) {
    const record = event.record;
    if (!record) return;
    const [view] = recordsToViews([record]);
    if (!view || !isVisibleView(view)) return;

    const previous = this.previousViews.get(record.id);
    this.previousViews.set(record.id, view);
    if (view.role === "codex") {
      this.renderAssistant(view, previous);
      return;
    }
    this.flushAssistant();
    if (view.role === "tool") {
      this.renderTool(view, previous);
      return;
    }
    this.renderErrorView(view, previous);
  }

  error(error: ConversationStreamError) {
    this.flushAssistant();
    this.writeBlock("error", error.message);
  }

  completed() {
    this.flushAssistant();
  }

  private renderAssistant(view: CodexRecordView, previous: CodexRecordView | undefined) {
    if (!previous) {
      if (this.assistantStream?.id !== view.id) this.flushAssistant();
      this.startAssistant(view);
      return;
    }

    const statusChanged = previous.status !== view.status || previous.statusText !== view.statusText;
    if (previous.label !== view.label) {
      this.flushAssistant();
      this.startAssistant(view);
      return;
    }
    if (previous.text === view.text) {
      // Status-only updates close the current text block, but never replay its
      // body. This is the common item/completed path for streamed messages.
      if (statusChanged) this.flushAssistant();
      return;
    }

    if (view.text.startsWith(previous.text)) {
      this.appendAssistant(view, view.text.slice(previous.text.length));
      if (statusChanged) this.flushAssistant();
      return;
    }

    // A producer replacement is not an append delta. Keep it explicit and
    // emit the replacement as a complete block instead of cutting a suffix at
    // an arbitrary Unicode/code-point boundary or in the middle of a word.
    this.flushAssistant();
    this.startAssistant(view, `${view.label} replaced`);
  }

  private startAssistant(view: CodexRecordView, label = view.label, text = view.text) {
    this.assistantStream = {
      id: view.id,
      text: view.text,
      wroteText: false
    };
    if (!text) return;
    this.write(`[${label}]\n`);
    this.write(text);
    this.assistantStream.wroteText = true;
  }

  private appendAssistant(view: CodexRecordView, delta: string) {
    if (!delta) return;
    if (!this.assistantStream || this.assistantStream.id !== view.id || !this.assistantStream.wroteText) {
      this.startAssistant(view, view.label, delta);
      return;
    }
    this.write(delta);
    this.assistantStream.text = view.text;
  }

  private flushAssistant() {
    const stream = this.assistantStream;
    this.assistantStream = undefined;
    if (!stream?.wroteText) return;
    if (!stream.text.endsWith("\n")) this.write("\n");
  }

  private renderTool(view: CodexRecordView, _previous: CodexRecordView | undefined) {
    const tool = toolPresentation(view);
    const state = this.tools.get(tool.key) ?? { name: tool.name, called: false, completed: false };
    this.tools.set(tool.key, state);
    if (!tool.outputOnly && !state.called) {
      state.name = tool.name;
      state.called = true;
      this.write(`${tool.call}\n`);
    }
    if (tool.terminal && !state.completed) {
      state.completed = true;
      if (tool.failed) this.writeBlock("tool_result", `${state.name}\n${tool.result}`);
    }
  }

  private renderErrorView(view: CodexRecordView, previous: CodexRecordView | undefined) {
    if (previous && previous.text === view.text && previous.label === view.label) return;
    this.writeBlock(view.label, view.text);
  }

  private writeBlock(label: string, text: string) {
    if (!text) return;
    this.write(`[${label}]\n`);
    this.write(text);
    if (!text.endsWith("\n")) this.write("\n");
  }

}

const isVisibleView = (view: CodexRecordView) =>
  view.role === "codex" || view.role === "tool" || view.role === "error";
