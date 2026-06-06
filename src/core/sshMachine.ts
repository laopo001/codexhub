import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export type SshMachineConnectionStatus = "starting" | "running" | "exited";

export type SshMachineConnection = {
  connectionId: string;
  host: string;
  name?: string;
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

export type SshMachineConnectInput = {
  host: string;
  name?: string;
  remotePort?: number;
  remoteCommand?: string;
};

type RuntimeSshMachineConnection = SshMachineConnection & {
  child: ChildProcess;
};

type SshMachineManagerOptions = {
  localHost: string;
  localPort: number;
  sshConfigPath?: string;
  onChange?: () => void;
};

const outputLimit = 12_000;
const defaultRemotePath = [
  "$HOME/.nvm/versions/node/v22.22.1/bin",
  "$HOME/.nvm/versions/node/v20.18.0/bin",
  "$HOME/Library/pnpm",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "$HOME/.local/bin",
  "$PATH"
].join(":");

export class SshMachineManager {
  private readonly connections = new Map<string, RuntimeSshMachineConnection>();

  constructor(private readonly options: SshMachineManagerOptions) {}

  listConnections(): SshMachineConnection[] {
    return [...this.connections.values()]
      .map(publicConnection)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  connect(input: SshMachineConnectInput) {
    const host = input.host.trim();
    if (!host) throw new Error("SSH host is required.");

    const now = new Date().toISOString();
    const remotePort = input.remotePort ?? randomRemotePort();
    const connectionId = randomUUID();
    const localHost = loopbackHost(this.options.localHost);
    const remoteApiBase = `http://127.0.0.1:${remotePort}`;
    const remoteCommand = input.remoteCommand ?? [
      `PATH=${shellDoubleQuote(defaultRemotePath)}`,
      "codexhub",
      "machine",
      "--server",
      shellQuote(remoteApiBase),
      "--type",
      "ssh",
      ...(input.name ? ["--name", shellQuote(input.name)] : [])
    ].join(" ");

    const args = [
      "-T",
      ...(this.options.sshConfigPath ? ["-F", this.options.sshConfigPath] : []),
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=10",
      "-o", "ServerAliveCountMax=3",
      "-R", `127.0.0.1:${remotePort}:${localHost}:${this.options.localPort}`,
      host,
      remoteCommand
    ];
    const child = spawn("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const connection: RuntimeSshMachineConnection = {
      connectionId,
      host,
      name: input.name,
      status: "starting",
      startedAt: now,
      updatedAt: now,
      remotePort,
      localHost,
      localPort: this.options.localPort,
      pid: child.pid,
      child
    };
    this.connections.set(connectionId, connection);

    const appendOutput = (chunk: Buffer) => {
      connection.lastOutput = trimOutput(`${connection.lastOutput ?? ""}${chunk.toString("utf8")}`);
      connection.updatedAt = new Date().toISOString();
      if (connection.status === "starting") connection.status = "running";
      this.options.onChange?.();
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.once("spawn", () => {
      connection.status = "running";
      connection.updatedAt = new Date().toISOString();
      this.options.onChange?.();
    });
    child.once("exit", (exitCode, signal) => {
      connection.status = "exited";
      connection.exitCode = exitCode;
      connection.signal = signal;
      connection.updatedAt = new Date().toISOString();
      this.options.onChange?.();
    });
    child.once("error", (error) => {
      connection.status = "exited";
      connection.lastOutput = trimOutput(`${connection.lastOutput ?? ""}${error.message}`);
      connection.updatedAt = new Date().toISOString();
      this.options.onChange?.();
    });
    this.options.onChange?.();
    return publicConnection(connection);
  }

  async stop(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error(`SSH connection not found: ${connectionId}`);
    await this.terminate(connection);
    return publicConnection(connection);
  }

  async stopAll() {
    await Promise.allSettled([...this.connections.values()].map((connection) => this.terminate(connection)));
  }

  private async terminate(connection: RuntimeSshMachineConnection) {
    if (connection.status !== "exited" && connection.child.exitCode === null && connection.child.signalCode === null) {
      connection.child.kill("SIGTERM");
      if (!await waitForChildExit(connection.child, 3000)) {
        connection.child.kill("SIGKILL");
        await waitForChildExit(connection.child, 3000);
      }
    }
    connection.status = "exited";
    connection.exitCode = connection.child.exitCode;
    connection.signal = connection.child.signalCode;
    connection.updatedAt = new Date().toISOString();
    this.options.onChange?.();
  }
}

const publicConnection = (connection: RuntimeSshMachineConnection): SshMachineConnection => {
  const { child: _child, ...summary } = connection;
  return summary;
};

const loopbackHost = (host: string) => host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

const randomRemotePort = () => 18_000 + Math.floor(Math.random() * 30_000);

const trimOutput = (value: string) =>
  value.length <= outputLimit ? value : value.slice(value.length - outputLimit);

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const shellDoubleQuote = (value: string) => `"${value.replace(/["\\`]/g, "\\$&")}"`;

const waitForChildExit = async (child: ChildProcess, timeoutMs: number) => await new Promise<boolean>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(true);
    return;
  }
  const timer = setTimeout(() => resolve(false), timeoutMs);
  const finish = () => {
    clearTimeout(timer);
    resolve(true);
  };
  child.once("exit", finish);
  child.once("error", finish);
});
