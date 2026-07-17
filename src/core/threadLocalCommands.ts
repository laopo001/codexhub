import {
  emptyThreadUsage,
  fiveHourRateLimitWindowMinutes,
  rateLimitUsageForWindowMinutes,
  sevenDayRateLimitWindowMinutes
} from "./threadUsage.js";
import type { ThreadState } from "./threadHubState.js";
import { asRecord } from "../shared/recordTypes.js";
import type { ProxyInput } from "../shared/inputTypes.js";
import type { ThreadSessionSummary } from "../shared/threadTypes.js";
import type { ThreadOptions, ThreadRateLimits, ThreadRateLimitUsage, ThreadUsage, Usage } from "../shared/usageTypes.js";

export const parseLocalSlashCommand = (input: ProxyInput) => {
  if (typeof input !== "string") return null;
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.*)|$)/.exec(input.trim());
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: (match[2] ?? "").trim().split(/\s+/).filter(Boolean)
  };
};

export const localCommandMessage = (
  thread: ThreadState,
  session: ThreadSessionSummary,
  accountRateLimits: ThreadRateLimits | null,
  command: string,
  args: string[]
) => {
  if (command === "status") return threadStatusMessage(thread, session, accountRateLimits);
  if (command === "help") return slashHelpMessage();
  if (command === "model") return modelCommandMessage(thread);
  if (command === "fast") return fastCommandMessage(thread, args);
  return [
    `Unsupported slash command: /${command}`,
    "",
    "Codex slash commands are local UI commands. codexhub handles only the supported commands listed below and does not forward unsupported slash commands as user turns.",
    slashHelpMessage()
  ].join("\n");
};

const threadStatusMessage = (
  thread: ThreadState,
  session: ThreadSessionSummary,
  accountRateLimits: ThreadRateLimits | null
) => [
  "## Codex Hub Status",
  "",
  "**Thread**",
  `- ID: ${markdownCode(thread.threadId)}`,
  `- Folder: ${markdownCode(thread.workingDirectory)}`,
  `- State: ${markdownCode(thread.running ? "running" : "idle")}`,
  `- Records: ${thread.records.length}`,
  `- Updated: ${markdownCode(thread.updatedAt)}`,
  "",
  "**Runtime**",
  `- Session: ${markdownCode(formatSession(session))}`,
  `- Model: ${markdownCode(formatModel(thread.threadOptions))}`,
  `- Reasoning: ${markdownCode(thread.threadOptions.modelReasoningEffort ?? "auto")}`,
  `- Service tier: ${markdownCode(formatServiceTier(thread.threadOptions))}`,
  "",
  "**Policy**",
  `- Approval: ${markdownCode(formatApprovalPolicy(thread.threadOptions))}`,
  `- Sandbox: ${markdownCode(formatSandboxPolicy(thread.threadOptions))}`,
  "",
  "**Usage**",
  ...formatStatusUsage(thread, accountRateLimits)
].join("\n");

const modelCommandMessage = (thread: ThreadState) => [
  "Model control",
  `current model: ${formatModel(thread.threadOptions)}`,
  `current reasoning: ${thread.threadOptions.modelReasoningEffort ?? "auto"}`,
  `current service tier: ${formatServiceTier(thread.threadOptions)}`,
  "",
  "In Web, use the Model selector. The selected model and reasoning are sent with the next Web turn.",
  "For API, Telegram, task, and session turns, pass model options with the next turn request."
].join("\n");

const fastCommandMessage = (thread: ThreadState, args: string[]) => {
  const action = (args[0] ?? "status").toLowerCase();
  if (action === "status") {
    return [
      "Fast mode",
      `current service tier: ${formatServiceTier(thread.threadOptions)}`,
      "",
      "Use /fast on to request the app-server Fast service tier for subsequent turns.",
      "Use /fast off to clear the explicit service tier and return to the configured default."
    ].join("\n");
  }
  if (action === "on") {
    thread.threadOptions = { ...thread.threadOptions, serviceTier: "priority" };
    return [
      "Fast mode enabled",
      "service tier: priority",
      "",
      "Subsequent turns on this thread will request the app-server Fast service tier."
    ].join("\n");
  }
  if (action === "off") {
    thread.threadOptions = { ...thread.threadOptions };
    delete thread.threadOptions.serviceTier;
    return [
      "Fast mode disabled",
      "service tier: auto",
      "",
      "Subsequent turns on this thread will use the configured default service tier."
    ].join("\n");
  }
  return [`Unsupported /fast argument: ${action}`, "", "Usage: /fast on | /fast off | /fast status"].join("\n");
};

