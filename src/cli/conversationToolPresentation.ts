import { asRecord, type CodexRecordView } from "../shared/recordTypes.js";
import { parseJsonObject, payloadDurationMs, formatMilliseconds, formatWriteStdinSummary } from "../shared/toolFormatting.js";

type Fields = Record<string, unknown>;
const sensitive = /(?:token|password|passwd|secret|authorization|cookie|api[_-]?key|credential)/i;
const toolCallMaxChars = 200;
const failureDiagnosticMaxChars = 400;
const failureDiagnosticMaxLines = 3;
const truncationNotice = " … 已截断，完整内容见 Web 工具详情";

const sanitizeText = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/(--[\w-]*(?:token|password|passwd|secret|api[_-]?key|credential)[\w-]*\s+)("[^"]*"|'[^']*'|[^\s;]+)/gi, "$1[REDACTED]")
  .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
  .replace(/((?:["']?[\w-]*(?:token|password|passwd|secret|api[_-]?key|credential)[\w-]*["']?|["']?(?:authorization|cookie)["']?)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[REDACTED]")
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

const boundedText = (value: string, maxChars: number, maxLines: number, collapseWhitespace = false) => {
  const clean = sanitizeText(value);
  const normalized = collapseWhitespace ? clean.replace(/\s+/g, " ").trim() : clean;
  const lineLimited = normalized.split("\n").slice(0, maxLines).join("\n");
  if (lineLimited === normalized && lineLimited.length <= maxChars) return lineLimited;
  const contentMaxChars = Math.max(0, maxChars - truncationNotice.length);
  return `${lineLimited.slice(0, contentMaxChars)}${truncationNotice}`;
};

const compactToolCall = (name: string, parameters: string) => {
  const content = `${name}${parameters ? ` · ${parameters}` : ""}`;
  return boundedText(content, toolCallMaxChars, 1, true);
};

// CLI summaries are bounded; full details remain in the Web inspector.
export const toolSummaryText = (value: string, maxChars = 1000, maxLines = 8) =>
  boundedText(value, maxChars, maxLines);

const redactFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactFields);
  const object = asRecord(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, sensitive.test(k) ? "[REDACTED]" : redactFields(v)]));
};
const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(redactFields(value)) ?? "";
const objectFrom = (value: unknown): Fields => typeof value === "string" ? parseJsonObject(value) ?? {} : asRecord(value) ?? {};

