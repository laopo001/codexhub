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

/** 来源徽标使用统一的小写短名；不用于工作区名称或协议标识。 */
export const formatSourceBadgeLabel = (label: string): string => {
  const normalized = label.trim().toLowerCase();
  const labels: Record<string, string> = {
    "vs code": "vsc", vscode: "vsc",
    insiders: "vsc-i", "vs code insiders": "vsc-i", "vscode insiders": "vsc-i", "vscode-insiders": "vsc-i",
    registered: "reg", electron: "ele"
  };
  return labels[normalized] ?? normalized;
};

/** 统一的 VSCode 渠道紧凑徽标标识（如侧边栏 badge / 标签） */
export const formatVscodeChannelBadge = (channel?: VscodeChannel): string =>
  formatSourceBadgeLabel(channel === "insiders" ? "vscode-insiders" : "vscode");

/** 统一的 VSCode surface 组名或标题前缀 */
export const formatVscodeSurfacePrefix = (channel?: VscodeChannel): string =>
  channel === "insiders" ? "VS Code Insiders" : "VS Code";

export type VscodeWorkspaceFileLike = {
  scheme: string;
  path?: string;
  fsPath?: string;
  authority?: string;
};

/**
 * Serialize a VS Code workspace file into the launch reference carried by ProjectSource.
 * - file: preserve the local filesystem path;
 * - vscode-remote: preserve both a validated WSL authority and its absolute remote path;
 * - untitled / ssh-remote / dev-container / tunnel / 其他自定义 scheme: 返回 undefined，绝不上报以防止误打开。
 */
export const resolveWorkspaceFileLaunchReference = (
  workspaceFile?: VscodeWorkspaceFileLike | null
): string | undefined => {
  if (!workspaceFile || typeof workspaceFile !== "object") return undefined;
  const scheme = workspaceFile.scheme?.trim().toLowerCase();
  if (!scheme || scheme === "untitled") return undefined;

  if (scheme === "file") {
    const rawPath = workspaceFile.fsPath?.trim() || workspaceFile.path?.trim();
    return rawPath && !/[\u0000-\u001f\u007f]/.test(rawPath) ? rawPath : undefined;
  }

  if (scheme === "vscode-remote") {
    const authority = workspaceFile.authority?.trim() || "";
    if (/^wsl\+[a-zA-Z0-9._-]+$/.test(authority)) {
      const rawPath = workspaceFile.path?.trim() || workspaceFile.fsPath?.trim();
      if (rawPath?.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(rawPath)) {
        return `vscode-remote://${authority}${rawPath.replace(/\\+/g, "/")}`;
      }
    }
    return undefined;
  }

  return undefined;
};

export type VscodeWorkspaceLaunchReference = {
  path: string;
  remote?: string;
};

/** Parse the serialized workspace-file reference carried by ProjectSource. */
export const parseWorkspaceFileLaunchReference = (
  reference?: string | null
): VscodeWorkspaceLaunchReference | null => {
  const trimmed = reference?.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;

  const remoteMatch = trimmed.match(/^vscode-remote:\/\/(wsl\+([a-zA-Z0-9._-]+))(\/.*)$/i);
  if (remoteMatch) {
    return {
      remote: `wsl+${remoteMatch[2]}`,
      path: remoteMatch[3].replace(/\\+/g, "/")
    };
  }
  if (/^vscode-remote:/i.test(trimmed)) return null;
  return { path: trimmed };
};

/**
 * A replacement extension may temporarily attach to the previous strict-schema authority.
 * Omit fields introduced by the replacement build for that one compatibility registration;
 * the new authority receives the complete registration after takeover.
 */
export const workspaceFileForAuthorityRegistration = (
  workspaceFile: string | undefined,
  replacementExpected?: boolean
): string | undefined => replacementExpected ? undefined : workspaceFile;

export type VscodeWorkspaceFolderLike = string | { path: string };

/**
 * 确定性规范化 VS Code 工作区状态身份字符串（用于生成稳定的 stateScope / storage key）。
 * 规则：
 * 1. 优先使用 workspaceFile（保存的 .code-workspace、untitled workspace、remote workspace 等）；
 *    一旦存在 workspaceFile，绝不混入 folders 列表，保证在多根工作区增删 folder 时 identity 保持不变；
 * 2. workspaceFile 不存在时，使用 folders 集合（规范化路径后去重并按字典序升序排序）；
 * 3. 严格拒绝控制字符；
 * 4. 渠道（vscodeChannel）不作为输入，Stable 与 Insiders 打开同一 workspace 得到完全相同的 identity。
 */
