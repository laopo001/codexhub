import type {
  AppSettings,
  ApprovalsReviewerSelection,
  ComposerMode,
} from "./types.js";
import { defaultPetId } from "../shared/petTypes.js";
import { isCodexHubSurface, isEmbeddedCodexHubSurface } from "../shared/surfaceTypes.js";
import { codexHubSearchParams } from "./urlSearch.js";

const searchParams = codexHubSearchParams(
  typeof window === "undefined" ? "" : window.location.search
);
const uniqueTrimmedParams = (names: string[]) => {
  const values = names.flatMap((name) => searchParams.getAll(name));
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
};

const requestedSurface = searchParams.get("surface");
export const webSurface = isCodexHubSurface(requestedSurface) ? requestedSurface : "default";
export const isVscodeSurface = webSurface === "vscode";
export const isElectronSurface = webSurface === "electron";
export const isNativeElectronSurface =
  isElectronSurface && typeof window !== "undefined" && Boolean(window.codexhubElectronPet);
export const isElectronDesktopPetWindow = isNativeElectronSurface && searchParams.get("desktopPet") === "1";
export const isEmbeddedHostSurface = isEmbeddedCodexHubSurface(webSurface);
/** VS Code projects come from the host workspace; Electron can browse local folders. */
export const isFixedWorkspaceSurface = isEmbeddedHostSurface && !isElectronSurface;
export const embeddedSurfaceId = searchParams.get("surfaceId")?.trim() ?? "";
export const embeddedStateScope = searchParams.get("stateScope")?.trim() ?? embeddedSurfaceId;
export const initialWorkspacePath = searchParams.get("workspacePath")?.trim() ?? "";
export const embeddedWorkspacePaths = uniqueTrimmedParams(["workspaceFolder", "workspacePath"]);
export const storageKey = isVscodeSurface
  ? `codexhub-ui-state-vscode-v3${embeddedStateScope ? `:${encodeURIComponent(embeddedStateScope)}` : ""}`
  : isElectronSurface
    ? `codexhub-ui-state-electron-v1${embeddedStateScope ? `:${encodeURIComponent(embeddedStateScope)}` : ""}`
    : "codexhub-ui-state-v6";
export const defaultAppSettings = (): AppSettings => ({
  selectedPetId: defaultPetId,
  showFloatingPet: false,
  showDesktopPet: false,
  taskCompleteSystemNotifications: false,
  taskCompleteNotificationPersistAfterMinutes: 3
});
export type ApprovalPolicyOptionValue = "untrusted" | "on-request" | "never" | "granular";

export const approvalPolicyOptions: Array<{ value: ApprovalPolicyOptionValue; label: string }> = [
  { value: "untrusted", label: "Untrusted" },
  { value: "on-request", label: "On request" },
  { value: "never", label: "Never" },
  { value: "granular", label: "Granular" }
];
export const approvalsReviewerOptions: Array<{ value: ApprovalsReviewerSelection; label: string }> = [
  { value: "user", label: "Ask me" },
  { value: "auto_review", label: "Auto review" }
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
