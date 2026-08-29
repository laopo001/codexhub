import { parseProjectSource, type ProjectSource, type ProjectSummary } from "./projectTypes.js";
import type { VscodeChannel } from "./surfaceTypes.js";

export { parseProjectSource } from "./projectTypes.js";

/** 桌面宠物 Activity 点击时向宿主投递的目标描述 */
export type PetActivityOpenTarget = {
  threadId: string;
  workingDirectory?: string;
  machineId?: string;
  machineHostname?: string;
  projectPath?: string;
  source?: ProjectSource;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 安全字符串校验：限制最大长度并拒绝所有控制字符（包括 NUL/CR/LF） */
export const validateSafeString = (value: unknown, maxLength = 4096): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  if (/[\u0000-\u001f\u007f]|\0/.test(trimmed)) return null;
  return trimmed;
};

/**
 * 严格校验 IPC 边界传入的 PetActivityOpenTarget。
 * 限制各字段长度并拒绝 NUL/CR/LF；当显式提供 source 但 malformed 时整包拒绝返回 null。
 */
export const parsePetActivityOpenTarget = (value: unknown): PetActivityOpenTarget | null => {
  if (!isRecord(value)) return null;

  const threadId = validateSafeString(value.threadId, 256);
  if (!threadId) return null;

  let workingDirectory: string | undefined;
  if (value.workingDirectory !== undefined) {
    const parsed = validateSafeString(value.workingDirectory, 4096);
    if (!parsed) return null;
    workingDirectory = parsed;
  }

  let machineId: string | undefined;
  if (value.machineId !== undefined) {
    const parsed = validateSafeString(value.machineId, 256);
    if (!parsed) return null;
    machineId = parsed;
  }

  let machineHostname: string | undefined;
  if (value.machineHostname !== undefined) {
    const parsed = validateSafeString(value.machineHostname, 256);
    if (!parsed) return null;
    machineHostname = parsed;
  }

  let projectPath: string | undefined;
  if (value.projectPath !== undefined) {
    const parsed = validateSafeString(value.projectPath, 4096);
    if (!parsed) return null;
    projectPath = parsed;
  }

  let source: ProjectSource | undefined;
  if (value.source !== undefined) {
    const parsed = parseProjectSource(value.source);
    if (!parsed) return null; // 显式提供了 malformed source 时整包拒绝
    source = parsed;
  }

  return {
    threadId,
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(machineId ? { machineId } : {}),
    ...(machineHostname ? { machineHostname } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(source ? { source } : {})
  };
};

/** 路径规范化：统一正斜杠、去除连续斜杠、去除末尾斜杠（保留根路径或盘符根） */
export const normalizePath = (rawPath: string): string => {
  const trimmed = rawPath.trim().replace(/\\+/g, "/");
  if (!trimmed) return "";
  const isUnc = trimmed.startsWith("//");
  const normalized = (isUnc ? "//" : "") + trimmed.replace(/\/+/g, "/");
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
};

const isWindowsDrivePath = (path: string) => /^[a-zA-Z]:(?:[\\/]|$)/.test(path);

/**
 * 判断 basePath 是否为 targetPath 的祖先目录或完全相同路径。
 * 必须按 path segment boundary 匹配，不能使用裸 startsWith。
 */
export const isPathSegmentAncestorOrEqual = (basePath: string, targetPath: string): boolean => {
  const normBase = normalizePath(basePath);
  const normTarget = normalizePath(targetPath);
  if (!normBase || !normTarget) return false;

  const isWindows = isWindowsDrivePath(normBase) || isWindowsDrivePath(normTarget);
  const compareBase = isWindows ? normBase.toLowerCase() : normBase;
  const compareTarget = isWindows ? normTarget.toLowerCase() : normTarget;

  if (compareBase === compareTarget) return true;
  if (compareBase === "/") return compareTarget.startsWith("/");
  if (/^[a-zA-Z]:\/$/.test(compareBase)) return compareTarget.startsWith(compareBase);

  return compareTarget.startsWith(`${compareBase}/`);
};

/**
 * 按 machineId 和 workingDirectory 寻找最长匹配（最具体）的 project。
 * 严格隔离 machineId（不同机器相同路径不串）。
 */
export const findLongestMatchingProject = (
  projects: readonly ProjectSummary[],
  machineId: string | undefined,
  workingDirectory: string | undefined
): ProjectSummary | undefined => {
  const trimmedMachineId = machineId?.trim();
  const trimmedDirectory = workingDirectory?.trim();
  if (!trimmedMachineId || !trimmedDirectory) return undefined;

  const machineProjects = projects.filter((project) => project.machineId === trimmedMachineId);
  const matchingProjects = machineProjects.filter((project) =>
    isPathSegmentAncestorOrEqual(project.path, trimmedDirectory)
  );

  if (matchingProjects.length === 0) return undefined;
  if (matchingProjects.length === 1) return matchingProjects[0];

  return [...matchingProjects].sort((left, right) => {
    const leftNorm = normalizePath(left.path);
    const rightNorm = normalizePath(right.path);
    const leftDepth = leftNorm.split("/").filter(Boolean).length;
    const rightDepth = rightNorm.split("/").filter(Boolean).length;
    if (leftDepth !== rightDepth) return rightDepth - leftDepth;
    return rightNorm.length - leftNorm.length;
  })[0];
};

/** 从 VSCode source label 中提取 WSL distro 名称 */
export const extractWslDistroFromLabel = (label?: string): string | null => {
  if (!label || typeof label !== "string") return null;
  const trimmed = label.trim();
  const bracketMatch = trimmed.match(/\[WSL:\s*([^\]]+)\]/i);
  if (bracketMatch?.[1]) {
    const distro = bracketMatch[1].trim();
    if (/^[a-zA-Z0-9._-]+$/.test(distro)) return distro;
  }
  const authorityMatch = trimmed.match(/\bWSL\s+([a-zA-Z0-9._-]+)\b/i);
  if (authorityMatch?.[1]) {
    const distro = authorityMatch[1].trim();
    if (/^[a-zA-Z0-9._-]+$/.test(distro)) return distro;
  }
  return null;
};

