import type {
  MachineCapabilities,
  MachineSummary,
  MachineType
} from "./machineTypes.js";
import type { SessionSummary, ThreadSummary } from "./threadTypes.js";

/** config.yaml 中持久化的 machine 元数据，不表示当前在线状态。 */
export type StoredMachine = {
  machineId: string;
  type: MachineType;
  name?: string;
  hostname: string;
  lastSeenAt: string;
  capabilities: MachineCapabilities;
};

/** config.yaml 中持久化的项目记录；项目 ID 由 machineId 和 path 推导。 */
export type StoredProject = {
  projectId: string;
  machineId: string;
  path: string;
  pinned?: boolean;
  createdAt: string;
  lastOpenedAt: string;
  lastThreadId?: string;
};

/** 项目来源标记；用于区分普通持久项目和嵌入 surface 提供的临时项目。 */
export type ProjectSource = {
  kind: "vscode";
  groupId: string;
  label?: string;
};

/** task 最近一次运行或历史运行的状态。 */
export type TaskRunStatus = "queued" | "completed" | "failed" | "skipped";

/** task 的单次运行摘要，只保存少量最近历史用于 UI 展示。 */
export type StoredTaskRun = {
  runId: string;
  status: TaskRunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  sessionId?: string;
  threadId?: string;
  error?: string;
};

/** server-local 定时任务配置及最近运行摘要。 */
export type StoredTask = {
  taskId: string;
  name: string;
  enabled: boolean;
  schedule: string;
  machineId: string;
  projectPath: string;
  projectId?: string;
  threadId?: string;
  input: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: TaskRunStatus;
  lastError?: string;
  lastDurationMs?: number;
  runs?: StoredTaskRun[];
};

/** 用户加入 CodexHub 管理列表的 SSH host alias。 */
export type StoredSshHost = {
  alias: string;
  createdAt: string;
  updatedAt: string;
};

/** config.yaml 中持久化的 Web/VSCode 共享 UI 偏好。 */
export type ServerUiConfig = {
  taskCompleteSystemNotifications: boolean;
};

/** config.yaml 中持久化的全局配置。 */
export type ServerConfig = {
  ui: ServerUiConfig;
};

/** config.yaml 的持久化结构。 */
export type ServerStateData = {
  version: 1;
  updatedAt: string;
  config: ServerConfig;
  env: Record<string, string>;
  machines: StoredMachine[];
  projects: StoredProject[];
  tasks: StoredTask[];
  sshHosts: StoredSshHost[];
};

/** Web/API 展示用项目投影，合并了持久项目、machine 在线状态和当前 session。 */
export type ProjectSummary = StoredProject & {
  name: string;
  transient?: boolean;
  source?: ProjectSource;
  machine?: MachineSummary | StoredMachine;
  machineOnline: boolean;
  session: SessionSummary | null;
  online: boolean;
  running: boolean;
  sessions: SessionSummary[];
  threads: ThreadSummary[];
};
