import type {
  AppSettings,
  ApprovalPolicySelection,
  ComposerMode,
  ModelSelection,
  ReasoningSelection,
  SandboxPolicySelection,
  ServiceTierSelection
} from "./types.js";

const searchParams = new URLSearchParams(window.location.search);
const uniqueTrimmedParams = (names: string[]) => {
  const values = names.flatMap((name) => searchParams.getAll(name));
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
};

export const webSurface = searchParams.get("surface") === "vscode" ? "vscode" : "default";
export const isVscodeSurface = webSurface === "vscode";
export const initialWorkspacePath = searchParams.get("workspacePath")?.trim() ?? "";
export const vscodeWorkspacePaths = uniqueTrimmedParams(["workspaceFolder", "workspacePath"]);
export const storageKey = isVscodeSurface ? "codexhub-ui-state-vscode-v1" : "codexhub-ui-state-v5";
export const legacyStorageKey = "codexhub-ui-state-v4";
export const defaultAppSettings = (): AppSettings => ({
  taskCompleteSystemNotifications: true
});
export const modelOptions: Array<{ value: ModelSelection; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  { value: "gpt-5.2", label: "GPT-5.2" }
];
export const reasoningOptions: Array<{ value: ReasoningSelection; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" }
];
export const serviceTierOptions: Array<{ value: ServiceTierSelection; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "priority", label: "Fast" }
];
export const approvalPolicyOptions: Array<{ value: ApprovalPolicySelection; label: string }> = [
  { value: "untrusted", label: "Untrusted" },
  { value: "on-failure", label: "On failure" },
  { value: "on-request", label: "On request" },
  { value: "never", label: "Never" }
];
export const sandboxPolicyOptions: Array<{ value: SandboxPolicySelection; label: string }> = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Danger full access" }
];
export const composerModeOptions: Array<{ value: ComposerMode; label: string }> = [
  { value: "chat", label: "Chat" },
  { value: "plan", label: "Plan" },
  { value: "goal", label: "Goal" }
];

export const languageAliases: Record<string, string> = {
  console: "bash",
  html: "markup",
  js: "javascript",
  md: "markdown",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  xml: "markup",
  yml: "yaml",
  zsh: "bash"
};
export const highlightedLanguages = new Set([
  "bash",
  "css",
  "diff",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "markup",
  "python",
  "sql",
  "tsx",
  "typescript",
  "yaml"
]);