/** 解析可用的 VSCode CLI 可执行文件名称 */
export const resolveVsCodeCliExecutable = (
  channel: VscodeChannel = "stable",
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): string => {
  if (channel === "insiders") {
    const configured = env.CODEX_HUB_VSCODE_INSIDERS_CLI?.trim();
    if (configured) return configured;
    return platform === "win32" ? "code-insiders.cmd" : "code-insiders";
  }
  const configured = env.CODEX_HUB_VSCODE_CLI?.trim();
  if (configured) return configured;
  return platform === "win32" ? "code.cmd" : "code";
};

const windowsPath = (root: string, suffix: string) =>
  `${root.replace(/[\\/]+$/, "")}${suffix}`;

/** Windows Electron must invoke code.cmd / code-insiders.cmd by absolute path so `%~dp0` resolves inside the shim. */
export const resolveWindowsVsCodeCliExecutable = (
  channel: VscodeChannel,
  env: NodeJS.ProcessEnv,
  fileExists: (candidate: string) => boolean
): string | null => {
  if (channel === "insiders") {
    const configured = env.CODEX_HUB_VSCODE_INSIDERS_CLI?.trim();
    if (configured) return fileExists(configured) ? configured : null;

    const candidates = [
      env.LOCALAPPDATA ? windowsPath(env.LOCALAPPDATA, "\\Programs") : undefined,
      env.ProgramFiles,
      env.ProgramW6432
    ]
      .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
      .map((root) => windowsPath(root, "\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd"));
    return [...new Set(candidates)].find(fileExists) ?? null;
  }

  if (channel === "stable") {
    const configured = env.CODEX_HUB_VSCODE_CLI?.trim();
    if (configured) return fileExists(configured) ? configured : null;

    const candidates = [
      env.ProgramW6432,
      env.ProgramFiles,
      env.LOCALAPPDATA ? windowsPath(env.LOCALAPPDATA, "\\Programs") : undefined
    ]
      .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
      .map((root) => windowsPath(root, "\\Microsoft VS Code\\bin\\code.cmd"));
    return [...new Set(candidates)].find(fileExists) ?? null;
  }

  return null;
};

export type VsCodeLaunchPlan = {
  command: string;
  args: string[];
  remote?: string;
  targetPath: string;
};

/**
 * 构建 VSCode 唤起计划。
 * 必须校验 target.machineHostname 与 localHostname 大小写不敏感一致；
 * 必须校验明确的 vscodeChannel（stable 或 insiders），缺失时返回 null（no-op）；
 * 仅对可确认的本机 Windows/WSL/Linux VSCode 生成有效计划；
 * WSL 仅使用 ['--remote', 'wsl+<distro>', path]；Windows local 仅使用 [path]；
 * 对 SSH/Remote/未知 source/hostname mismatch 返回 null（no-op），绝不 fallback 弹 Electron。
 */