const slashHelpMessage = () => [
  "Supported codexhub slash commands:",
  "/status - show this thread session status",
  "/model - explain model control",
  "/fast on|off|status - toggle or inspect app-server Fast service tier",
  "/help - show supported proxy commands"
].join("\n");

const formatModel = (options: ThreadOptions) => options.model ?? "auto";
const formatServiceTier = (options: ThreadOptions) => options.serviceTier ?? "auto";
const formatApprovalPolicy = (options: ThreadOptions) => options.approvalPolicy ?? "auto";

const formatSandboxPolicy = (options: ThreadOptions) => {
  const policy = options.sandboxPolicy;
  if (!policy) return "auto";
  if (policy.type === "dangerFullAccess") return "danger-full-access";
  if (policy.type === "readOnly") return `read-only${policy.networkAccess ? " + network" : ""}`;
  if (policy.type === "workspaceWrite") return `workspace-write${policy.networkAccess ? " + network" : ""}`;
  return `external-sandbox:${policy.networkAccess}`;
};

const formatSession = (summary: ThreadSessionSummary) => {
  const state = summary.runnable ? "runnable" : summary.online ? "online" : "offline";
  const session = summary.sessionId ? ` session:${summary.name ?? summary.sessionId.slice(0, 8)}` : "";
  return `${state}${session}`;
};

const formatStatusUsage = (thread: ThreadState, accountRateLimits: ThreadRateLimits | null) => {
  const usage = thread.threadUsage ?? emptyThreadUsage();
  const fiveHour = rateLimitUsageForWindowMinutes(usage, fiveHourRateLimitWindowMinutes)
    ?? rateLimitUsageForWindowMinutes(accountRateLimits, fiveHourRateLimitWindowMinutes);
  const sevenDay = rateLimitUsageForWindowMinutes(usage, sevenDayRateLimitWindowMinutes)
    ?? rateLimitUsageForWindowMinutes(accountRateLimits, sevenDayRateLimitWindowMinutes);
  const observedAt = usage.observedAt ?? accountRateLimits?.observedAt ?? null;
  return [
    `- Tokens: ${markdownCode(formatUsage(thread.lastUsage))}`,
    `- Context: ${markdownCode(formatContextUsage(usage))}`,
    `- 5h limit: ${markdownCode(formatRateLimitUsage(fiveHour))}`,
    `- 7d limit: ${markdownCode(formatRateLimitUsage(sevenDay))}`,
    `- Observed: ${markdownCode(observedAt ?? "n/a")}`
  ];
};

const formatUsage = (usage: Usage | undefined) => {
  const record = asRecord(usage);
  if (!record) return "n/a";
  const total = numberValue(record.total_tokens);
  const input = numberValue(record.input_tokens);
  const cached = numberValue(record.cached_input_tokens);
  const output = numberValue(record.output_tokens);
  const reasoning = numberValue(record.reasoning_output_tokens);
  if (total == null && input == null && cached == null && output == null && reasoning == null) return "n/a";
  return [
    total == null ? null : `total=${total}`,
    input == null ? null : `input=${input}`,
    cached == null ? null : `cached_input=${cached}`,
    output == null ? null : `output=${output}`,
    reasoning == null ? null : `reasoning_output=${reasoning}`
  ].filter(Boolean).join(", ");
};

const formatContextUsage = (usage: ThreadUsage) => {
  const context = usage.context;
  if (!context) return "n/a";
  const usedPercent = context.windowTokens > 0 ? (context.usedTokens / context.windowTokens) * 100 : 0;
  return [
    `${context.usedTokens}/${context.windowTokens} tokens`,
    `${formatPercent(usedPercent)} used`,
    `${Math.max(0, context.windowTokens - context.usedTokens)} remaining`
  ].join(", ");
};

const formatRateLimitUsage = (usage: ThreadRateLimitUsage | null) => usage
  ? [
    `${formatPercent(usage.usedPercent)} used`,
    `${formatPercent(Math.max(0, 100 - usage.usedPercent))} remaining`,
    ...(usage.windowMinutes === null ? [] : [`${usage.windowMinutes}m window`]),
    `resets ${formatRateLimitReset(usage.resetsAt)}`
  ].join(", ")
  : "n/a";

const formatRateLimitReset = (value: number | null) => {
  if (value === null) return "n/a";
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : "n/a";
};

const formatPercent = (value: number) => Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
const numberValue = (value: unknown) => typeof value === "number" ? value : undefined;

const markdownCode = (value: string) => {
  const longestBacktickRun = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longestBacktickRun + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
};
