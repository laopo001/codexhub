import React from "react";
import { asRecord, type CodexRecord } from "../../core/codexRecord.js";
import type { CodexRecordView } from "../../core/codexRecordView.js";
import { normalizeUpdatePlanStatus, parseUpdatePlanArguments, updatePlanStatusIcon, updatePlanStatusLabel, type UpdatePlanView as UpdatePlanViewModel } from "../../shared/updatePlanView.js";
import type { InspectDetail, ParsedToolCall, WebRecordView, WebToolPresenter } from "../types.js";
import { emptyMemoryCitation, parseMemoryCitationText, shouldExtractMemoryCitation } from "./components.js";
import { fileChangePreviewFiles } from "./fileChanges.js";
import { statusLabel } from "./common.js";
import { formatCompactNumber } from "./records.js";

export const UpdatePlanPreview = ({
  plan,
  status
}: {
  plan: UpdatePlanViewModel;
  status?: CodexRecordView["status"];
}) => (
  <ToolPreview title="Updated Plan" status={status} className="updatePlanPreview">
    {plan.explanation ? <p className="updatePlanExplanation">{plan.explanation}</p> : null}
    {plan.steps.length ? (
      <ol className="updatePlanSteps">
        {plan.steps.map((step, index) => {
          const normalizedStatus = normalizeUpdatePlanStatus(step.status);
          return (
            <li className={`updatePlanStep ${normalizedStatus}`} key={`${index}:${step.step}`} title={updatePlanStatusLabel(step.status)}>
              <span className="updatePlanStepIcon" aria-hidden="true">{updatePlanStatusIcon(step.status)}</span>
              <span className="updatePlanStepText">{step.step}</span>
            </li>
          );
        })}
      </ol>
    ) : null}
  </ToolPreview>
);

export const CommandToolPreview = ({
  args,
  status
}: {
  args: Record<string, unknown>;
  status?: CodexRecordView["status"];
}) => {
  const command = typeof args.cmd === "string" ? formatCommandBlock(args.cmd) : "<missing>";
  return (
    <ToolPreview title="tool: exec_command" status={status} meta={toolPreviewMeta(args)}>
      <pre className="toolCommandLine">{command.includes("\n") ? command : `$ ${command}`}</pre>
    </ToolPreview>
  );
};

export const WriteStdinToolPreview = ({
  args,
  status
}: {
  args: Record<string, unknown>;
  status?: CodexRecordView["status"];
}) => (
  <ToolPreview title="tool: write_stdin" status={status} meta={toolPreviewMeta(args)}>
    <p className="toolPreviewBody">{formatWriteStdinSummary(args)}</p>
  </ToolPreview>
);

export const ToolPreview = ({
  title,
  status,
  className = "",
  meta,
  children
}: {
  title: string;
  status?: CodexRecordView["status"];
  className?: string;
  meta?: string[];
  children: React.ReactNode;
}) => (
  <div className={`toolPreview ${className}`.trim()}>
    <div className="toolPreviewTitle">
      <span className="toolPreviewTitleMark" aria-hidden="true">•</span>
      <strong>{title}</strong>
      {status ? <em className={`messageStatus ${status}`}>{statusLabel(status)}</em> : null}
    </div>
    {meta?.length ? (
      <div className="toolPreviewMeta">
        {meta.map((item) => <span className="toolPreviewMetaItem" key={item} title={item}>{item}</span>)}
      </div>
    ) : null}
    {children}
  </div>
);