export const resolveVsCodeLaunchPlan = (
  target: PetActivityOpenTarget,
  options: {
    localHostname?: string;
    platform?: NodeJS.Platform;
    customExecutable?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): VsCodeLaunchPlan | null => {
  if (target.source?.kind !== "vscode") return null;
  const channel = target.source.vscodeChannel;
  if (!channel || (channel !== "stable" && channel !== "insiders")) return null;

  const targetPath = target.projectPath?.trim() || target.workingDirectory?.trim();
  if (!targetPath) return null;

  // 校验 machineHostname 与宿主机 localHostname 强一致
  const targetHostname = target.machineHostname?.trim();
  const localHostname = options.localHostname?.trim();
  if (!targetHostname || !localHostname) return null;
  if (targetHostname.toLowerCase() !== localHostname.toLowerCase()) return null;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const command = options.customExecutable || resolveVsCodeCliExecutable(channel, env, platform);

  const distro = extractWslDistroFromLabel(target.source.label);
  if (distro) {
    // 目标属于 WSL 环境：通过 code/code-insiders --remote wsl+<distro> <path> 唤起（不传 --reuse-window 与 --new-window）
    const normalizedWslPath = targetPath.replace(/\\+/g, "/");
    return {
      command,
      args: ["--remote", `wsl+${distro}`, normalizedWslPath],
      remote: `wsl+${distro}`,
      targetPath: normalizedWslPath
    };
  }

  // 检查是否包含明确的 Remote/SSH 标识
  const label = target.source.label || "";
  if (/\[(?:SSH|Dev Container|Tunnel|Attached Container):/i.test(label)) {
    return null;
  }
  if (target.source.groupId.includes(":ssh:")) {
    return null;
  }

  // Windows 本地 VSCode 场景（不传 --reuse-window 与 --new-window）
  if (platform === "win32" && (isWindowsDrivePath(targetPath) || targetPath.startsWith("\\\\"))) {
    return {
      command,
      args: [targetPath],
      targetPath
    };
  }

  // Linux 本机桌面 VSCode 场景（不传 --reuse-window 与 --new-window）
  if (platform === "linux" && targetPath.startsWith("/")) {
    return {
      command,
      args: [targetPath],
      targetPath
    };
  }

  return null;
};

export type SafeWindowsCmdInvocation = {
  cmdExe: string;
  cmdArgs: string[];
  rawCommandLine: string;
  windowsVerbatimArguments: true;
  cwd: string;
};

/**
 * 构造安全的 Windows cmd.exe 调用边界。
 * 严格检验 command 与每个参数，拒绝 NUL/CR/LF/双引号和 cmd expansion 字符；
 * 处理引号包裹并开启 /v:off（防止 ! 延迟扩展），生成安全单行命令；
 * 固定 windowsVerbatimArguments: true 防止 Node.js 二次转义 /c 内部的双引号；
 * 固定 cwd 为 Windows 本地 SystemRoot（默认 C:\Windows）以避免从 WSL UNC 路径启动时 cmd 报错。
 */
export const buildSafeWindowsCmdInvocation = (
  command: string,
  args: string[],
  options: {
    comSpec?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } | string = {}
): SafeWindowsCmdInvocation | null => {
  const opts = typeof options === "string" ? { comSpec: options } : options;
  const env = opts.env || process.env;
  const comSpec = opts.comSpec || env.ComSpec || "cmd.exe";
  const cwd = opts.cwd || env.SystemRoot || env.windir || "C:\\Windows";

  // Command 必须是 "code.cmd" / "code-insiders.cmd" 或以其结尾的安全绝对路径
  const trimmedCommand = command.trim();
  if (!trimmedCommand || /[\0\r\n"%!^]/.test(trimmedCommand)) return null;
  const isSafeCommand = trimmedCommand.toLowerCase() === "code.cmd"
    || trimmedCommand.toLowerCase() === "code-insiders.cmd"
    || /^[a-zA-Z]:[\\/][^"\r\n\0]+[\\/]code(?:-insiders)?\.cmd$/i.test(trimmedCommand);
  if (!isSafeCommand) return null;

  const quotedArgs: string[] = [];
  for (const arg of args) {
    if (typeof arg !== "string") return null;
    if (arg.length > 4096) return null;
    // `%` 在引号内仍会展开，`call` 还会触发二次解析；`!` / `^` 也不进入 cmd 边界。
    if (/[\0\r\n"%!^]/.test(arg)) return null;
    // 使用双引号包裹每个参数
    quotedArgs.push(`"${arg}"`);
  }

  const rawCommandLine = `"${trimmedCommand}" ${quotedArgs.join(" ")}`;
  return {
    cmdExe: comSpec,
    cmdArgs: ["/d", "/v:off", "/s", "/c", `call ${rawCommandLine}`],
    rawCommandLine,
    windowsVerbatimArguments: true,
    cwd
  };
};
