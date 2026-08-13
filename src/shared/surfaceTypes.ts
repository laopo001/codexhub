export type CodexHubSurface = "default" | "vscode" | "theia";
export type EmbeddedCodexHubSurface = Exclude<CodexHubSurface, "default">;

export type CodexHubAuthorityKind = "windows" | "macos" | "linux" | "wsl";

export type CodexHubAuthorityDescriptor = {
  authorityId: string;
  kind: CodexHubAuthorityKind;
  surfaceProtocolVersion: number;
};

/** Windows、macOS 和普通 Linux 上 VSCode authority service 的固定端口。 */
export const vscodeHostServicePort = 28_788;
export const vscodeSurfaceProtocolVersion = 1;

export const isCodexHubSurface = (value: unknown): value is CodexHubSurface =>
  value === "default" || value === "vscode" || value === "theia";

export const isEmbeddedCodexHubSurface = (
  surface: CodexHubSurface
): surface is EmbeddedCodexHubSurface => surface !== "default";

export const isWslEnvironment = (env: NodeJS.ProcessEnv = process.env, platform = process.platform) =>
  platform === "linux" && Boolean(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim());

export const vscodeAuthorityKind = (
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
export const vscodeAuthorityServicePort = (
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
) => vscodeHostServicePort + (isWslEnvironment(env, platform) ? 1 : 0);
