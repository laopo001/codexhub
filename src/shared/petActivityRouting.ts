import { parseProjectSource, type ProjectSource, type ProjectSummary } from "./projectTypes.js";
import {
  parseWorkspaceFileLaunchReference,
  isVscodeChannel,
  type VscodeChannel
} from "./surfaceTypes.js";

export { parseProjectSource } from "./projectTypes.js";

export type ProjectTarget = {
  machineId: string;
  path: string;
};

/** Explicit workspace routing metadata. It is deliberately separate from ProjectSource and ProjectTarget. */
export type WorkspaceTarget = {
  machineId: string;
  kind: "vscode" | "electron";
  groupId: string;
  workspacePaths: string[];
  workspaceFile?: string;
  vscodeChannel?: VscodeChannel;
  label?: string;
};

/** 桌面宠物 Activity 点击时向宿主投递的目标描述 */
export type PetActivityOpenTarget = {
  threadId: string;
  workingDirectory?: string;
  machineId?: string;
  machineHostname?: string;
  projectPath?: string;
  source?: ProjectSource;
  projectTarget?: ProjectTarget;
  workspaceTarget?: WorkspaceTarget;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safePathList = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > 256) return null;
  const paths = value.map((item) => {
    const path = validateSafeString(item, 4096);
    return path ? normalizePath(path) : null;
  });
  if (paths.some((item): item is null => item === null)) return null;
  const unique = [...new Set(paths as string[])];
  return unique.length ? unique : null;
};

export const parseProjectTarget = (value: unknown): ProjectTarget | null => {
  if (!isRecord(value) || Object.keys(value).some((key) => !["machineId", "path"].includes(key))) return null;
  const machineId = validateSafeString(value.machineId, 256);
  const rawPath = validateSafeString(value.path, 4096);
  const path = rawPath ? normalizePath(rawPath) : "";
  return machineId && path ? { machineId, path } : null;
};

export const parseWorkspaceTarget = (value: unknown): WorkspaceTarget | null => {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) =>
    !["machineId", "kind", "groupId", "workspacePaths", "workspaceFile", "vscodeChannel", "label"].includes(key)
  )) return null;
  if (value.kind !== "vscode" && value.kind !== "electron") return null;
  const groupId = validateSafeString(value.groupId, 256);
  const machineId = validateSafeString(value.machineId, 256);
  const workspacePaths = safePathList(value.workspacePaths);
  if (!machineId || !groupId || !workspacePaths) return null;
  const label = value.label === undefined ? undefined : validateSafeString(value.label, 512);
  if (value.label !== undefined && !label) return null;
  const workspaceFile = value.workspaceFile === undefined
    ? undefined
    : validateSafeString(value.workspaceFile, 4096);
  if (value.workspaceFile !== undefined && (!workspaceFile || value.kind !== "vscode")) return null;
  const vscodeChannel = value.vscodeChannel;
  if (value.kind === "vscode" && !isVscodeChannel(vscodeChannel)) return null;
  if (value.kind === "electron" && vscodeChannel !== undefined) return null;
  const parsedVscodeChannel = isVscodeChannel(vscodeChannel) ? vscodeChannel : undefined;
  return {
    machineId,
    kind: value.kind,
    groupId,
    workspacePaths,
    ...(workspaceFile ? { workspaceFile } : {}),
    ...(parsedVscodeChannel ? { vscodeChannel: parsedVscodeChannel } : {}),
    ...(label ? { label } : {})
  };
};

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
    projectPath = normalizePath(parsed);
  }

  let source: ProjectSource | undefined;
  if (value.source !== undefined) {
    const parsed = parseProjectSource(value.source);
    if (!parsed) return null; // 显式提供了 malformed source 时整包拒绝
    source = parsed;
  }

  const projectTarget = value.projectTarget === undefined
    ? undefined
    : parseProjectTarget(value.projectTarget);
  if (value.projectTarget !== undefined && !projectTarget) return null;
  if (projectTarget && machineId !== projectTarget.machineId) return null;
  const workspaceTarget = value.workspaceTarget === undefined
    ? undefined
    : parseWorkspaceTarget(value.workspaceTarget);
  if (value.workspaceTarget !== undefined && !workspaceTarget) return null;
  if (workspaceTarget && machineId !== workspaceTarget.machineId) return null;
  if ((projectTarget || workspaceTarget) && !machineId) return null;
  if (projectTarget && workspaceTarget && !workspaceTarget.workspacePaths.includes(projectTarget.path)) return null;
  if (source && workspaceTarget
    && (source.kind !== workspaceTarget.kind || source.groupId !== workspaceTarget.groupId)) return null;
  if (source?.vscodeChannel && workspaceTarget?.vscodeChannel
    && source.vscodeChannel !== workspaceTarget.vscodeChannel) return null;
  if (source && workspaceTarget && source.workspaceFile !== workspaceTarget.workspaceFile) return null;
  if (projectPath && projectTarget && projectPath !== projectTarget.path) return null;

  return {
    threadId,
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(machineId ? { machineId } : {}),
    ...(machineHostname ? { machineHostname } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(source ? { source } : {}),
    ...(projectTarget ? { projectTarget } : {}),
    ...(workspaceTarget ? { workspaceTarget } : {})
  };
};

