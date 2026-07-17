/** 从本机 SSH config 解析出的 Host 候选项。 */
export type SshHostConfig = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  proxyJump?: string;
};

/** server 管理的 SSH reverse tunnel 连接状态。 */
export type SshMachineConnectionStatus = "starting" | "running" | "exited";

/** SSH machine 连接摘要，包含 reverse tunnel 参数和最近输出。 */
export type SshMachineConnection = {
  connectionId: string;
  host: string;
  name?: string;
  remoteClientHash: string;
  status: SshMachineConnectionStatus;
  startedAt: string;
  updatedAt: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  lastOutput?: string;
};

/** Web/API 发起 SSH 连接时的输入。 */
export type SshMachineConnectInput = {
  host: string;
  name?: string;
  remotePort?: number;
};
