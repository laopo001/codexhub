import type { PlanProgressSummary } from "./planProgress.js";
import type { VscodeChannel } from "./surfaceTypes.js";

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
  kind: "vscode" | "electron";
  groupId: string;
  label?: string;
  vscodeChannel?: VscodeChannel;
};

/** 机器注册时声明的可见项目目录。 */
export type MachineRegistrationProject = {
  path: string;
  source?: MachineRegistrationProjectSource;
};

/**
 * Ephemeral activity hint sent by a server when it registers to a parent.
 * It is intentionally smaller than a thread/runtime projection and never
 * carries transcript records; the parent may use it for cross-authority UI
 * such as the Electron desktop pet.
 */
export type MachineActivityStatus = "needs_input" | "blocked" | "running" | "idle";

export type MachineActivitySummary = {
  threadId: string;
  title: string;
  /** Compact Goal/user-input hint for activity-only consumers without records. */
  activityTitle?: string;
  /** Current app-server Turn start, used by detached activity timers. */
  activeTurnStartedAt?: string;
  /** Current app-server Turn Plan progress, used by detached activity consumers. */
  activePlanProgress?: PlanProgressSummary;
  /** Latest compact Agent commentary/final answer for activity-only consumers. */
  latestAgentMessage?: string;
  workingDirectory: string;
  updatedAt: string;
  status: MachineActivityStatus;
};

/** machine WebSocket 注册 payload；server 用它创建或刷新 machine 投影。 */
export type MachineRegistration = {
  machineId?: string;
  sshConnectionId?: string;
  type?: MachineType;
  name?: string;
  hostname: string;
  pid?: number;
  platform?: string;
  cwd?: string;
  capabilities?: Partial<MachineCapabilities>;
  projects?: MachineRegistrationProject[];
  activities?: MachineActivitySummary[];
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
  activities?: MachineActivitySummary[];
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

/** 浏览器可直接播放、由 machine 文件签名确认的媒体 MIME。 */
export const machineFilePreviewMediaContentTypes = [
  "video/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/flac",
  "audio/ogg",
  "audio/aac",
  "audio/mp4"
] as const;

export type MachineFilePreviewMediaContentType = typeof machineFilePreviewMediaContentTypes[number];

/** machine 读取本机文件后返回给 Web 对话框的安全预览内容。 */
export type MachineFilePreviewResult = {
  kind: "text";
  path: string;
  size: number;
  contentType: "text/plain; charset=utf-8";
  text: string;
  truncated: boolean;
} | {
  kind: "image";
  path: string;
  size: number;
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/x-icon" | "image/avif";
  base64: string;
} | {
  kind: "media";
  path: string;
  size: number;
  modifiedAtMs: number;
  contentType: MachineFilePreviewMediaContentType;
} | {
  kind: "unsupported";
  path: string;
  size: number;
  reason: "unsupported_type" | "file_too_large";
  maxBytes?: number;
};

/** machine 返回的一段文件内容；server 将它转成支持 HTTP Range 的受控字节流。 */
export type MachineFileChunkResult = {
  path: string;
  size: number;
  modifiedAtMs: number;
  offset: number;
  base64: string;
  eof: boolean;
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
  | MachineFilePreviewResult
  | MachineFileChunkResult
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
  type: "preview_file";
  path: string;
} | {
  type: "read_file_chunk";
  path: string;
  offset: number;
  length: number;
  expectedSize: number;
  expectedModifiedAtMs: number;
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