export const toolPresentation = (view: CodexRecordView) => {
  const p = asRecord(view.record.payload) ?? {};
  const type = String(p.type ?? "tool");
  const outputOnly = type.endsWith("_output");
  const interactiveRequest = type === "permission_request" || type === "user_input_request";
  const args = objectFrom(p.arguments);
  const action = objectFrom(p.action);
  const name = type === "local_shell_call" ? "exec_command"
    : type === "mcp_tool_call" ? [p.server, p.tool].filter(Boolean).join(".") || "mcp"
    : type === "function_call" || outputOnly ? [p.namespace, p.name].filter(Boolean).join(".") || "tool"
    : type === "file_change" ? "apply_patch"
    : type === "collab_agent_tool_call" ? String(p.tool ?? "agent")
    : String(p.name ?? p.tool ?? type);
  const callId = typeof p.call_id === "string" && p.call_id ? p.call_id : undefined;
  const key = callId ? `call:${callId}` : `record:${view.id}`;
  const displayId = sanitizeText(callId ?? view.id).replace(/\s+/g, " ").trim();
  let parameters: string;
  if (type === "local_shell_call") {
    const command = Array.isArray(action.command) ? action.command.map(text).join(" ") : text(action.command ?? p.command);
    const cwd = action.cwd ?? action.workdir ?? p.cwd ?? p.workdir;
    parameters = `${cwd ? `cwd: ${text(cwd)} · ` : ""}command: ${command}`;
  } else if (name.endsWith("exec_command")) {
    const cwd = args.workdir ?? args.cwd;
    parameters = `${cwd ? `cwd: ${text(cwd)} · ` : ""}command: ${text(args.cmd ?? args.command)}`;
  } else if (name.endsWith("write_stdin")) {
    parameters = formatWriteStdinSummary(redactFields(args) as Fields);
  } else if (type === "file_change") {
    parameters = (Array.isArray(p.changes) ? p.changes : []).map(item => {
      const change = asRecord(item) ?? {};
      return `${text(change.kind ?? change.type ?? "change")}: ${text(change.path)}`;
    }).join("\n");
  } else if (name.endsWith("apply_patch")) {
    const patch = text(args.patch ?? args.input ?? p.input);
    parameters = patch.split("\n").filter(line => /^\*\*\* (?:Add File|Update File|Delete File|Move to):/.test(line)).join("\n") || "patch: 内容见 Web 工具详情";
  } else if (interactiveRequest) {
    parameters = sanitizeText(view.text);
  } else if (type === "web_search_call") {
    parameters = `query: ${text(p.query ?? p.action ?? "")}`;
  } else {
    const fields = Object.keys(args).length ? args : Object.fromEntries(
      ["path", "query", "url", "method", "duration_ms", "durationMs", "input", "prompt", "receiver_thread_ids"]
        .filter(k => p[k] !== undefined).map(k => [k, p[k]]));
    const keyFields = new Set(["path", "paths", "cwd", "workdir", "query", "q", "pattern", "url", "method", "scope"]);
    parameters = Object.entries(fields).sort(([a], [b]) => Number(keyFields.has(b)) - Number(keyFields.has(a)))
      .map(([k, v]) => `${k}: ${sensitive.test(k) ? "[REDACTED]" : text(v)}`).join("\n");
  }
  const output = outputOnly ? p.output : p.error ?? p.aggregated_output ?? p.result ?? p.content_items ?? p.output;
  const result = objectFrom(output);
  const exitMatch = typeof output === "string" ? output.match(/(?:Process exited with code|Exit code:)\s*(-?\d+)/i) : null;
  const exitCode = typeof p.exit_code === "number" ? p.exit_code
    : typeof result.exit_code === "number" ? result.exit_code
    : typeof result.exitCode === "number" ? result.exitCode : exitMatch ? Number(exitMatch[1]) : undefined;
  const status = String(p.status ?? "").toLowerCase();
  const failed = view.status === "failed" || /^(failed|error|errored|declined|denied|interrupted|aborted|cancelled|canceled)$/.test(status)
    || p.success === false || p.isError === true || p.error != null
    || result.isError === true || result.success === false || result.error != null || result.status === "failed"
    || exitCode !== undefined && exitCode !== 0 && exitCode !== -1;
  const dynamicResult = type === "function_call" && (typeof p.success === "boolean" || p.content_items !== undefined);
  const terminal = outputOnly || (type !== "function_call" || dynamicResult)
    && (view.status === "completed" || failed);
  const duration = view.statusDurationMs
    ?? (type === "sleep" ? payloadDurationMs(p, "elapsed_ms", "elapsedMs") : payloadDurationMs(p, "duration_ms", "durationMs"))
    ?? payloadDurationMs(result, "duration_ms", "durationMs");
  const summary = `${failed ? "✗ 失败" : "✓ 完成"}${exitCode !== undefined && exitCode !== -1 ? ` · exit ${exitCode}` : ""}${duration !== undefined ? ` · ${formatMilliseconds(duration)}` : ""}`;
  const diagnostic = failed ? toolSummaryText(text(output ?? view.text), failureDiagnosticMaxChars, failureDiagnosticMaxLines) : "";
  const displayName = boundedText(name, 120, 1, true);
  const details = interactiveRequest
    ? `${displayName}${parameters ? `\n${parameters}` : ""}`
    : compactToolCall(displayName, parameters);
  const call = `[tool_call] id: ${displayId}\n${details}`;
  return { key, name: displayName, outputOnly, call, terminal, failed,
    result: `${summary}${diagnostic ? `\n${diagnostic}` : ""}` };
};
