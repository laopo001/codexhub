export type CodexHubSurface = "default" | "vscode" | "electron";
export type EmbeddedCodexHubSurface = Exclude<CodexHubSurface, "default">;
export type EmbeddedSurfaceKind = "vscode" | "electron";
export const embeddedSurfaceKinds: EmbeddedSurfaceKind[] = ["vscode", "electron"];

export type CodexHubAuthorityKind = "windows" | "macos" | "linux" | "wsl";

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
