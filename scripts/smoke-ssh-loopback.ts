import { spawn, execFile, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertNoWorkerId } from "./smoke/support/assertions.js";
import { apiJson } from "./smoke/support/http.js";
import { findFreePort } from "./smoke/support/network.js";
import { delay } from "./smoke/support/time.js";

type MachineSummary = {
  machineId: string;
  type?: string;
  name?: string;
  online?: boolean;
  offlineReason?: string;
};

type SshConnection = {
  connectionId: string;
  host: string;
  status: "starting" | "running" | "exited";
  remotePort: number;
  remoteMode?: "bootstrap" | "installed" | "custom";
  remoteClientHash?: string;
  lastOutput?: string;
};

type ProjectThreadStartResponse = {
  result?: {
    sessionId?: string;
    threadId?: string;
    cwd?: string;
  };
};

type SessionState = {
  sessionId: string;
  online?: boolean;
  offlineReason?: string;
};

type ThreadDetail = {
  threadId: string;
  records?: unknown[];
};

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const machineName = "Loopback SSH Smoke";

const main = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-ssh-loopback."));
  const dataDir = path.join(root, "state");
  const projectDir = path.join(root, "project");
  const sshDir = path.join(root, "ssh");
  const codexHomeDir = path.join(root, "codex-home");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(sshDir, { recursive: true });
  await mkdir(codexHomeDir, { recursive: true });

  const sshdPort = await findFreePort();
  const serverPort = await findFreePort();
  const remotePort = await findFreePort();
  const ssh = await prepareLoopbackSsh(sshDir, sshdPort, codexHomeDir);

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_SSH_CONFIG = ssh.clientConfigPath;
  process.env.CODEX_HUB_LOCAL_MACHINE = "0";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "0";
  process.env.TELEGRAM_BOT_TOKEN = "";

  await buildRemoteClient();

  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({ host: "127.0.0.1", port: serverPort });
  const apiBase = `http://127.0.0.1:${serverPort}`;
  let connectionId: string | undefined;

  try {
    await ssh.start();
    console.log(`sshd ok: 127.0.0.1:${sshdPort}`);

    const connected = await apiJson<{ connection?: SshConnection }>(apiBase, "/api/ssh/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: ssh.hostAlias,
        name: machineName,
        remotePort
      })
    });
    assertNoWorkerId(connected, "POST /api/ssh/connect");
    const connection = connected.connection;
    if (!connection?.connectionId) throw new Error("ssh connect did not return a connection id");
    if (connection.remoteMode !== "bootstrap" || !connection.remoteClientHash) {
      throw new Error(`ssh loopback did not use bootstrap remote client: ${JSON.stringify(connection)}`);
    }
    connectionId = connection.connectionId;
    console.log(`ssh tunnel ok: ${connectionId}`);

    const machine = await waitForSshMachine(apiBase);
    console.log(`ssh machine ok: ${machine.machineId}`);

    const open = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: machine.machineId, path: projectDir })
    }, 120_000);
    assertNoWorkerId(open, "/api/projects/open");
    const sessionId = open.result?.sessionId;
    const threadId = open.result?.threadId;
    if (!sessionId || !threadId) throw new Error(`project thread start did not return session/thread: ${JSON.stringify(open)}`);
    if (open.result?.cwd !== projectDir) throw new Error(`remote machine opened unexpected cwd: ${open.result?.cwd}`);
    console.log(`project thread ok: ${sessionId} ${threadId}`);

    const turn = await apiJson(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, input: "/status", source: "web" })
    });
    assertNoWorkerId(turn, "/api/sessions/:sessionId/turn");

    const thread = await waitForThreadRecords(apiBase, threadId, 2);
    assertNoWorkerId(thread, "/api/threads/:threadId");
    console.log("thread flow ok");

    const stopped = await apiJson<{ connection?: SshConnection }>(
      apiBase,
      `/api/ssh/connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" }
    );
    if (stopped.connection?.status !== "exited") {
      throw new Error(`ssh connection did not stop: ${JSON.stringify(stopped.connection)}`);
    }
    connectionId = undefined;
    await waitForMachineOffline(apiBase, machine.machineId);
    await waitForSessionOffline(apiBase, sessionId);
    await waitForNoCodexAppServerForCwd(projectDir);
    console.log("disconnect lifecycle ok");
  } catch (error) {
    await printSshDiagnostics(apiBase, connectionId, ssh.logPath);
    throw error;
  } finally {
    if (connectionId) {
      await apiJson(apiBase, `/api/ssh/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" }).catch(() => undefined);
    }
    await server.stop();
    await ssh.stop();
  }
};

