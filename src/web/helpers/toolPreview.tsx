import React from "react";
import { FileDiff, Image, Plug, Search, Sparkles, Terminal, Users, Workflow } from "lucide-react";
import { asRecord, type CodexRecord } from "../../core/codexRecord.js";
import type { CodexRecordView } from "../../core/codexRecordView.js";
import { normalizeUpdatePlanStatus, parseUpdatePlanArguments, updatePlanStatusIcon, updatePlanStatusLabel, type UpdatePlanView as UpdatePlanViewModel } from "../../shared/updatePlanView.js";
import type { InspectDetail, ParsedToolCall, WebRecordView, WebToolPresenter } from "../types.js";
import { emptyMemoryCitation, parseMemoryCitationText, shouldExtractMemoryCitation } from "./components.js";
import { fileChangePreviewFiles } from "./fileChanges.js";
import { statusLabel } from "./common.js";
import { formatCompactNumber } from "./records.js";

type ToolPreviewIcon = React.ComponentType<{
  className?: string;
  size?: number;
  strokeWidth?: number;
}>;

export const UpdatePlanPreview = ({
  plan,
  status
}: {
  plan: UpdatePlanViewModel;
  status?: CodexRecordView["status"];
}) => (
  <ToolPreview title="Updated Plan" status={status} className="updatePlanPreview" icon={Workflow}>
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
    <ToolPreview title="tool: exec_command" status={status} meta={toolPreviewMeta(args)} icon={Terminal}>
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
  <ToolPreview title="tool: write_stdin" status={status} meta={toolPreviewMeta(args)} icon={Terminal}>
    <p className="toolPreviewBody">{formatWriteStdinSummary(args)}</p>
  </ToolPreview>
);

export const ToolPreview = ({
  title,
  status,
  className = "",
  meta,
  icon: Icon,
  children
}: {
  title: string;
  status?: CodexRecordView["status"];
  className?: string;
  meta?: string[];
  icon?: ToolPreviewIcon;
  children: React.ReactNode;
}) => (
  <div className={`toolPreview ${className}`.trim()}>
    <div className="toolPreviewTitle">
      <span className="toolPreviewTitleMark" aria-hidden="true">
        {Icon ? <Icon className="toolPreviewIcon" size={16} strokeWidth={2.2} /> : "•"}
      </span>
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
    <ToolPreview title={title} status={status} meta={appServerToolMeta(payload)} className="fileChangePreview" icon={FileDiff}>
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
      icon={FileDiff}
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
  const images = formatInspectImages(message);
  if (presenterInspect) return { ...presenterInspect, ...images };

  const messagePayload = asRecord(message.record.payload);
  const appServerInspect = messagePayload ? formatAppServerInspectDetail(message, messagePayload) : null;
  if (appServerInspect) return { ...appServerInspect, ...images };

  const parsedMessageText = shouldExtractMemoryCitation(message)
    ? parseMemoryCitationText(message.inspectCallText ?? message.text)
    : emptyMemoryCitation(message.inspectCallText ?? message.text);
  const callText = parsedMessageText.text;
  return {
    ...formatInspectInput(message.record, callText.trimEnd()),
    ...images,
    memoryCitation: parsedMessageText.entries.length || parsedMessageText.rolloutIds.length ? parsedMessageText : undefined,
    ...formatInspectOutput(message.record, output)
  };
};

const formatInspectImages = (message: WebRecordView): Pick<InspectDetail, "imageUrls"> => {
  const imageUrls = message.attachments
    ?.filter((attachment) => attachment.type === "image" && attachment.url)
    .map((attachment) => attachment.url);
  return imageUrls?.length ? { imageUrls } : {};
};

export const formatInspectTitle = (message: WebRecordView) => {
  const toolCall = parseToolCallMessage(message);
  return toolCall ? `tool: ${toolCall.name}` : message.label;
};

export const renderToolMessageBody = (message: WebRecordView, status?: CodexRecordView["status"]) => {
  const toolCall = parseToolCallMessage(message);
  if (toolCall) return webToolPresenters[toolCall.name]?.render?.(toolCall.args, status) ?? (
    <FunctionCallPreview message={message} toolCall={toolCall} status={status} />
  );
  return renderAppServerToolPreview(message, status);
};

