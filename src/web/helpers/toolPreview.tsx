import React from "react";
import { Tag } from "antd";
import { FileDiff, Image, MessageSquareText, Plug, Search, ShieldCheck, Sparkles, Terminal, Users, Workflow } from "lucide-react";
import { asRecord, type CodexRecord, type CodexRecordView } from "../../shared/recordTypes.js";
import { formatCompactNumber, formatWriteStdinSummary, parseJsonObject } from "../../shared/toolFormatting.js";
import { normalizeUpdatePlanStatus, parseUpdatePlanArguments, updatePlanStatusIcon, updatePlanStatusLabel, type UpdatePlanView as UpdatePlanViewModel } from "../../shared/updatePlanView.js";
import type { InspectDetail, ParsedToolCall, WebRecordView, WebToolPresenter } from "../types.js";
import { emptyMemoryCitation, parseMemoryCitationText, shouldExtractMemoryCitation } from "./memoryCitation.js";
import { fileChangePreviewFiles } from "./fileChanges.js";
import { LiveStatusLabel, StatusStartedAtContext } from "./liveTime.js";

type ToolPreviewIcon = React.ComponentType<{
  className?: string;
  size?: number;
  strokeWidth?: number;
}>;

type ShellCommandDisplay = {
  raw: string;
  display: string;
  wrapper?: string;
};

type ShellKind = "posix" | "powershell" | "cmd";

export const UpdatePlanPreview = ({
  plan,
  status,
  statusText,
  statusDurationMs
}: {
  plan: UpdatePlanViewModel;
  status?: CodexRecordView["status"];
  statusText?: string;
  statusDurationMs?: number;
}) => (
  <ToolPreview title="Updated Plan" status={status} statusText={statusText} statusDurationMs={statusDurationMs} className="updatePlanPreview" icon={Workflow}>
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
  status,
  statusText,
  statusDurationMs
}: {
  args: Record<string, unknown>;
  status?: CodexRecordView["status"];
  statusText?: string;
  statusDurationMs?: number;
}) => {
  const command = typeof args.cmd === "string" ? formatCommandBlock(args.cmd) : "<missing>";
  return (
    <ToolPreview title="tool: exec_command" status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={toolPreviewMeta(args)} icon={Terminal}>
      <pre className="toolCommandLine">{command.includes("\n") ? command : `$ ${command}`}</pre>
    </ToolPreview>
  );
};

export const WriteStdinToolPreview = ({
  args,
  status,
  statusText,
  statusDurationMs
}: {
  args: Record<string, unknown>;
  status?: CodexRecordView["status"];
  statusText?: string;
  statusDurationMs?: number;
}) => (
  <ToolPreview title="tool: write_stdin" status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={toolPreviewMeta(args)} icon={Terminal}>
    <p className="toolPreviewBody">{formatWriteStdinSummary(args)}</p>
  </ToolPreview>
);

export const ToolPreview = ({
  title,
  status,
  statusText,
  statusDurationMs,
  className = "",
  meta,
  metaExtra,
  icon: Icon,
  children
}: {
  title: string;
  status?: CodexRecordView["status"];
  statusText?: string;
  statusDurationMs?: number;
  className?: string;
  meta?: string[];
  metaExtra?: React.ReactNode;
  icon?: ToolPreviewIcon;
  children: React.ReactNode;
}) => {
  const startedAt = React.useContext(StatusStartedAtContext);
  return (
    <div className={`toolPreview ${className}`.trim()}>
      <div className="toolPreviewTitle">
        <span className="toolPreviewTitleMark" aria-hidden="true">
          {Icon ? <Icon className="toolPreviewIcon" size={16} strokeWidth={2.2} /> : "•"}
        </span>
        <strong>{title}</strong>
        {status ? (
          <em className={`messageStatus ${status}`}>
            <LiveStatusLabel status={status} statusText={statusText} statusDurationMs={statusDurationMs} startedAt={startedAt} />
          </em>
        ) : null}
      </div>
      {meta?.length || metaExtra ? (
        <div className="toolPreviewMeta">
          {meta?.map((item) => <span className="toolPreviewMetaItem" key={item} title={item}>{item}</span>)}
          {metaExtra}
        </div>
      ) : null}
      {children}
    </div>
  );
};

