import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SshRemoteClientBundle } from "./sshRemoteClient.js";
import type {
  SshMachineConnectInput,
  SshMachineConnection,
  SshMachineRemoteMode
} from "../shared/sshTypes.js";

type SshMachineConnectionState = SshMachineConnection & {
  child: ChildProcess;
};

type SshMachineManagerOptions = {
  localHost: string;
  localPort: number;
  sshConfigPath?: string;
  remoteMode?: SshMachineRemoteMode;
  remoteClient?: Pick<SshRemoteClientBundle, "hash" | "endpointPath">;
  authToken?: string | null;
  onChange?: () => void;
};

const outputLimit = 12_000;
const defaultRemotePath = [
  "$HOME/.nvm/current/bin",
  "$HOME/.nvm/versions/node/v24.15.0/bin",
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
  private readonly connections = new Map<string, SshMachineConnectionState>();

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
    const remoteMode = input.remoteCommand ? "custom" : this.resolveRemoteMode();
    const remoteClientHash = remoteMode === "bootstrap" ? this.options.remoteClient?.hash : undefined;
    const remoteCommand = input.remoteCommand ?? (
      remoteMode === "bootstrap"
        ? sshBootstrapRemoteCommand(remoteApiBase, this.requireRemoteClient(), input, this.options.authToken)
        : installedRemoteCommand(remoteApiBase, input, this.options.authToken)
    );

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

    const connection: SshMachineConnectionState = {
      connectionId,
      host,
      name: input.name,
      remoteMode,
      remoteClientHash,
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

  private async terminate(connection: SshMachineConnectionState) {
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

  private resolveRemoteMode(): SshMachineRemoteMode {
    const mode = this.options.remoteMode ?? "bootstrap";
    if (mode === "installed") return "installed";
    this.requireRemoteClient();
    return "bootstrap";
  }

  private requireRemoteClient() {
    const remoteClient = this.options.remoteClient;
    if (!remoteClient) {
      throw new Error("SSH remote client bundle not found. Run `pnpm build` or set CODEX_HUB_SSH_REMOTE_MODE=installed.");
    }
    return remoteClient;
  }
}

const publicConnection = (connection: SshMachineConnectionState): SshMachineConnection => {
  const { child: _child, ...summary } = connection;
  return summary;
};

const loopbackHost = (host: string) => host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

const randomRemotePort = () => 18_000 + Math.floor(Math.random() * 30_000);

const trimOutput = (value: string) =>
  value.length <= outputLimit ? value : value.slice(value.length - outputLimit);

const installedRemoteCommand = (remoteApiBase: string, input: Pick<SshMachineConnectInput, "name">, authToken?: string | null) => [
  `PATH=${shellDoubleQuote(defaultRemotePath)}`,
  ...(authToken ? [`CODEX_HUB_AUTH_TOKEN=${shellQuote(authToken)}`] : []),
  "codexhub",
  "machine",
  "--server",
  shellQuote(remoteApiBase),
  "--type",
  "ssh",
  ...(input.name ? ["--name", shellQuote(input.name)] : [])
].join(" ");

const sshBootstrapRemoteCommand = (
  remoteApiBase: string,
  remoteClient: Pick<SshRemoteClientBundle, "hash" | "endpointPath">,
  input: Pick<SshMachineConnectInput, "name">,
  authToken?: string | null
) => {
  const clientUrl = `${remoteApiBase}${remoteClient.endpointPath}`;
  const script = [
    "set -eu",
    `PATH=${shellDoubleQuote(defaultRemotePath)}`,
    "export PATH",
    `CODEXHUB_REMOTE_CLIENT_HASH=${shellQuote(remoteClient.hash)}`,
    `CODEXHUB_REMOTE_CLIENT_URL=${shellQuote(clientUrl)}`,
    ...(authToken ? [`CODEX_HUB_AUTH_TOKEN=${shellQuote(authToken)}`] : []),
    `export CODEXHUB_REMOTE_CLIENT_HASH CODEXHUB_REMOTE_CLIENT_URL${authToken ? " CODEX_HUB_AUTH_TOKEN" : ""}`,
    "cache_root=\"${XDG_CACHE_HOME:-$HOME/.cache}/codexhub/remote-client\"",
    "cache_dir=\"$cache_root/$CODEXHUB_REMOTE_CLIENT_HASH\"",
    "client=\"$cache_dir/client.cjs\"",
    "mkdir -p \"$cache_dir\"",
    "chmod 700 \"$cache_root\" \"$cache_dir\" 2>/dev/null || true",
    "if [ ! -s \"$client\" ]; then",
    "  tmp=\"$client.tmp.$$\"",
    "  rm -f \"$tmp\"",
    "  CODEXHUB_REMOTE_CLIENT_TMP=\"$tmp\" node - <<'CODEXHUB_REMOTE_CLIENT_BOOTSTRAP'",
    remoteClientBootstrapNodeScript,
    "CODEXHUB_REMOTE_CLIENT_BOOTSTRAP",
    "  chmod 600 \"$tmp\"",
    "  mv \"$tmp\" \"$client\"",
    "fi",
    [
      "exec",
      "node",
      "\"$client\"",
      "--server",
      shellQuote(remoteApiBase),
      "--type",
      "ssh",
      ...(input.name ? ["--name", shellQuote(input.name)] : [])
    ].join(" ")
  ].join("\n");
  return ["sh", "-lc", shellQuote(script)].join(" ");
};

const remoteClientBootstrapNodeScript = [
  "const fs = require('node:fs');",
  "const { createHash } = require('node:crypto');",
  "const http = require('node:http');",
  "const https = require('node:https');",
  "const url = process.env.CODEXHUB_REMOTE_CLIENT_URL;",
  "const tmp = process.env.CODEXHUB_REMOTE_CLIENT_TMP;",
  "const expectedHash = process.env.CODEXHUB_REMOTE_CLIENT_HASH;",
  "if (!url || !tmp || !expectedHash) throw new Error('missing codexhub remote client bootstrap env');",
  "const transport = url.startsWith('https:') ? https : http;",
  "const fail = (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); };",
  "new Promise((resolve, reject) => {",
  "  const file = fs.createWriteStream(tmp, { mode: 0o600 });",
  "  const hash = createHash('sha256');",
  "  const request = transport.get(url, (response) => {",
  "    if (response.statusCode !== 200) {",
  "      response.resume();",
  "      reject(new Error(`remote client download failed: ${response.statusCode}`));",
  "      return;",
  "    }",
  "    response.on('data', (chunk) => hash.update(chunk));",
  "    response.on('error', reject);",
  "    response.pipe(file);",
  "  });",
  "  request.on('error', reject);",
  "  file.on('error', reject);",
  "  file.on('finish', () => {",
  "    file.close((error) => {",
  "      if (error) { reject(error); return; }",
  "      const actualHash = hash.digest('hex');",
  "      if (actualHash !== expectedHash) {",
  "        reject(new Error(`remote client checksum mismatch: ${actualHash}`));",
  "        return;",
  "      }",
  "      resolve();",
  "    });",
  "  });",
  "}).catch(fail);"
].join("\n");

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