export const FunctionCallPreview = ({
  message,
  toolCall,
  status
}: {
  message: WebRecordView;
  toolCall: ParsedToolCall;
  status?: CodexRecordView["status"];
}) => {
  const payload = asRecord(message.record.payload) ?? {};
  const namespace = typeof payload.namespace === "string" && payload.namespace ? payload.namespace : "";
  const title = `tool: ${[namespace, toolCall.name].filter(Boolean).join(".") || toolCall.name}`;
  return (
    <ToolPreview title={title} status={status} meta={appServerToolMeta(payload)} icon={Workflow}>
      <p className="toolPreviewBody">{formatFunctionCallPreview(toolCall.name, toolCall.args)}</p>
    </ToolPreview>
  );
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
      <ToolPreview title="tool: shell" status={status} meta={appServerToolMeta(payload)} icon={Terminal}>
        <pre className="toolCommandLine">{shellCommandPreview(payload)}</pre>
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
      <ToolPreview title="tool: web_search" status={status} meta={appServerToolMeta(payload)} icon={Search}>
        <p className="toolPreviewBody">{typeof payload.query === "string" && payload.query ? payload.query : message.text}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "mcp_tool_call") {
    return (
      <ToolPreview title={`tool: ${mcpToolPreviewName(payload)}`} status={status} meta={appServerToolMeta(payload)} icon={Plug}>
        <p className="toolPreviewBody">{formatToolArgumentsPreview(payload.arguments)}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "collab_agent_tool_call") {
    return (
      <ToolPreview title={`tool: ${collabAgentToolPreviewName(payload)}`} status={status} meta={appServerToolMeta(payload)} icon={Users}>
        <p className="toolPreviewBody">{collabAgentToolInputPreview(payload)}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "image_view") {
    return (
      <ToolPreview title="tool: image_view" status={status} meta={appServerToolMeta(payload)} icon={Image}>
        <p className="toolPreviewBody">{typeof payload.path === "string" && payload.path ? payload.path : message.text}</p>
      </ToolPreview>
    );
  }

  if (payload.type === "image_generation_call") {
    return (
      <ToolPreview title="tool: image_generation" status={status} meta={appServerToolMeta(payload)} icon={Sparkles}>
        <p className="toolPreviewBody">{imageGenerationInputPreview(payload)}</p>
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

const formatAppServerInspectDetail = (
  message: WebRecordView,
  payload: Record<string, unknown>
): InspectDetail | null => {
  if (payload.type === "local_shell_call") {
    const output = typeof payload.aggregated_output === "string" ? cleanTerminalOutput(payload.aggregated_output).trimEnd() : "";
    return {
      inputMeta: appServerInspectMeta("tool: shell", payload),
      inputBlockLabel: "Command",
      inputBlock: shellCommandText(payload) || "<empty>",
      outputMeta: appServerOutputMeta(payload),
      outputBlockLabel: "Output",
      outputBlock: output || undefined
    };
  }

  if (payload.type === "file_change") {
    const files = fileChangePreviewFiles(payload);
    return {
      inputMeta: appServerInspectMeta("tool: file_change", payload),
      inputBlockLabel: "Files",
      inputBlock: files.length
        ? files.map((file) => `${file.path} +${file.added ?? "?"} -${file.removed ?? "?"}`).join("\n")
        : "No file changes",
      outputMeta: payload.status === "failed" ? "Patch failed" : "Patch applied"
    };
  }

  if (payload.type === "mcp_tool_call") {
    const error = asRecord(payload.error);
    return {
      inputMeta: appServerInspectMeta(`tool: ${mcpToolPreviewName(payload)}`, payload),
      inputBlockLabel: "Arguments",
      inputBlock: formatJsonBlock(payload.arguments ?? {}),
      outputMeta: typeof error?.message === "string" ? error.message : appServerOutputMeta(payload),
      outputBlockLabel: typeof error?.message === "string" ? "Error" : "Result",
      outputBlock: payload.result == null ? undefined : formatJsonBlock(payload.result)
    };
  }

  if (payload.type === "function_call") {
    const toolCall = parseToolCallMessage(message);
    const name = toolCall?.name ?? (typeof payload.name === "string" ? payload.name : "tool");
    const args = toolCall?.args ?? parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "") ?? {};
    const output = dynamicToolOutputText(payload);
    return {
      inputMeta: appServerInspectMeta(`tool: ${formatNamespacedToolName(payload, name)}`, payload),
      inputBlockLabel: "Arguments",
      inputBlock: formatJsonBlock(args),
      outputMeta: dynamicToolOutputMeta(payload),
      outputBlockLabel: "Output",
      outputBlock: output || undefined
    };
  }

  if (payload.type === "web_search_call") {
    return {
      inputMeta: appServerInspectMeta("tool: web_search", payload),
      inputBlockLabel: "Query",
      inputBlock: typeof payload.query === "string" && payload.query ? payload.query : "<empty>",
      outputMeta: appServerOutputMeta(payload),
      outputBlockLabel: "Action",
      outputBlock: payload.action == null ? undefined : formatJsonBlock(payload.action)
    };
  }

  if (payload.type === "collab_agent_tool_call") {
    return {
      inputMeta: appServerInspectMeta(`tool: ${collabAgentToolPreviewName(payload)}`, payload),
      inputBlockLabel: "Prompt",
      inputBlock: typeof payload.prompt === "string" && payload.prompt.trim() ? payload.prompt : "<empty>",
      outputMeta: appServerOutputMeta(payload),
      outputBlockLabel: "Agent State",
      outputBlock: payload.agents_states == null ? undefined : formatJsonBlock(payload.agents_states)
    };
  }

  if (payload.type === "image_view") {
    return {
      inputMeta: appServerInspectMeta("tool: image_view", payload),
      inputBlockLabel: "Path",
      inputBlock: typeof payload.path === "string" && payload.path ? payload.path : "<empty>",
      outputMeta: "Image opened"
    };
  }

  if (payload.type === "image_generation_call") {
    return {
      inputMeta: appServerInspectMeta("tool: image_generation", payload),
      inputBlockLabel: "Prompt",
      inputBlock: imageGenerationInputPreview(payload),
      outputMeta: imageGenerationOutputMeta(payload),
      outputBlockLabel: "Result",
      outputBlock: imageGenerationOutputBlock(payload)
    };
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
  typeof payload.namespace === "string" ? `ns ${payload.namespace}` : null,
  typeof payload.tool === "string" ? payload.tool : null,
  typeof payload.call_id === "string" ? payload.call_id : null,
  Array.isArray(payload.changes) ? `${payload.changes.length} files` : null,
  Array.isArray(payload.receiver_thread_ids) ? `${payload.receiver_thread_ids.length} agents` : null,
  typeof payload.path === "string" ? payload.path : null
].filter((item): item is string => Boolean(item));

const appServerInspectMeta = (title: string, payload: Record<string, unknown>) => [
  title,
  typeof payload.status === "string" ? `status: ${payload.status}` : null,
  typeof payload.exit_code === "number" ? `exit: ${payload.exit_code}` : null,
  typeof payload.success === "boolean" ? `success: ${payload.success}` : null,
  typeof payload.call_id === "string" ? `call_id: ${payload.call_id}` : null,
  typeof payload.namespace === "string" ? `namespace: ${payload.namespace}` : null,
  typeof payload.path === "string" ? `path: ${payload.path}` : null
].filter((line): line is string => Boolean(line)).join("\n");

const appServerOutputMeta = (payload: Record<string, unknown>) => [
  typeof payload.status === "string" ? `status: ${payload.status}` : null,
  typeof payload.exit_code === "number" ? `exit: ${payload.exit_code}` : null,
  typeof payload.success === "boolean" ? `success: ${payload.success}` : null
].filter((line): line is string => Boolean(line)).join("\n") || undefined;

const shellCommandPreview = (payload: Record<string, unknown>) => {
  const command = shellCommandText(payload);
  return command ? `$ ${command}` : "$ <empty>";
};

const shellCommandText = (payload: Record<string, unknown>) => {
  const action = asRecord(payload.action);
  const commandValue = action?.command ?? payload.command ?? payload.cmd;
  if (Array.isArray(commandValue)) return commandValue.filter((part): part is string => typeof part === "string").join(" ");
  return typeof commandValue === "string" ? commandValue : "";
};

const formatToolArgumentsPreview = (value: unknown) => {
  if (value == null) return "No arguments";
  const preview = compactJsonPreview(value);
  return preview ? `args: ${preview}` : "No arguments";
};

const collabAgentToolInputPreview = (payload: Record<string, unknown>) => [
  typeof payload.prompt === "string" && payload.prompt.trim() ? compactTextPreview(payload.prompt) : null,
  Array.isArray(payload.receiver_thread_ids) && payload.receiver_thread_ids.length
    ? `receivers: ${payload.receiver_thread_ids.length}`
    : null,
  typeof payload.model === "string" ? `model: ${payload.model}` : null
].filter(Boolean).join("\n") || "Agent request";

const imageGenerationInputPreview = (payload: Record<string, unknown>) => {
  const prompt = typeof payload.prompt === "string" && payload.prompt.trim()
    ? payload.prompt
    : typeof payload.revised_prompt === "string" && payload.revised_prompt.trim()
      ? payload.revised_prompt
      : "";
  return prompt ? compactTextPreview(prompt) : "Image generation";
};

const imageGenerationOutputMeta = (payload: Record<string, unknown>) => [
  typeof payload.status === "string" ? `status: ${payload.status}` : null,
  typeof payload.saved_path === "string" ? `saved: ${payload.saved_path}` : null,
  typeof payload.result === "string" && payload.result ? `result: ${formatCompactNumber(payload.result.length)} chars` : null
].filter((line): line is string => Boolean(line)).join("\n") || undefined;

const imageGenerationOutputBlock = (payload: Record<string, unknown>) => {
  const revisedPrompt = typeof payload.revised_prompt === "string" && payload.revised_prompt.trim()
    ? `revised_prompt: ${payload.revised_prompt}`
    : "";
  const savedPath = typeof payload.saved_path === "string" && payload.saved_path
    ? `saved_path: ${payload.saved_path}`
    : "";
  return [revisedPrompt, savedPath].filter(Boolean).join("\n") || undefined;
};

const dynamicToolOutputMeta = (payload: Record<string, unknown>) => [
  typeof payload.status === "string" ? `status: ${payload.status}` : null,
  typeof payload.success === "boolean" ? `success: ${payload.success}` : null
].filter((line): line is string => Boolean(line)).join("\n") || undefined;

const dynamicToolOutputText = (payload: Record<string, unknown>) => {
  const contentItems = Array.isArray(payload.content_items) ? payload.content_items : [];
  const lines = contentItems.map((item) => {
    const record = asRecord(item);
    if (!record) return null;
    if (typeof record.text === "string") return record.text;
    if (typeof record.imageUrl === "string") return `image: ${record.imageUrl}`;
    return formatJsonBlock(record);
  }).filter((line): line is string => Boolean(line?.trim()));
  return lines.join("\n\n");
};

const formatNamespacedToolName = (payload: Record<string, unknown>, name: string) => [
  typeof payload.namespace === "string" && payload.namespace ? payload.namespace : null,
  name
].filter(Boolean).join(".") || name;

const formatJsonBlock = (value: unknown) => stringifyInspectJson(value);

const compactJsonPreview = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text || text === "{}") return "";
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
};

const compactTextPreview = (value: string) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 220)}...` : normalized;
};

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

export const collabAgentToolPreviewName = (payload: Record<string, unknown>) =>
  typeof payload.tool === "string" && payload.tool ? `agent.${payload.tool}` : "agent";

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

const formatFunctionCallPreview = (name: string, args: Record<string, unknown>) => {
  const fields = Object.entries(args);
  if (!fields.length) return name;
  return [
    name,
    ...fields.map(([key, value]) => `${key}: ${formatArgumentValue(value)}`)
  ].join("\n");
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
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};