export const FileChangePreview = ({
  payload,
  status,
  statusText,
  statusDurationMs
}: {
  payload: Record<string, unknown>;
  status?: CodexRecordView["status"];
  statusText?: string;
  statusDurationMs?: number;
}) => {
  const files = fileChangePreviewFiles(payload);
  const visibleFiles = files.slice(0, 5);
  const hiddenCount = files.length - visibleFiles.length;
  const approval = asRecord(payload.approval);
  const title = approval?.status === "pending"
    ? "File changes need approval"
    : status === "failed" ? "Patch failed" : "Files changed";
  return (
    <ToolPreview title={title} status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)} className="fileChangePreview" icon={FileDiff}>
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
  status,
  statusText,
  statusDurationMs
}: {
  args: Record<string, unknown>;
  status?: CodexRecordView["status"];
  statusText?: string;
  statusDurationMs?: number;
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
      statusText={statusText}
      statusDurationMs={statusDurationMs}
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
    render: (args, status, statusText, statusDurationMs) => <CommandToolPreview args={args} status={status} statusText={statusText} statusDurationMs={statusDurationMs} />,
    inspect: (args, output) => ({
      ...formatToolInput("exec_command", args),
      ...formatRawToolOutput(output)
    })
  },
  update_plan: {
    render: (args, status, statusText, statusDurationMs) => {
      const plan = parseUpdatePlanArguments(args);
      return plan ? <UpdatePlanPreview plan={plan} status={status} statusText={statusText} statusDurationMs={statusDurationMs} /> : null;
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
    render: (args, status, statusText, statusDurationMs) => <WriteStdinToolPreview args={args} status={status} statusText={statusText} statusDurationMs={statusDurationMs} />,
    inspect: (args, output) => ({
      ...formatToolInput("write_stdin", args),
      ...formatRawToolOutput(output)
    })
  },
  apply_patch: {
    render: (args, status, statusText, statusDurationMs) => <ApplyPatchPreview args={args} status={status} statusText={statusText} statusDurationMs={statusDurationMs} />,
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

export const renderToolMessageBody = (message: WebRecordView, status?: CodexRecordView["status"], statusText?: string) => {
  const toolCall = parseToolCallMessage(message);
  if (toolCall) return webToolPresenters[toolCall.name]?.render?.(toolCall.args, status, statusText, message.statusDurationMs) ?? (
    <FunctionCallPreview message={message} toolCall={toolCall} status={status} statusText={statusText} statusDurationMs={message.statusDurationMs} />
  );
  return renderAppServerToolPreview(message, status, statusText, message.statusDurationMs);
};

export const FunctionCallPreview = ({
  message,
  toolCall,
  status,
  statusText,
  statusDurationMs
}: {
  message: WebRecordView;
  toolCall: ParsedToolCall;
  status?: CodexRecordView["status"];
  statusText?: string;
  statusDurationMs?: number;
}) => {
  const payload = asRecord(message.record.payload) ?? {};
  const namespace = typeof payload.namespace === "string" && payload.namespace ? payload.namespace : "";
  const title = `tool: ${[namespace, toolCall.name].filter(Boolean).join(".") || toolCall.name}`;
  return (
    <ToolPreview title={title} status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)} icon={Workflow}>
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

type AppServerToolPresenter = {
  render?: (
    message: WebRecordView,
    payload: Record<string, unknown>,
    status?: CodexRecordView["status"],
    statusText?: string,
    statusDurationMs?: number
  ) => React.ReactNode;
  inspect?: (message: WebRecordView, payload: Record<string, unknown>) => InspectDetail;
};

const appServerToolPresenters: Record<string, AppServerToolPresenter> = {
  local_shell_call: {
    render: (_message, payload, status, statusText, statusDurationMs) => {
      const command = shellCommandDisplay(payload);
      return (
        <ToolPreview
          title="tool: shell"
          status={status}
          statusText={statusText}
          statusDurationMs={statusDurationMs}
          meta={appServerToolMeta(payload)}
          metaExtra={command.wrapper ? (
            <Tag className="shellCommandWrapperTag" title={command.raw}>
              {command.wrapper}
            </Tag>
          ) : null}
          icon={Terminal}
        >
          <ShellCommandPreview command={command} />
        </ToolPreview>
      );
    },
    inspect: (_message, payload) => {
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
  },
  file_change: {
    render: (_message, payload, status, statusText, statusDurationMs) => (
      <FileChangePreview payload={payload} status={status} statusText={statusText} statusDurationMs={statusDurationMs} />
    ),
    inspect: (_message, payload) => {
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
  },
  web_search_call: {
    render: (message, payload, status, statusText, statusDurationMs) => (
      <ToolPreview title="tool: web_search" status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)} icon={Search}>
        <p className="toolPreviewBody">{typeof payload.query === "string" && payload.query ? payload.query : message.text}</p>
      </ToolPreview>
    ),
    inspect: (_message, payload) => ({
      inputMeta: appServerInspectMeta("tool: web_search", payload),
      inputBlockLabel: "Query",
      inputBlock: typeof payload.query === "string" && payload.query ? payload.query : "<empty>",
      outputMeta: appServerOutputMeta(payload),
      outputBlockLabel: "Action",
      outputBlock: payload.action == null ? undefined : formatJsonBlock(payload.action)
    })
  },
  mcp_tool_call: {
    render: (_message, payload, status, statusText, statusDurationMs) => (
      <ToolPreview title={`tool: ${mcpToolPreviewName(payload)}`} status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)} icon={Plug}>
        <p className="toolPreviewBody">{formatToolArgumentsPreview(payload.arguments)}</p>
      </ToolPreview>
    ),
    inspect: (_message, payload) => inspectRequestResult(
      `tool: ${mcpToolPreviewName(payload)}`,
      "Arguments",
      payload.arguments ?? {},
      "Result",
      payload,
      payload.result
    )
  },
  permission_request: {
    render: (_message, payload, status, statusText, statusDurationMs) => (
      <ToolPreview title="tool: permission_request" status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)} icon={ShieldCheck}>
        <p className="toolPreviewBody">{permissionRequestPreview(payload)}</p>
      </ToolPreview>
    ),
    inspect: (_message, payload) => inspectRequestResult(
      "tool: permission_request",
      "Permissions",
      payload.permissions ?? {},
      "Result",
      payload,
      payload.result
    )
  },
  user_input_request: {
    render: (_message, payload, status, statusText, statusDurationMs) => (
      <ToolPreview title="tool: request_user_input" status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)} icon={MessageSquareText}>
        <p className="toolPreviewBody">{userInputRequestPreview(payload)}</p>
      </ToolPreview>
    ),
    inspect: (_message, payload) => inspectRequestResult(
      "tool: request_user_input",
      "Questions",
      payload.questions ?? [],
      "Response",
      payload,
      payload.response
    )
  },
  collab_agent_tool_call: {
    render: (_message, payload, status, statusText, statusDurationMs) => (
      <ToolPreview title={`tool: ${collabAgentToolPreviewName(payload)}`} status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)} icon={Users}>
        <p className="toolPreviewBody">{collabAgentToolInputPreview(payload)}</p>
      </ToolPreview>
    ),
    inspect: (_message, payload) => ({
      inputMeta: appServerInspectMeta(`tool: ${collabAgentToolPreviewName(payload)}`, payload),
      inputBlockLabel: "Prompt",
      inputBlock: typeof payload.prompt === "string" && payload.prompt.trim() ? payload.prompt : "<empty>",
      outputMeta: appServerOutputMeta(payload),
      outputBlockLabel: "Agent State",
      outputBlock: payload.agents_states == null ? undefined : formatJsonBlock(payload.agents_states)
    })
  },
  image_view: {
    render: (message, payload, status, statusText, statusDurationMs) => (
      <ToolPreview title="tool: image_view" status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)} icon={Image}>
        <p className="toolPreviewBody">{typeof payload.path === "string" && payload.path ? payload.path : message.text}</p>
      </ToolPreview>
    ),
    inspect: (_message, payload) => ({
      inputMeta: appServerInspectMeta("tool: image_view", payload),
      inputBlockLabel: "Path",
      inputBlock: typeof payload.path === "string" && payload.path ? payload.path : "<empty>",
      outputMeta: "Image opened"
    })
  },
  image_generation_call: {
    render: (_message, payload, status, statusText, statusDurationMs) => (
      <ToolPreview title="tool: image_generation" status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)} icon={Sparkles}>
        <p className="toolPreviewBody">{imageGenerationInputPreview(payload)}</p>
      </ToolPreview>
    ),
    inspect: (_message, payload) => ({
      inputMeta: appServerInspectMeta("tool: image_generation", payload),
      inputBlockLabel: "Prompt",
      inputBlock: imageGenerationInputPreview(payload),
      outputMeta: imageGenerationOutputMeta(payload),
      outputBlockLabel: "Result",
      outputBlock: imageGenerationOutputBlock(payload)
    })
  },
  function_call_output: {
    render: (message, payload, status, statusText, statusDurationMs) => (
      <ToolPreview title="tool result" status={status} statusText={statusText} statusDurationMs={statusDurationMs} meta={appServerToolMeta(payload)}>
        <p className="toolPreviewBody">{message.text || "Completed"}</p>
      </ToolPreview>
    )
  },
  function_call: {
    inspect: (message, payload) => {
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
  }
};