/** 路径规范化：统一正斜杠、去除连续斜杠、去除末尾斜杠（保留根路径或盘符根） */
export function normalizePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\\+/g, "/");
  if (!trimmed) return "";
  const isUnc = trimmed.startsWith("//");
  const normalized = (isUnc ? "//" : "") + trimmed.replace(/\/+/g, "/");
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

const isWindowsDrivePath = (path: string) => /^[a-zA-Z]:(?:[\\/]|$)/.test(path);

export const pathIdentityKey = (rawPath: string): string => {
  const normalized = normalizePath(rawPath);
  return isWindowsDrivePath(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
};

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
  const workspaceTarget = parseWorkspaceTarget(target.workspaceTarget);
  if (!workspaceTarget || workspaceTarget.kind !== "vscode") return null;
  if (!target.machineId || target.machineId !== workspaceTarget.machineId) return null;
  if (target.projectTarget && target.machineId !== target.projectTarget.machineId) return null;
  if (target.projectTarget && !workspaceTarget.workspacePaths.includes(target.projectTarget.path)) return null;
  if (target.projectPath && target.projectTarget && target.projectPath !== target.projectTarget.path) return null;
  if (target.source && (
    target.source.kind !== workspaceTarget.kind
    || target.source.groupId !== workspaceTarget.groupId
    || target.source.workspaceFile !== workspaceTarget.workspaceFile
    || (target.source.vscodeChannel !== undefined
      && target.source.vscodeChannel !== workspaceTarget.vscodeChannel)
  )) return null;
  const channel = workspaceTarget.vscodeChannel;
  if (!channel || (channel !== "stable" && channel !== "insiders")) return null;

  const explicitWorkspaceFile = parseWorkspaceFileLaunchReference(workspaceTarget.workspaceFile);
  if (workspaceTarget.workspaceFile !== undefined && !explicitWorkspaceFile) return null;
  const launchReference = explicitWorkspaceFile;
  const targetPath = launchReference?.path
    || (workspaceTarget.workspacePaths.length === 1 ? workspaceTarget.workspacePaths[0] : undefined);
  if (!targetPath) return null;

  // 校验 machineHostname 与宿主机 localHostname 强一致
  const targetHostname = target.machineHostname?.trim();
  const localHostname = options.localHostname?.trim();
  if (!targetHostname || !localHostname) return null;
  if (targetHostname.toLowerCase() !== localHostname.toLowerCase()) return null;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const command = options.customExecutable || resolveVsCodeCliExecutable(channel, env, platform);

  const remote = launchReference?.remote;
  const distro = remote?.startsWith("wsl+") ? remote.slice("wsl+".length) : extractWslDistroFromLabel(workspaceTarget.label);
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
  const label = workspaceTarget.label || "";
  if (/\[(?:SSH|Dev Container|Tunnel|Attached Container):/i.test(label)) {
    return null;
  }
  if (workspaceTarget.groupId.includes(":ssh:")) {
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
