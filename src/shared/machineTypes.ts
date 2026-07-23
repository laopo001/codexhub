/** 机器来源类型；表示执行路径解析和 Codex runtime 启动的机器边界。 */
export type MachineType = "local" | "ssh" | "registered";

/** 机器暴露的项目目录来源；fixed 表示目录列表由 provider 固定提供。 */
export type MachineProjectCatalog = "editable" | "fixed";

/** 机器能力声明，供 Web 判断是否允许浏览目录或启动项目 runtime。 */
export type MachineCapabilities = {
  projectLauncher: boolean;
  projectCatalog?: MachineProjectCatalog;
};

/** 机器注册时附带的项目来源标记，用于嵌入 IDE workspace 临时项目。 */
export type MachineRegistrationProjectSource = {
  kind: "vscode" | "theia";
  groupId: string;
  label?: string;
};

/** 机器注册时声明的可见项目目录。 */
export type MachineRegistrationProject = {
  path: string;
  source?: MachineRegistrationProjectSource;
};

/** machine WebSocket 注册 payload；server 用它创建或刷新 machine 投影。 */
export type MachineRegistration = {
  machineId?: string;
  type?: MachineType;
  name?: string;
  hostname: string;
  pid?: number;
  platform?: string;
  cwd?: string;
  capabilities?: Partial<MachineCapabilities>;
  projects?: MachineRegistrationProject[];
  transportId?: string;
};

/** Web/API 可见的机器摘要，不包含待执行 command 队列等 server 内部状态。 */
export type MachineSummary = {
  machineId: string;
  type: MachineType;
  name?: string;
  hostname: string;
  online: boolean;
  status: "online" | "offline";
  lastSeenAt: string;
  offlineSinceAt?: string;
  offlineReason?: "transport_disconnected" | "unregistered";
  pid?: number;
  platform?: string;
  cwd?: string;
  capabilities: MachineCapabilities;
};

/** machine 确保唯一 Codex runtime 已启动后的内部结果。 */
export type MachineEnsureRuntimeResult = {
  sessionId: string;
  appServerUrl: string;
  cwd: string;
  reused?: boolean;
};

/** 机器启动或复用 machine runtime 后，按 cwd 创建/恢复 thread 的内部结果。 */
export type MachineStartSessionResult = {
  sessionId: string;
  threadId: string;
  appServerUrl: string;
  cwd: string;
  reused?: boolean;
};

/** 机器目录浏览返回的一项子目录。 */
export type MachineDirectoryEntry = {
  name: string;
  path: string;
};

/** 机器侧解析后的目录列表；server 不自行扫描远端文件系统。 */
export type MachineDirectoryListing = {
  cwd: string;
  parent?: string;
  home: string;
  entries: MachineDirectoryEntry[];
};

/** machine 在自身文件系统中创建或复用 git worktree 后返回的路径。 */
export type MachineGitWorktreeResult = {
  parentCwd: string;
  path: string;
  branch: string;
  baseRef?: string;
  createdBranch: boolean;
};

/** 停止指定 machine session 的命令结果；当前公开 project flow 一般不主动停止 runtime。 */
export type MachineStopSessionResult = {
  sessionId: string;
  stopped: boolean;
  cwd?: string;
};

/** machine command 的所有可能返回值。 */
export type MachineCommandResult =
  | MachineEnsureRuntimeResult
  | MachineStartSessionResult
  | MachineDirectoryListing
  | MachineGitWorktreeResult
  | MachineStopSessionResult;

type MachineCommandBase = {
  seq: number;
  commandId: string;
  createdAt: string;
};

type MachineCommandDetail = {
  type: "ensure_runtime";
  cwd: string;
} | {
  type: "start_session";
  cwd: string;
  reuse?: boolean;
  threadId?: string;
} | {
  type: "list_directory";
  cwd?: string;
} | {
  type: "create_git_worktree";
  parentCwd: string;
  branch: string;
  baseRef?: string;
  path?: string;
} | {
  type: "stop_session";
  sessionId: string;
};

/** server 下发给 machine 的内部命令；通过 machine WebSocket 传输。 */
export type MachineCommand = MachineCommandBase & MachineCommandDetail;