const inspectRequestResult = (
  title: string,
  inputBlockLabel: string,
  input: unknown,
  outputBlockLabel: string,
  payload: Record<string, unknown>,
  output: unknown
): InspectDetail => {
  const error = asRecord(payload.error);
  const errorMessage = typeof error?.message === "string" ? error.message : null;
  return {
    inputMeta: appServerInspectMeta(title, payload),
    inputBlockLabel,
    inputBlock: formatJsonBlock(input),
    outputMeta: errorMessage ?? appServerOutputMeta(payload),
    outputBlockLabel: errorMessage ? "Error" : outputBlockLabel,
    outputBlock: output == null ? undefined : formatJsonBlock(output)
  };
};

export const renderAppServerToolPreview = (
  message: WebRecordView,
  status?: CodexRecordView["status"],
  statusText?: string,
  statusDurationMs?: number
) => {
  if (message.role !== "tool") return null;
  const payload = asRecord(message.record.payload);
  if (!payload) return null;
  const type = typeof payload.type === "string" ? payload.type : "";
  return appServerToolPresenters[type]?.render?.(message, payload, status, statusText, statusDurationMs) ?? null;
};

const formatAppServerInspectDetail = (
  message: WebRecordView,
  payload: Record<string, unknown>
): InspectDetail | null => {
  const type = typeof payload.type === "string" ? payload.type : "";
  return appServerToolPresenters[type]?.inspect?.(message, payload) ?? null;
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
  appServerStatusMeta(payload),
  typeof payload.exit_code === "number" ? `exit ${payload.exit_code}` : null,
  typeof payload.namespace === "string" ? `ns ${payload.namespace}` : null,
  typeof payload.tool === "string" ? payload.tool : null,
  typeof payload.call_id === "string" ? payload.call_id : null,
  Array.isArray(payload.changes) ? `${payload.changes.length} files` : null,
  Array.isArray(payload.questions) ? `${payload.questions.length} questions` : null,
  Array.isArray(payload.receiver_thread_ids) ? `${payload.receiver_thread_ids.length} agents` : null,
  typeof payload.path === "string" ? payload.path : null
].filter((item): item is string => Boolean(item));

