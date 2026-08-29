export type CodexHubSurface = "default" | "vscode" | "electron";
export type EmbeddedCodexHubSurface = Exclude<CodexHubSurface, "default">;
export type EmbeddedSurfaceKind = "vscode" | "electron";
export const embeddedSurfaceKinds: EmbeddedSurfaceKind[] = ["vscode", "electron"];

export type VscodeChannel = "stable" | "insiders";
export const vscodeChannels: VscodeChannel[] = ["stable", "insiders"];

export const isVscodeChannel = (value: unknown): value is VscodeChannel =>
  value === "stable" || value === "insiders";

/**
 * 从 vscode.env.uriScheme 和 appName 判定 VSCode 发布渠道。
 * uriScheme 为权威判定，appName 为受控 fallback。
 */
export const resolveVscodeChannel = (
  uriScheme?: string | null,
  appName?: string | null
): VscodeChannel | null => {
  const scheme = uriScheme?.trim().toLowerCase();
  if (scheme === "vscode-insiders") return "insiders";
  if (scheme === "vscode") return "stable";

  const app = appName?.trim().toLowerCase();
  if (app) {
    if (app.includes("insiders")) return "insiders";
    if (app.includes("code") || app.includes("visual studio code")) return "stable";
  }
  return null;
};

/** 统一的 VSCode 渠道紧凑徽标标识（如侧边栏 badge / 标签） */
export const formatVscodeChannelBadge = (channel?: VscodeChannel): string =>
  channel === "insiders" ? "Insiders" : "VS Code";

/** 统一的 VSCode surface 组名或标题前缀 */
export const formatVscodeSurfacePrefix = (channel?: VscodeChannel): string =>
  channel === "insiders" ? "VS Code Insiders" : "VS Code";

export type CodexHubAuthorityKind = "windows" | "macos" | "linux" | "wsl";

/**
 * How an embedded authority selected the Node runtime that launched it.
 * `unknown` is used by older/externally started authority services.
 */
export type AuthorityNodeSource = "configured" | "path" | "host-fallback" | "unknown";
export type AuthorityServiceSource = "configured-package" | "linked-package" | "bundled" | "unknown";

export type CodexHubAuthorityDescriptor = {
  authorityId: string;
  kind: CodexHubAuthorityKind;
  surfaceProtocolVersion: number;
};

/** Windows、macOS 和普通 Linux 上共享 authority service 的固定端口。 */
export const authorityHostServicePort = 28_788;
export const embeddedSurfaceProtocolVersion = 2;

export const isCodexHubSurface = (value: unknown): value is CodexHubSurface =>
  value === "default" || value === "vscode" || value === "electron";

export const isEmbeddedSurfaceKind = (value: unknown): value is EmbeddedSurfaceKind =>
  value === "vscode" || value === "electron";

export const isAuthorityNodeSource = (value: unknown): value is AuthorityNodeSource =>
  value === "configured" || value === "path" || value === "host-fallback" || value === "unknown";

export const isAuthorityServiceSource = (value: unknown): value is AuthorityServiceSource =>
  value === "configured-package" || value === "linked-package" || value === "bundled" || value === "unknown";

export const isEmbeddedCodexHubSurface = (
  surface: CodexHubSurface
): surface is EmbeddedCodexHubSurface => surface !== "default";

export const isWslEnvironment = (env: NodeJS.ProcessEnv = process.env, platform = process.platform) =>
  platform === "linux" && Boolean(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim());

export const authorityKind = (
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): CodexHubAuthorityKind => {
  if (isWslEnvironment(env, platform)) return "wsl";
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
};

/**
 * WSL mirrored networking 与 Windows 共用 localhost 端口空间，因此 WSL 固定
 * 使用相邻的 +1 端口；不同远程 authority 各自拥有独立的网络命名空间。
 */
export const authorityServicePort = (
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
) => {
  const configured = env.CODEX_HUB_AUTHORITY_PORT?.trim();
  if (configured) {
    const port = Number(configured);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid CODEX_HUB_AUTHORITY_PORT: ${configured}`);
    }
    return port;
  }
  return authorityHostServicePort + (isWslEnvironment(env, platform) ? 1 : 0);
};
