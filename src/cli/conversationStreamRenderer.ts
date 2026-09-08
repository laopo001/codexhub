import { recordsToViews, type CodexRecordView } from "../core/codexRecordView.js";
import { asRecord, type CodexRecord } from "../shared/recordTypes.js";

export type ConversationStreamOutput = "normal" | "raw";

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

export type ConversationStreamError = {
  threadId?: string;
  message: string;
};

export type ConversationStreamCompletion = {
  threadId: string;
  lastSeq: number;
  submissionId?: string;
  delivery?: string;
};

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
  private readonly completedToolRecordIds = new Set<string>();
  private assistantStream: AssistantStreamState | undefined;

  constructor(
    private readonly output: ConversationStreamOutput,
    private readonly write: StreamWriter = (chunk) => process.stdout.write(chunk)
  ) {}

  threadStarted(target: ConversationThreadTarget) {
    if (this.output === "raw") {
      this.writeJson({
        version: 1,
        type: "codexhub.thread.started",
        threadId: target.threadId,
        machineId: target.machineId,
        cwd: target.cwd
      });
      return;
    }
    this.writeNormal(`Thread ID: ${target.threadId}`);
  }

  event(event: ConversationStreamEvent) {
    if (this.output === "raw") {
      if (event.kind === "record") {
        this.writeJson({
          version: 1,
          type: "codexhub.record",
          threadId: event.threadId,
          ...(event.seq === undefined ? {} : { seq: event.seq }),
          record: event.record
        });
      } else {
        this.writeJson({
          version: 1,
          type: "codexhub.record_delta",
          threadId: event.threadId,
          ...(event.seq === undefined ? {} : { seq: event.seq }),
          delta: event.delta
        });
      }
      return;
    }

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
    if (this.output === "raw") {
      this.writeJson({
        version: 1,
        type: "codexhub.error",
        ...(error.threadId ? { threadId: error.threadId } : {}),
        message: error.message
      });
      return;
    }
    this.flushAssistant();
    this.writeBlock("error", error.message);
  }

  completed(completion: ConversationStreamCompletion) {
    if (this.output !== "raw") {
      this.flushAssistant();
      return;
    }
    this.writeJson({
      version: 1,
      type: "codexhub.turn.completed",
      threadId: completion.threadId,
      lastSeq: completion.lastSeq,
      ...(completion.submissionId ? { submissionId: completion.submissionId } : {}),
      ...(completion.delivery ? { delivery: completion.delivery } : {})
    });
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

  private renderTool(view: CodexRecordView, previous: CodexRecordView | undefined) {
    const textChanged = !previous || previous.text !== view.text;
    const labelChanged = !previous || previous.label !== view.label;
    if (previous && !textChanged && !labelChanged
      && previous.status === view.status && previous.statusText === view.statusText) return;

    if (isToolStartView(view)) {
      const startText = toolStartText(view);
      if (!previous || startText !== toolStartText(previous) || labelChanged) {
        this.writeBlock(view.label, startText);
      }
      return;
    }

    this.writeToolResult(view);
  }

  private writeToolResult(view: CodexRecordView) {
    if (this.completedToolRecordIds.has(view.id) && !isFailedView(view)) return;
    const text = isSuccessfulToolOutput(view) ? trimSuccessfulToolOutput(view.text) : view.text;
    this.writeBlock(view.label, text);
    if (view.status === "completed" || isFailedView(view)) this.completedToolRecordIds.add(view.id);
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

  private writeNormal(text: string) {
    this.write(`${text}\n`);
  }

  private writeJson(value: Record<string, unknown>) {
    this.write(`${JSON.stringify(value)}\n`);
  }
}

const isVisibleView = (view: CodexRecordView) =>
  view.role === "codex" || view.role === "tool" || view.role === "error";

const isToolView = (view: CodexRecordView) => view.role === "tool";

const isToolStartView = (view: CodexRecordView) =>
  view.status === "pending" || view.status === "in_progress";

const toolStartText = (view: CodexRecordView) => {
  const payload = asRecord(view.record.payload);
  if (payload?.type === "local_shell_call") return view.text.split("\n", 1)[0] ?? "";
  return view.text;
};

const isSuccessfulToolOutput = (view: CodexRecordView) => {
  if (!isToolView(view) || view.status !== "completed" || isFailedView(view)) return false;
  const payload = asRecord(view.record.payload);
  const type = typeof payload?.type === "string" ? payload.type : "";
  return type === "local_shell_call"
    || type === "mcp_tool_call"
    || type.endsWith("_output");
};

const isFailedView = (view: CodexRecordView) => {
  if (view.status === "failed") return true;
  const payload = asRecord(view.record.payload);
  const status = typeof payload?.status === "string"
    ? payload.status.trim().replace(/[-\s]+/g, "_").toLowerCase()
    : "";
  return ["failed", "failure", "error", "errored", "declined", "denied", "interrupted", "aborted", "cancelled", "canceled"].includes(status)
    || payload?.error !== undefined && payload.error !== null;
};

const trimSuccessfulToolOutput = (text: string) => {
  const lines = text.split("\n");
  if (lines.length <= 10) return text;
  const omitted = lines.length - 10;
  return [
    ...lines.slice(0, 5),
    `… ${omitted} lines omitted …`,
    ...lines.slice(-5)
  ].join("\n");
};