const appServerInspectMeta = (title: string, payload: Record<string, unknown>) => [
  title,
  appServerStatusMeta(payload, "status: "),
  typeof payload.exit_code === "number" ? `exit: ${payload.exit_code}` : null,
  typeof payload.success === "boolean" ? `success: ${payload.success}` : null,
  typeof payload.call_id === "string" ? `call_id: ${payload.call_id}` : null,
  typeof payload.namespace === "string" ? `namespace: ${payload.namespace}` : null,
  typeof payload.path === "string" ? `path: ${payload.path}` : null
].filter((line): line is string => Boolean(line)).join("\n");

const appServerOutputMeta = (payload: Record<string, unknown>) => [
  appServerStatusMeta(payload, "status: "),
  typeof payload.exit_code === "number" ? `exit: ${payload.exit_code}` : null,
  typeof payload.success === "boolean" ? `success: ${payload.success}` : null
].filter((line): line is string => Boolean(line)).join("\n") || undefined;

const appServerStatusMeta = (payload: Record<string, unknown>, prefix = "") => {
  if (payload.type === "local_shell_call" && typeof payload.exit_code === "number") return null;
  return typeof payload.status === "string" ? `${prefix}${payload.status}` : null;
};

const ShellCommandPreview = ({ command }: { command: ShellCommandDisplay }) => {
  const tokens = shellCommandHighlightTokens(command.display);
  const pendingCommand = !command.display;
  return (
    <div className={`shellCommandPreview ${pendingCommand ? "pendingCommand" : ""}`.trim()}>
      <pre className={`toolCommandLine shellCommandDisplayLine ${pendingCommand ? "pendingCommand" : ""}`.trim()} aria-label={shellCommandPreviewLine(command.display)}>
        <span className="shellToken shellPrompt">$</span>
        <span className="shellToken shellSpace"> </span>
        {tokens.length ? tokens.map((token, index) => (
          <span className={`shellToken ${token.kind}`} key={`${index}:${token.kind}:${token.text}`}>
            {token.text}
          </span>
        )) : <span className="shellToken shellPlaceholder">&lt;empty&gt;</span>}
      </pre>
    </div>
  );
};