export const normalizeVscodeWorkspaceIdentity = (
  workspaceFile?: VscodeWorkspaceFileLike | string | null,
  folders?: readonly VscodeWorkspaceFolderLike[] | null
): string => {
  if (typeof workspaceFile === "string") {
    const trimmed = workspaceFile.trim();
    if (trimmed && !/[\u0000-\u001f\u007f]/.test(trimmed)) {
      return `workspace-file:${trimmed.replace(/\\+/g, "/")}`;
    }
  } else if (workspaceFile && typeof workspaceFile === "object") {
    const scheme = workspaceFile.scheme?.trim().toLowerCase() || "";
    if (scheme) {
      if (scheme === "file") {
        const rawPath = (workspaceFile.fsPath?.trim() || workspaceFile.path?.trim() || "").replace(/\\+/g, "/");
        if (rawPath && !/[\u0000-\u001f\u007f]/.test(rawPath)) {
          return `workspace-file:${rawPath}`;
        }
      } else if (scheme === "untitled") {
        const rawPath = (workspaceFile.path?.trim() || "untitled").replace(/\\+/g, "/");
        if (!/[\u0000-\u001f\u007f]/.test(rawPath)) {
          return `workspace-untitled:${rawPath}`;
        }
      } else {
        const authority = workspaceFile.authority?.trim() || "";
        const rawPath = (workspaceFile.path?.trim() || workspaceFile.fsPath?.trim() || "").replace(/\\+/g, "/");
        const fullIdentity = `${scheme}:${authority ? `//${authority}` : ""}${rawPath}`;
        if (!/[\u0000-\u001f\u007f]/.test(fullIdentity)) {
          return `workspace-remote:${fullIdentity}`;
        }
      }
    }
  }

  // Fallback to folders collection
  const rawFolderList = Array.isArray(folders) ? folders : [];
  const normalizedPaths = rawFolderList
    .map((folder) => {
      const raw = typeof folder === "string" ? folder : folder?.path;
      if (typeof raw !== "string") return "";
      const trimmed = raw.trim();
      return trimmed && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed.replace(/\\+/g, "/") : "";
    })
    .filter(Boolean);

  const uniqueSorted = [...new Set(normalizedPaths)].sort();
  if (uniqueSorted.length === 1) {
    return `workspace-folder:${uniqueSorted[0]}`;
  }
  if (uniqueSorted.length > 1) {
    return `workspace-folders:${uniqueSorted.join("\0")}`;
  }

  return "workspace-empty";
};

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

/**
 * Resolve the one authority port setting shared by CLI, server, VS Code, and
 * Electron. CODEX_HUB_AUTHORITY_PORT remains a compatibility alias while
 * callers migrate to CODEX_HUB_PORT. WSL reserves +1 to avoid Windows
 * localhost collisions under mirrored networking.
 */
export const authorityServicePort = (
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  explicitPort?: number | string
) => {
  if (explicitPort !== undefined) return parseAuthorityPort(explicitPort, "authority port");
  const unified = env.CODEX_HUB_PORT?.trim();
  const legacy = env.CODEX_HUB_AUTHORITY_PORT?.trim();
  if (unified && legacy) {
    const unifiedPort = parseAuthorityPort(unified, "CODEX_HUB_PORT");
    const legacyPort = parseAuthorityPort(legacy, "CODEX_HUB_AUTHORITY_PORT");
    if (unifiedPort !== legacyPort) {
      throw new Error(
        `CODEX_HUB_PORT (${unifiedPort}) and CODEX_HUB_AUTHORITY_PORT (${legacyPort}) must match.`
      );
    }
    return unifiedPort;
  }
  if (unified) return parseAuthorityPort(unified, "CODEX_HUB_PORT");
  if (legacy) return parseAuthorityPort(legacy, "CODEX_HUB_AUTHORITY_PORT");
  return authorityHostServicePort + (isWslEnvironment(env, platform) ? 1 : 0);
};

const parseAuthorityPort = (value: number | string, label: string) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return port;
};

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


/** One listen-host policy for server and embedded launchers. Explicit CLI overrides win. */
export const authorityServiceHost = (
  env: NodeJS.ProcessEnv = process.env,
  explicitHost?: string
) => {
  const unified = env.CODEX_HUB_HOST?.trim();
  const legacy = env.CODEX_HUB_AUTHORITY_HOST?.trim();
  if (explicitHost === undefined && unified && legacy && unified !== legacy) {
    throw new Error("CODEX_HUB_HOST and CODEX_HUB_AUTHORITY_HOST must match.");
  }
  const host = explicitHost?.trim() || unified || legacy || "127.0.0.1";
  if (host === "localhost") return "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0", "::"].includes(host)) {
    const label = legacy && !unified && explicitHost === undefined ? "CODEX_HUB_AUTHORITY_HOST" : "CODEX_HUB_HOST";
    throw new Error(`Invalid ${label}: ${host}. Expected 127.0.0.1, 0.0.0.0, or ::.`);
  }
  return host;
};