const prepareLoopbackSsh = async (root: string, port: number, codexHomeDir: string) => {
  const user = os.userInfo().username;
  const hostAlias = "codexhub-loopback";
  const clientKeyPath = path.join(root, "client_key");
  const hostKeyPath = path.join(root, "host_key");
  const homeDir = path.join(root, "home");
  const sshHomeDir = path.join(homeDir, ".ssh");
  const authorizedKeysPath = path.join(sshHomeDir, "authorized_keys");
  const serverConfigPath = path.join(root, "sshd_config");
  const clientConfigPath = path.join(root, "ssh_config");
  const logPath = path.join(root, "sshd.log");
  const pidPath = path.join(root, "sshd.pid");

  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKeyPath]);
  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
  await mkdir(sshHomeDir, { recursive: true });
  await chmod(homeDir, 0o700);
  await chmod(sshHomeDir, 0o700);
  await writeFile(authorizedKeysPath, await readFile(`${clientKeyPath}.pub`, "utf8"), "utf8");
  await chmod(clientKeyPath, 0o600);
  await chmod(authorizedKeysPath, 0o600);

  await writeFile(serverConfigPath, [
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKeyPath}`,
    `PidFile ${pidPath}`,
    `AuthorizedKeysFile ${authorizedKeysPath}`,
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    "PubkeyAuthentication yes",
    "UsePAM no",
    `SetEnv CODEX_HOME=${codexHomeDir}`,
    "StrictModes no",
    `AllowUsers ${user}`,
    "LogLevel ERROR",
    ""
  ].join("\n"), "utf8");

  await writeFile(clientConfigPath, [
    `Host ${hostAlias}`,
    "  HostName 127.0.0.1",
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${clientKeyPath}`,
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
    "  PasswordAuthentication no",
    "  LogLevel ERROR",
    ""
  ].join("\n"), "utf8");

  let child: ChildProcess | null = null;
  let output = "";
  return {
    hostAlias,
    clientConfigPath,
    logPath,
    start: async () => {
      child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", serverConfigPath], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      const childRef = child;
      const append = (chunk: Buffer) => {
        output = `${output}${chunk.toString("utf8")}`.slice(-12_000);
        void writeFile(logPath, output, "utf8").catch(() => undefined);
      };
      childRef.stdout?.on("data", append);
      childRef.stderr?.on("data", append);
      await waitForTcpPort(port, () => {
        if (childRef.exitCode !== null || childRef.signalCode !== null) {
          return `sshd exited early: code=${childRef.exitCode} signal=${childRef.signalCode}\n${output}`;
        }
        return null;
      });
    },
    stop: async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      if (!await waitForChildExit(child, 3000)) {
        child.kill("SIGKILL");
        await waitForChildExit(child, 3000);
      }
    }
  };
};

const buildRemoteClient = async () => {
  await execFileAsync("pnpm", ["run", "build:remote-client"], {
    cwd: repoRoot,
    maxBuffer: 2 * 1024 * 1024
  });
};

const waitForSshMachine = async (apiBase: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) => item.type === "ssh" && item.name === machineName && item.online);
    if (machine) return machine;
    await delay(250);
  }
  throw new Error("SSH machine did not register through the reverse tunnel");
};

const waitForMachineOffline = async (apiBase: string, machineId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) => item.machineId === machineId);
    if (machine && !machine.online && machine.offlineReason === "transport_disconnected") return machine;
    await delay(250);
  }
  throw new Error(`SSH machine did not go offline after tunnel stop: ${machineId}`);
};

const waitForSessionOffline = async (apiBase: string, sessionId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const data = await apiJson<{ sessions?: SessionState[] }>(apiBase, "/api/sessions?includeOffline=true").catch(() => ({ sessions: [] }));
    const session = data.sessions?.find((item) => item.sessionId === sessionId);
    if (session && !session.online && session.offlineReason === "transport_disconnected") return session;
    await delay(250);
  }
  throw new Error(`SSH session did not go offline after tunnel stop: ${sessionId}`);
};

const waitForThreadRecords = async (apiBase: string, threadId: string, count: number) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const thread = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    if ((thread.records ?? []).length >= count) return thread;
    await delay(250);
  }
  throw new Error(`thread did not receive ${count} records: ${threadId}`);
};

const printSshDiagnostics = async (apiBase: string, connectionId: string | undefined, logPath: string) => {
  if (connectionId) {
    const data = await apiJson<{ connections?: SshConnection[] }>(apiBase, "/api/ssh/connections").catch(() => null);
    const connection = data?.connections?.find((item) => item.connectionId === connectionId);
    if (connection?.lastOutput) console.error(`ssh connection output:\n${connection.lastOutput}`);
  }
  const log = await readFile(logPath, "utf8").catch(() => "");
  if (log.trim()) console.error(`sshd output:\n${log}`);
};

const waitForNoCodexAppServerForCwd = async (cwd: string) => {
  const startedAt = Date.now();
  let matches: string[] = [];
  while (Date.now() - startedAt < 8000) {
    matches = await codexAppServersForCwd(cwd);
    if (!matches.length) return;
    await delay(250);
  }
  throw new Error(`codex app-server leaked after SSH disconnect:\n${matches.join("\n")}`);
};

const codexAppServersForCwd = async (cwd: string) => {
  if (process.platform !== "linux") return [];
  const entries = await readdir("/proc").catch(() => []);
  const matches: string[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const procCwd = await readlink(`/proc/${entry}/cwd`).catch(() => "");
    if (procCwd !== cwd) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    const command = cmdline.replace(/\0/g, " ").trim();
    if (command.includes("codex app-server")) matches.push(`${entry} ${command}`);
  }
  return matches;
};

const waitForTcpPort = async (port: number, earlyError: () => string | null) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const error = earlyError();
    if (error) throw new Error(error);
    if (await canConnect(port)) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for sshd port ${port}`);
};

const canConnect = async (port: number) => await new Promise<boolean>((resolve) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(500);
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("timeout", () => {
    socket.destroy();
    resolve(false);
  });
  socket.once("error", () => resolve(false));
});

const waitForChildExit = async (child: ChildProcess, timeoutMs: number) =>
  await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