const shellCommandPreviewLine = (command: string) => command ? `$ ${command}` : "$ <empty>";

type ShellHighlightToken = {
  text: string;
  kind: string;
};

type ShellScannedToken = {
  text: string;
  kind: "word" | "space" | "operator" | "string";
};

const shellCommandHighlightTokens = (command: string): ShellHighlightToken[] => {
  const scanned = scanShellCommand(command);
  const highlighted: ShellHighlightToken[] = [];
  let expectingCommand = true;

  for (const token of scanned) {
    if (token.kind === "space") {
      highlighted.push({ text: token.text, kind: "shellSpace" });
      continue;
    }
    if (token.kind === "operator") {
      highlighted.push({ text: token.text, kind: "operator" });
      expectingCommand = isCommandSeparator(token.text);
      continue;
    }
    if (token.kind === "string") {
      highlighted.push({ text: token.text, kind: "string" });
      expectingCommand = false;
      continue;
    }

    if (expectingCommand) {
      const envAssignment = splitEnvAssignment(token.text);
      if (envAssignment) {
        highlighted.push({ text: envAssignment.key, kind: "envKey" });
        highlighted.push({ text: "=", kind: "operator" });
        if (envAssignment.value) highlighted.push({ text: envAssignment.value, kind: "envValue" });
        continue;
      }
      highlighted.push({ text: token.text, kind: "command" });
      expectingCommand = false;
      continue;
    }

    highlighted.push(...highlightShellArgument(token.text));
  }

  return highlighted;
};

const scanShellCommand = (command: string): ShellScannedToken[] => {
  const tokens: ShellScannedToken[] = [];
  for (let index = 0; index < command.length;) {
    const char = command[index];
    if (/\s/.test(char)) {
      const start = index;
      while (index < command.length && /\s/.test(command[index])) index += 1;
      tokens.push({ text: command.slice(start, index), kind: "space" });
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      const start = index;
      index = scanQuotedShellString(command, index);
      tokens.push({ text: command.slice(start, index), kind: "string" });
      continue;
    }
    const operator = shellOperatorAt(command, index);
    if (operator) {
      tokens.push({ text: operator, kind: "operator" });
      index += operator.length;
      continue;
    }
    const start = index;
    while (index < command.length && !/\s/.test(command[index]) && command[index] !== "'" && command[index] !== "\"" && command[index] !== "`" && !shellOperatorAt(command, index)) {
      index += 1;
    }
    tokens.push({ text: command.slice(start, index), kind: "word" });
  }
  return tokens;
};