export const FileChangePreview = ({
  payload,
  status
}: {
  payload: Record<string, unknown>;
  status?: CodexRecordView["status"];
}) => {
  const files = fileChangePreviewFiles(payload);
  const visibleFiles = files.slice(0, 5);
  const hiddenCount = files.length - visibleFiles.length;
  const title = status === "failed" ? "Patch failed" : "Files changed";
  return (
    <ToolPreview title={title} status={status} meta={appServerToolMeta(payload)} className="fileChangePreview">
      {visibleFiles.length ? (
        <div className="fileChangeList">
          {visibleFiles.map((file, index) => (
            <div className="fileChangeRow" key={`${file.path}:${index}`} title={file.path}>
              <span className="fileChangePath">{file.path}</span>
              <span className="fileChangeStat added">+{file.added ?? "?"}</span>
              <span className="fileChangeStat removed">-{file.removed ?? "?"}</span>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <div className="fileChangeMore">+ {hiddenCount} more file{hiddenCount === 1 ? "" : "s"}</div>
          ) : null}
        </div>
      ) : (
        <p className="toolPreviewBody">No file changes</p>
      )}
    </ToolPreview>
  );
};

export const ApplyPatchPreview = ({
  args,
  status
}: {
  args: Record<string, unknown>;
  status?: CodexRecordView["status"];
}) => {
  const patch = applyPatchInput(args);
  const files = parseApplyPatchFiles(patch);
  const visibleFiles = files.slice(0, 5);
  const hiddenCount = files.length - visibleFiles.length;
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  return (
    <ToolPreview
      title="tool: apply_patch"
      status={status}
      meta={[
        files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : null,
        added ? `+${added}` : null,
        removed ? `-${removed}` : null
      ].filter((item): item is string => Boolean(item))}
      className="fileChangePreview applyPatchPreview"
    >
      {visibleFiles.length ? (
        <div className="fileChangeList">
          {visibleFiles.map((file, index) => (
            <div className="fileChangeRow applyPatchRow" key={`${file.path}:${index}`} title={file.path}>
              <span className={`patchKind ${file.kind}`}>{file.kind}</span>
              <span className="fileChangePath">{file.path}</span>
              <span className="fileChangeStat added">+{file.added}</span>
              <span className="fileChangeStat removed">-{file.removed}</span>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <div className="fileChangeMore">+ {hiddenCount} more file{hiddenCount === 1 ? "" : "s"}</div>
          ) : null}
        </div>
      ) : (
        <p className="toolPreviewBody">{patch ? "Patch" : "Empty patch"}</p>
      )}
    </ToolPreview>
  );
};

export const webToolPresenters: Record<string, WebToolPresenter> = {
  exec_command: {
    render: (args, status) => <CommandToolPreview args={args} status={status} />,
    inspect: (args, output) => ({
      ...formatToolInput("exec_command", args),
      ...formatRawToolOutput(output)
    })
  },
  update_plan: {
    render: (args, status) => {
      const plan = parseUpdatePlanArguments(args);
      return plan ? <UpdatePlanPreview plan={plan} status={status} /> : null;
    },
    inspect: (args, output) => {
      const plan = parseUpdatePlanArguments(args);
      return plan ? {
        inputMeta: formatUpdatePlanInspectInput(plan),
        outputMeta: output.trimEnd() || undefined
      } : null;
    }
  },
  write_stdin: {
    render: (args, status) => <WriteStdinToolPreview args={args} status={status} />,
    inspect: (args, output) => ({
      ...formatToolInput("write_stdin", args),
      ...formatRawToolOutput(output)
    })
  },
  apply_patch: {
    render: (args, status) => <ApplyPatchPreview args={args} status={status} />,
    inspect: (args, output) => ({
      ...formatApplyPatchInspect(args),
      ...formatRawToolOutput(output)
    })
  }
};

export const formatInspectDetail = (message: WebRecordView): InspectDetail => {
  const inspectRecord = message.inspectRecord ?? message.record;
  const payload = asRecord(inspectRecord.payload);
  const output = normalizeWebToolOutput(message.inspectText ?? (typeof payload?.output === "string" ? payload.output.trimEnd() : ""));
  const toolCall = parseToolCallMessage(message);
  const presenterInspect = toolCall
    ? webToolPresenters[toolCall.name]?.inspect?.(toolCall.args, output)
    : null;
  const raw = formatRawJsonlInspect(inspectRecord);
  if (presenterInspect) return { ...presenterInspect, ...raw };

  const parsedMessageText = shouldExtractMemoryCitation(message)
    ? parseMemoryCitationText(message.inspectCallText ?? message.text)
    : emptyMemoryCitation(message.inspectCallText ?? message.text);
  const callText = parsedMessageText.text;
  return {
    ...formatInspectInput(message.record, callText.trimEnd()),
    memoryCitation: parsedMessageText.entries.length || parsedMessageText.rolloutIds.length ? parsedMessageText : undefined,
    ...formatInspectOutput(message.record, output),
    ...raw
  };
};

export const formatInspectTitle = (message: WebRecordView) => {
  const toolCall = parseToolCallMessage(message);
  return toolCall ? `tool: ${toolCall.name}` : message.label;
};

export const renderToolMessageBody = (message: WebRecordView, status?: CodexRecordView["status"]) => {
  const toolCall = parseToolCallMessage(message);
  if (toolCall) return webToolPresenters[toolCall.name]?.render?.(toolCall.args, status) ?? null;
  return renderAppServerToolPreview(message, status);
};

export const parseToolCallMessage = (message: WebRecordView): ParsedToolCall | null => {
  if (message.role !== "tool") return null;
  const payload = asRecord(message.record.payload);
  if (payload?.type !== "function_call") return null;
  const name = typeof payload.name === "string" ? payload.name : "tool";
  const args = parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "");
  return { name, args: args ?? {} };
};

export const renderAppServerToolPreview = (message: WebRecordView, status?: CodexRecordView["status"]) => {
  if (message.role !== "tool") return null;
  const payload = asRecord(message.record.payload);
  if (!payload) return null;

  if (payload.type === "local_shell_call") {
    return (
      <ToolPreview title="tool: shell" status={status} meta={appServerToolMeta(payload)}>
        <pre className="toolCommandLine">{message.text || "$ <empty>"}</pre>
      </ToolPreview>
    );
  }

  if (payload.type === "file_change") {
    return (
      <FileChangePreview payload={payload} status={status} />
    );
  }

  if (payload.type === "web_search_call") {
    return (
      <ToolPreview title="tool: web_search" status={status} meta={appServerToolMeta(payload)}>
        <p className="toolPreviewBody">{typeof payload.query === "string" && payload.query ? payload.query : message.text}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "mcp_tool_call") {
    return (
      <ToolPreview title={`tool: ${mcpToolPreviewName(payload)}`} status={status} meta={appServerToolMeta(payload)}>
        <p className="toolPreviewBody">{message.text || "MCP tool call"}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "image_generation_call") {
    return (
      <ToolPreview title="tool: image_generation" status={status} meta={appServerToolMeta(payload)}>
        <p className="toolPreviewBody">{message.text || "Image generation"}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "function_call_output") {
    return (
      <ToolPreview title="tool result" status={status} meta={appServerToolMeta(payload)}>
        <p className="toolPreviewBody">{message.text || "Completed"}</p>
      </ToolPreview>
    );
  }

  return null;
};

export const normalizeWebToolOutput = (output: string) => {
  const parsed = parseJsonObject(output);
  const preview = textPreview(parsed);
  return preview ?? output;
};

export const textPreview = (value: unknown) => {
  const record = asRecord(value);
  if (!record || record.text_omitted !== true || typeof record.text_preview !== "string") return null;
  const suffix = typeof record.text_length === "number" ? `\n[output truncated: ${record.text_length} chars]` : "";
  return `${record.text_preview}${suffix}`;
};

export const formatInspectOutput = (record: CodexRecord, output: string): Pick<InspectDetail, "outputMeta" | "outputBlockLabel" | "outputBlock"> => {
  const text = output.trimEnd();
  if (!text) return {};
  if (shouldShowRawToolOutput(record)) return formatStructuredToolOutput(text);
  return { outputMeta: formatToolOutputFields(text) ?? text };
};

export const formatRawJsonlInspect = (record: CodexRecord): Pick<InspectDetail, "rawBlockLabel" | "rawBlock"> => {
  if (record.rawJsonl == null) return {};
  return {
    rawBlockLabel: record.line ? `JSONL line ${record.line}` : "JSONL",
    rawBlock: stringifyInspectJson(record.rawJsonl)
  };
};

export const formatToolOutputFields = (output: string) => {
  const fields = parseJsonObject(output);
  if (!fields) return null;
  return Object.entries(fields).map(([key, value]) => `${key}: ${formatArgumentValue(value)}`).join("\n");
};

export const shouldShowRawToolOutput = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return payload?.type === "function_call"
    && (payload.name === "exec_command" || payload.name === "write_stdin");
};

export const formatStructuredToolOutput = (output: string): Pick<InspectDetail, "outputMeta" | "outputBlockLabel" | "outputBlock"> => {
  const marker = "\nOutput:\n";
  const index = output.indexOf(marker);
  if (index === -1) return { outputBlockLabel: "Text", outputBlock: output };
  const meta = output.slice(0, index).trimEnd();
  const body = output.slice(index + marker.length).trimEnd();
  return {
    outputMeta: meta,
    outputBlockLabel: "Stdout",
    outputBlock: cleanTerminalOutput(body) || "<empty>"
  };
};

export const formatRawToolOutput = (output: string): Pick<InspectDetail, "outputMeta" | "outputBlockLabel" | "outputBlock"> => {
  const text = output.trimEnd();
  return text ? formatStructuredToolOutput(text) : {};
};

export const cleanTerminalOutput = (text: string) => text
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[@-Z\\-_]/g, "")
  .replace(/\r\n/g, "\n")
  .replace(/\r/g, "\n");

export const formatInspectInput = (record: CodexRecord, fallback: string): Omit<InspectDetail, "output"> => {
  const payload = asRecord(record.payload);
  if (payload?.type !== "function_call") return { inputMeta: fallback };
  const name = typeof payload.name === "string" ? payload.name : "tool";
  const args = parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "");
  if (!args) return { inputMeta: fallback };
  return formatToolInput(name, args);
};

export const formatToolInput = (name: string, args: Record<string, unknown>): Omit<InspectDetail, "output"> => {
  if (name === "write_stdin") {
    return {
      inputMeta: [
        `tool: write_stdin`,
        `action: ${describeWriteStdinAction(args)}`,
        typeof args.session_id === "number" || typeof args.session_id === "string" ? `session_id: ${args.session_id}` : null,
        typeof args.yield_time_ms === "number" ? `wait: ${formatMilliseconds(args.yield_time_ms)}` : null,
        typeof args.max_output_tokens === "number" ? `max_output: ${formatCompactNumber(args.max_output_tokens)} tokens` : null
      ].filter((line): line is string => Boolean(line)).join("\n"),
      inputBlockLabel: "Stdin",
      inputBlock: formatWriteStdinBlock(args)
    };
  }
  if (name === "exec_command") {
    return {
      inputMeta: [
        `tool: exec_command`,
        typeof args.workdir === "string" ? `workdir: ${args.workdir}` : null,
        typeof args.yield_time_ms === "number" ? `wait: ${formatMilliseconds(args.yield_time_ms)}` : null,
        typeof args.max_output_tokens === "number" ? `max_output: ${formatCompactNumber(args.max_output_tokens)} tokens` : null
      ].filter((line): line is string => Boolean(line)).join("\n"),
      inputBlockLabel: "Command",
      inputBlock: typeof args.cmd === "string" ? formatCommandBlock(args.cmd) : "<missing>"
    };
  }
  return {
    inputMeta: [
      `tool: ${name}`,
      ...Object.entries(args).map(([key, value]) => `${key}: ${formatArgumentValue(value)}`)
    ].join("\n")
  };
};

export const toolPreviewMeta = (args: Record<string, unknown>) => [
  typeof args.workdir === "string" ? args.workdir : null,
  typeof args.yield_time_ms === "number" ? `wait ${formatMilliseconds(args.yield_time_ms)}` : null,
  typeof args.max_output_tokens === "number" ? `max ${formatCompactNumber(args.max_output_tokens)} tokens` : null
].filter((item): item is string => Boolean(item));

export const appServerToolMeta = (payload: Record<string, unknown>) => [
  typeof payload.status === "string" ? payload.status : null,
  typeof payload.exit_code === "number" ? `exit ${payload.exit_code}` : null,
  typeof payload.call_id === "string" ? payload.call_id : null,
  Array.isArray(payload.changes) ? `${payload.changes.length} files` : null
].filter((item): item is string => Boolean(item));

type ApplyPatchFile = {
  path: string;
  kind: "add" | "update" | "delete" | "move";
  added: number;
  removed: number;
};

export const applyPatchInput = (args: Record<string, unknown>) =>
  typeof args.input === "string"
    ? args.input
    : typeof args.patch === "string"
      ? args.patch
      : "";

export const parseApplyPatchFiles = (patch: string): ApplyPatchFile[] => {
  const files: ApplyPatchFile[] = [];
  let current: ApplyPatchFile | null = null;
  const flush = () => {
    if (current) files.push(current);
    current = null;
  };

  for (const line of patch.split(/\r?\n/)) {
    const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (fileMatch) {
      flush();
      current = {
        path: fileMatch[2] ?? "<unknown>",
        kind: applyPatchKind(fileMatch[1]),
        added: 0,
        removed: 0
      };
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (moveMatch && current) {
      current = {
        ...current,
        path: `${current.path} -> ${moveMatch[1]}`,
        kind: "move"
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
  }

  flush();
  return files;
};

export const applyPatchKind = (kind: string | undefined): ApplyPatchFile["kind"] => {
  if (kind === "Add") return "add";
  if (kind === "Delete") return "delete";
  return "update";
};

export const formatApplyPatchInspect = (args: Record<string, unknown>): InspectDetail => {
  const patch = applyPatchInput(args);
  const files = parseApplyPatchFiles(patch);
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  return {
    inputMeta: [
      "tool: apply_patch",
      files.length ? `files: ${files.length}` : null,
      added ? `added: ${added}` : null,
      removed ? `removed: ${removed}` : null,
      ...files.slice(0, 12).map((file) => `${file.kind}: ${file.path} +${file.added} -${file.removed}`),
      files.length > 12 ? `... ${files.length - 12} more files` : null
    ].filter((line): line is string => Boolean(line)).join("\n"),
    inputBlockLabel: "Patch",
    inputBlock: patch || "<empty>"
  };
};

export const mcpToolPreviewName = (payload: Record<string, unknown>) => [
  typeof payload.server === "string" ? payload.server : null,
  typeof payload.tool === "string" ? payload.tool : null
].filter(Boolean).join(".") || "mcp";

export const formatUpdatePlanInspectInput = (plan: UpdatePlanViewModel) => [
  "tool: update_plan",
  plan.explanation ? `explanation: ${plan.explanation}` : null,
  ...plan.steps.map((step) => `${updatePlanStatusIcon(step.status)} ${step.step} [${updatePlanStatusLabel(step.status)}]`)
].filter((line): line is string => Boolean(line)).join("\n");

export const formatWriteStdinSummary = (args: Record<string, unknown>) => {
  const session = typeof args.session_id === "number" || typeof args.session_id === "string" ? `session ${args.session_id}` : "session";
  return `stdin: ${formatWriteStdinChars(args)} -> ${session}`;
};

export const describeWriteStdinAction = (args: Record<string, unknown>) => {
  const chars = typeof args.chars === "string" ? args.chars : "";
  if (!chars) return "poll";
  if (chars === "\u0003") return "send Ctrl-C";
  if (chars === "\n") return "send Enter";
  if (chars.length <= 48) return `send ${JSON.stringify(chars)}`;
  return `send ${chars.length} chars`;
};

export const formatWriteStdinChars = (args: Record<string, unknown>) => {
  if (typeof args.chars !== "string") return "<missing>";
  if (!args.chars) return "<empty> (poll only; no stdin was written)";
  if (args.chars === "\u0003") return "Ctrl-C (\\u0003)";
  if (args.chars === "\n") return "Enter (\\n)";
  return JSON.stringify(args.chars);
};

export const formatWriteStdinBlock = (args: Record<string, unknown>) => {
  if (typeof args.chars !== "string") return "<missing>";
  if (!args.chars) return "<empty> (poll only; no stdin was written)";
  if (args.chars === "\u0003") return "Ctrl-C (\\u0003)";
  if (args.chars === "\n") return "Enter (\\n)";
  return args.chars.trimEnd();
};

export const formatCommandBlock = (value: string) => value.trimEnd();

const formatMilliseconds = (value: number) => {
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}s`;
  return `${value}ms`;
};

const formatArgumentValue = (value: unknown) => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "null";
  return JSON.stringify(value);
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

const stringifyInspectJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