const scanQuotedShellString = (command: string, start: number) => {
  const quote = command[start];
  let index = start + 1;
  while (index < command.length) {
    if (command[index] === "\\" && quote !== "'") {
      index += 2;
      continue;
    }
    if (command[index] === quote) return index + 1;
    index += 1;
  }
  return index;
};

const shellOperatorAt = (command: string, index: number) => {
  const candidates = ["2>>", "1>>", "&&", "||", ">>", "<<", "2>", "1>", "|", ";", "(", ")", "<", ">"];
  return candidates.find((operator) => command.startsWith(operator, index)) ?? null;
};

const isCommandSeparator = (operator: string) => operator === "&&" || operator === "||" || operator === "|" || operator === ";" || operator === "(";

const splitEnvAssignment = (word: string) => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
  return match ? { key: match[1], value: match[2] } : null;
};

const highlightShellArgument = (word: string): ShellHighlightToken[] => {
  const flag = splitFlagAssignment(word);
  if (flag) {
    return [
      { text: flag.key, kind: "parameter" },
      { text: "=", kind: "operator" },
      { text: flag.value, kind: classifyShellValue(flag.value) }
    ];
  }
  if (/^--?[\w-]+$/.test(word)) return [{ text: word, kind: "parameter" }];
  return [{ text: word, kind: classifyShellValue(word) }];
};

const splitFlagAssignment = (word: string) => {
  const match = /^(--?[\w-]+)=(.+)$/.exec(word);
  return match ? { key: match[1], value: match[2] } : null;
};

const classifyShellValue = (word: string) => {
  if (/^https?:\/\//.test(word)) return "url";
  if (/^(?:~|\.{1,2}|\/|[a-zA-Z]:[\\/]|\\\\)/.test(word)) return "path";
  if (/^-?\d+(?:\.\d+)?$/.test(word)) return "number";
  return "plain";
};

const shellCommandDisplay = (payload: Record<string, unknown>) => {
  const raw = shellCommandText(payload);
  const parts = shellCommandParts(payload);
  const unwrapped = unwrapShellInvocation(parts, raw);
  return {
    raw,
    display: unwrapped?.command ?? raw,
    wrapper: unwrapped?.wrapper
  };
};

const shellCommandText = (payload: Record<string, unknown>) => {
  const commandValue = shellCommandValue(payload);
  if (Array.isArray(commandValue)) return commandValue.filter((part): part is string => typeof part === "string").join(" ");
  return typeof commandValue === "string" ? commandValue : "";
};

const shellCommandParts = (payload: Record<string, unknown>) => {
  const commandValue = shellCommandValue(payload);
  return Array.isArray(commandValue) ? commandValue.filter((part): part is string => typeof part === "string") : null;
};

const shellCommandValue = (payload: Record<string, unknown>) => {
  const action = asRecord(payload.action);
  return action?.command ?? payload.command ?? payload.cmd;
};

const unwrapShellInvocation = (parts: string[] | null, raw: string) => {
  const fromParts = unwrapShellParts(parts);
  if (fromParts) return fromParts;
  return unwrapShellString(raw);
};

const unwrapShellParts = (parts: string[] | null) => {
  if (!parts || parts.length < 3) return null;
  const [shellPath] = parts;
  const shellKind = shellExecutableKind(shellPath);
  if (!shellKind) return null;
  const flagIndex = parts.findIndex((part, index) => index > 0 && isShellCommandFlag(part, shellKind));
  if (flagIndex === -1) return null;
  const command = parts.slice(flagIndex + 1).join(" ").trim();
  if (!command) return null;
  return {
    command,
    wrapper: parts.slice(0, flagIndex + 1).join(" ")
  };
};

const unwrapShellString = (raw: string) => {
  const trimmed = raw.trim();
  const shell = readLeadingShellToken(trimmed);
  if (!shell) return null;
  const shellKind = shellExecutableKind(shell.value);
  if (!shellKind) return null;
  const wrapperTokens = [shell.raw];
  let rest = shell.rest.trimStart();
  while (rest) {
    const token = readLeadingShellToken(rest);
    if (!token) return null;
    wrapperTokens.push(token.raw);
    if (isShellCommandFlag(token.value, shellKind)) {
      const commandText = token.rest.trim();
      if (!commandText) return null;
      return {
        command: stripMatchingOuterQuotes(commandText),
        wrapper: wrapperTokens.join(" ")
      };
    }
    rest = token.rest.trimStart();
  }
  return null;
};

const readLeadingShellToken = (value: string) => {
  const trimmed = value.trimStart();
  if (!trimmed) return null;
  const quote = trimmed[0] === "\"" || trimmed[0] === "'" ? trimmed[0] : "";
  if (quote) {
    const end = trimmed.indexOf(quote, 1);
    if (end === -1) return null;
    return {
      raw: trimmed.slice(0, end + 1),
      value: trimmed.slice(1, end),
      rest: trimmed.slice(end + 1)
    };
  }
  const match = /^(\S+)([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  return {
    raw: match[1],
    value: match[1],
    rest: match[2]
  };
};

const shellExecutableKind = (value: string): ShellKind | null => {
  const executable = value
    .trim()
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/, "");
  if (!executable) return null;
  if (["bash", "zsh", "sh", "dash", "fish"].includes(executable)) return "posix";
  if (["powershell", "pwsh"].includes(executable)) return "powershell";
  if (executable === "cmd") return "cmd";
  return null;
};

const isShellCommandFlag = (value: string, shellKind: ShellKind) => {
  const normalized = value.trim().toLowerCase();
  if (shellKind === "posix") return normalized.startsWith("-") && normalized.includes("c");
  if (shellKind === "powershell") return normalized === "-command" || normalized === "-c";
  return normalized === "/c" || normalized === "-c" || normalized === "/k" || normalized === "-k";
};

const stripMatchingOuterQuotes = (value: string) => {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === "'" || first === "\"") && first === last ? value.slice(1, -1) : value;
};

const formatToolArgumentsPreview = (value: unknown) => {
  if (value == null) return "No arguments";
  const preview = compactJsonPreview(value);
  return preview ? `args: ${preview}` : "No arguments";
};

const permissionRequestPreview = (payload: Record<string, unknown>) => [
  typeof payload.reason === "string" && payload.reason.trim() ? compactTextPreview(payload.reason) : null,
  typeof payload.cwd === "string" && payload.cwd ? `cwd: ${payload.cwd}` : null,
  compactJsonPreview(payload.permissions ?? {})
].filter(Boolean).join("\n") || "Permission request";

const userInputRequestPreview = (payload: Record<string, unknown>) => {
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  if (!questions.length) return "User input requested";
  return questions.map((question, index) => {
    const record = asRecord(question);
    const header = typeof record?.header === "string" && record.header.trim() ? record.header.trim() : `Question ${index + 1}`;
    const text = typeof record?.question === "string" && record.question.trim() ? record.question.trim() : "";
    return text ? `${header}: ${compactTextPreview(text)}` : header;
  }).join("\n");
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

export { formatWriteStdinChars, formatWriteStdinSummary } from "../../shared/toolFormatting.js";

export const describeWriteStdinAction = (args: Record<string, unknown>) => {
  const chars = typeof args.chars === "string" ? args.chars : "";
  if (!chars) return "poll";
  if (chars === "\u0003") return "send Ctrl-C";
  if (chars === "\n") return "send Enter";
  if (chars.length <= 48) return `send ${JSON.stringify(chars)}`;
  return `send ${chars.length} chars`;
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

const stringifyInspectJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};
