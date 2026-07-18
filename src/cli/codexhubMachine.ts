import { execFile } from "node:child_process";
import { access, appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket from "ws";
import { AppServerTunnelPeer, isAppServerTunnelFrame } from "../core/appServerTunnel.js";
import { machineTransportUrl, parseMachineTransportMessage } from "../core/machineTransportProtocol.js";
import { SessionTransportPeer } from "../core/sessionTransportPeer.js";
import { createMachineId } from "../core/machineHub.js";
import {
  type MachineCapabilities,
  type MachineCommand,
  type MachineDirectoryListing,
  type MachineGitWorktreeResult,
  type MachineRegistration,
  type MachineRegistrationProject,
  type MachineStartSessionResult,
  type MachineStopSessionResult,
  type MachineType
} from "../shared/machineTypes.js";
import {
  createCodexhubSessionId,
  startCodexAppServerProcess,
  startHeadlessCodexhubSession,
  type HeadlessCodexhubSessionHandle
} from "./codexhubConnect.js";
import type { CodexAppServerLaunchOptions } from "./codexAppServerProcess.js";

const execFileAsync = promisify(execFile);

export type MachineRunnerOptions = {
  apiBase: string;
  authToken?: string;
  machineId?: string;
  type?: MachineType;
  name?: string;
  capabilities?: Partial<MachineCapabilities>;
  appServerLaunch?: CodexAppServerLaunchOptions;
  projects?: MachineRegistrationProject[] | (() => MachineRegistrationProject[]);
  onStatus?: (status: CodexhubMachineStatus) => void;
};

export type CodexhubMachineHandle = {
  machineId: string;
  refreshRegistration: () => void;
  stop: () => Promise<void>;
};

export type CodexhubMachineStatus = {
  status: "starting" | "connecting" | "online" | "offline" | "stopped";
  machineId: string;
  apiBase: string;
  message?: string;
  updatedAt: string;
};

type ManagedSession = {
  session: RuntimeSessionHandle;
  cwd: string;
  projectsByCwd: Map<string, MachineStartSessionResult>;
};

type RuntimeSessionHandle = Pick<HeadlessCodexhubSessionHandle, "sessionId" | "threadId" | "appServerUrl" | "cwd" | "stop" | "wait"> & {
  ensureThread: (threadId: string, cwd: string, commandId?: string) => Promise<string>;
  startThread: (cwd: string, commandId?: string) => Promise<string>;
};

type PendingAppServerAttach = {
  resolve: (value: { sessionId: string; threadId: string }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export const runCodexhubMachine = async (options: MachineRunnerOptions) => {
  const runner = startCodexhubMachine(options);
  await waitForShutdown();
  await runner.stop();
};

export const startCodexhubMachine = (options: MachineRunnerOptions): CodexhubMachineHandle => {
  const runner = new CodexhubMachineRunner(options);
  runner.start();
  return {
    machineId: runner.id,
    refreshRegistration: () => runner.refreshRegistration(),
    stop: () => runner.stop()
  };
};

class CodexhubMachineRunner {
  private readonly machineId: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private registered = false;
  private loopStarted = false;
  private loopPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly lifecycleAbort = new AbortController();
  private commandCursor = 0;
  private commandChain = Promise.resolve();
  private runtimeSession: ManagedSession | null = null;
  private readonly sessionTransports = new Map<string, SessionTransportPeer>();
  private tunnel: AppServerTunnelPeer | null = null;
  private readonly pendingAppServerAttaches = new Map<string, PendingAppServerAttach>();

  constructor(private readonly options: MachineRunnerOptions) {
    this.machineId = options.machineId?.trim() || createMachineId(os.hostname());
  }

  get id() {
    return this.machineId;
  }

  refreshRegistration() {
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN) return;
    this.sendHeartbeat();
  }

  start() {
    if (this.loopStarted) return;
    this.loopStarted = true;
    console.error(`codexhub machine starting: ${this.machineId}`);
    this.updateStatus("starting", "codexhub machine starting");
    this.loopPromise = this.runLoop().catch((error: unknown) => {
      if (this.stopped) return;
      const message = redactMachineRunnerError(errorText(error), this.options.authToken);
      console.error(`codexhub machine offline: ${message}`);
      this.updateStatus("offline", message);
    });
  }

  stop() {
    this.stopPromise ??= this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal() {
    this.stopped = true;
    this.lifecycleAbort.abort();
    await this.stopSessions();
    if (this.registered) {
      this.sendRaw({ type: "unregister" });
      await delay(50);
    }
    this.registered = false;
    this.tunnel?.closeAll();
    this.tunnel = null;
    this.rejectPendingAppServerAttaches(new Error("codexhub machine stopped"));
    this.sessionTransports.clear();
    closeWebSocket(this.ws);
    await this.loopPromise;
    this.updateStatus("stopped", "codexhub machine stopped");
  }

  private async runLoop() {
    while (!this.stopped) {
      try {
        const connectionTarget = publicConnectionTarget(this.options.apiBase);
        console.error(`codexhub machine connecting: ${connectionTarget}`);
        this.updateStatus("connecting", `connecting to ${connectionTarget}`);
        await this.connectOnce();
        if (!this.stopped) {
          console.error("codexhub machine offline: websocket closed");
          this.updateStatus("offline", "websocket closed");
        }
      } catch (error) {
        if (!this.stopped) {
          const message = redactMachineRunnerError(errorText(error), this.options.authToken);
          console.error(`codexhub machine offline: ${message}`);
          this.updateStatus("offline", message);
        }
      } finally {
        if (!this.stopped && this.options.type === "ssh") {
          this.stopped = true;
          await this.stopSessions();
        }
        this.registered = false;
        closeWebSocket(this.ws);
        this.ws = null;
      }
      if (!this.stopped) await abortableDelay(5000, this.lifecycleAbort.signal);
    }
  }

  private async connectOnce() {
    const ws = await openWebSocket(
      machineTransportUrl(this.options.apiBase, this.options.authToken),
      this.lifecycleAbort.signal
    );
    if (this.stopped) {
      closeWebSocket(ws);
      return;
    }
    this.ws = ws;
    const closed = new Deferred<void>();
    const heartbeat = setInterval(() => this.sendHeartbeat(), 10_000);
    heartbeat.unref?.();
    ws.addEventListener("message", (event) => this.handleMessage(event.data));
    ws.addEventListener("error", () => {
      if (!this.stopped) console.error("codexhub machine websocket error");
      ws.close();
    });
    ws.addEventListener("close", () => {
      clearInterval(heartbeat);
      for (const transport of this.sessionTransports.values()) transport.markDisconnected();
      this.tunnel?.closeAll();
      this.tunnel = null;
      this.rejectPendingAppServerAttaches(new Error("codexhub machine websocket closed"));
      closed.resolve();
    }, { once: true });
    this.tunnel = new AppServerTunnelPeer({
      send: (frame) => this.sendRaw(frame),
      label: `codexhub machine ${this.machineId}`
    });
    this.sendRaw({
      type: "register",
      commandCursor: this.commandCursor,
      registration: this.registration()
    });
    await closed.promise;
  }

  private registration(): MachineRegistration {
    const projects = typeof this.options.projects === "function"
      ? this.options.projects()
      : this.options.projects;
    return {
      machineId: this.machineId,
      type: this.options.type ?? "registered",
      name: this.options.name,
      hostname: os.hostname(),
      pid: process.pid,
      platform: `${process.platform}-${process.arch}`,
      cwd: process.cwd(),
      capabilities: { projectLauncher: true, ...this.options.capabilities },
      projects
    };
  }

  private sendHeartbeat() {
    this.sendRaw({ type: "heartbeat", registration: this.registration() });
  }

  private handleMessage(data: unknown) {
    const message = parseMachineTransportMessage(data);
    if (!message) {
      console.error("codexhub machine received invalid message");
      return;
    }
    if (isAppServerTunnelFrame(message)) {
      this.tunnel?.handleFrame(message);
      return;
    }
    if (message.type === "registered") {
      this.registered = true;
      console.error(`codexhub machine connected: ${message.machineId}`);
      this.updateStatus("online", `registered as ${message.machineId}`);
      for (const transport of this.sessionTransports.values()) transport.reconnect();
      return;
    }
    if (message.type === "commands") {
      this.commandCursor = Math.max(this.commandCursor, message.cursor);
      this.enqueueCommands(message.commands);
      return;
    }
    if (message.type === "session_registered" || message.type === "session_commands" || message.type === "session_error") {
      const transport = this.sessionTransports.get(message.sessionId);
      if (!transport) {
        console.error(`codexhub machine received session message for unknown session: ${message.sessionId}`);
        return;
      }
      transport.handleServerMessage(message);
      return;
    }
    if (message.type === "app_server_attached") {
      this.resolvePendingAppServerAttach(message.commandId, {
        sessionId: message.sessionId,
        threadId: message.threadId
      });
      return;
    }
    if (message.type === "app_server_attach_error") {
      this.rejectPendingAppServerAttach(message.commandId, new Error(message.message));
      return;
    }
    console.error(`codexhub machine server error: ${message.message}`);
  }

  private enqueueCommands(commands: MachineCommand[]) {
    this.commandChain = this.commandChain.then(async () => {
      for (const command of commands) {
        try {
          // 这里的 machine command 必须串行执行；commandCursor 只有执行完才能前移。
          const result = await this.runCommand(command);
          this.sendRaw({ type: "command_result", commandId: command.commandId, result });
        } catch (error) {
          this.sendRaw({
            type: "command_error",
            commandId: command.commandId,
            message: errorText(error)
          });
        } finally {
          this.commandCursor = Math.max(this.commandCursor, command.seq);
        }
      }
    }).catch((error) => {
      console.error(`codexhub machine command queue failed: ${errorText(error)}`);
    });
  }

  private async runCommand(command: MachineCommand) {
    if (command.type === "start_session") return await this.startSession(command);
    if (command.type === "list_directory") return await this.listDirectory(command);
    if (command.type === "create_git_worktree") return await this.createGitWorktree(command);
    if (command.type === "stop_session") return await this.stopSession(command);
    throw new Error(`Unexpected command: ${(command as { type?: string }).type ?? "unknown"}`);
  }

  private async startSession(command: MachineCommand): Promise<MachineStartSessionResult> {
    if (command.type !== "start_session") throw new Error(`Unexpected command: ${command.type}`);
    const cwd = await resolveDirectory(command.cwd);
    const requestedThreadId = typeof command.threadId === "string" && command.threadId.trim()
      ? command.threadId.trim()
      : undefined;
    const existing = command.reuse !== false ? this.runtimeSession?.projectsByCwd.get(cwd) : undefined;
    if (existing && (!requestedThreadId || existing.threadId === requestedThreadId)) {
      return {
        ...existing,
        cwd,
        reused: true
      };
    }

    const runtime = await this.ensureRuntimeSession(cwd, command.commandId);
    // 一台 machine 只维护一个 app-server runtime，不同 project cwd 映射到各自 thread。
    const startProjectThread = async () => runtime.projectsByCwd.size === 0 && runtime.cwd === cwd
      ? runtime.session.threadId
      : await runtime.session.startThread(cwd, command.commandId);
    let threadId: string;
    if (requestedThreadId) {
      try {
        threadId = await runtime.session.ensureThread(requestedThreadId, cwd, command.commandId);
      } catch (error) {
        if (!isMissingAppServerThreadError(error)) throw error;
        threadId = await startProjectThread();
      }
    } else {
      threadId = await startProjectThread();
    }
    const result = {
      sessionId: runtime.session.sessionId,
      threadId,
      appServerUrl: runtime.session.appServerUrl,
      cwd
    };
    runtime.projectsByCwd.set(cwd, result);
    return result;
  }

  private async ensureRuntimeSession(cwd: string, commandId: string): Promise<ManagedSession> {
    if (this.runtimeSession) return this.runtimeSession;
    console.error(`codexhub machine app-server starting: ${cwd}`);
    // 已注册 machine 通过 tunnel 暴露本地 app-server；local/ssh machine 直接注册 session。
    const session = this.useAppServerTunnel()
      ? await this.startTunneledRuntimeSession(cwd, commandId)
      : await startHeadlessCodexhubSession({
        apiBase: this.options.apiBase,
        machineId: this.machineId,
        cwd,
        appServerLaunch: this.options.appServerLaunch,
        readyLabel: "codexhub machine app-server ready",
        transportFactory: (context, callbacks) => {
          const transport = new SessionTransportPeer({
            sessionId: context.sessionId,
            send: (message) => this.sendRaw(message),
            callbacks,
            onStop: () => this.sessionTransports.delete(context.sessionId)
          });
          this.sessionTransports.set(context.sessionId, transport);
          return transport;
        }
      });
    const runtime = { session, cwd, projectsByCwd: new Map<string, MachineStartSessionResult>() };
    this.runtimeSession = runtime;
    void session.wait().then(() => {
      if (this.runtimeSession?.session.sessionId === session.sessionId) this.runtimeSession = null;
    }).catch(() => {
      if (this.runtimeSession?.session.sessionId === session.sessionId) this.runtimeSession = null;
    });
    return runtime;
  }

  private useAppServerTunnel() {
    return this.options.type === "registered";
  }

  private async startTunneledRuntimeSession(cwd: string, commandId: string): Promise<RuntimeSessionHandle> {
    const appServer = await startCodexAppServerProcess(cwd, undefined, this.options.appServerLaunch);
    const sessionId = createCodexhubSessionId();
    const appServerId = sessionId;
    // 官方 app-server 仍跑在 registered machine，父 server 只通过 tunnel 访问它。
    this.tunnel?.registerTarget(appServerId, appServer.appServerUrl);
    try {
      const attached = await this.requestParentAppServerAttach({
        type: "app_server_ready",
        commandId,
        sessionId,
        appServerId,
        cwd,
        appServerUrl: appServer.appServerUrl
      });
      return {
        sessionId,
        threadId: attached.threadId,
        appServerUrl: `tunnel://${appServerId}`,
        cwd,
        ensureThread: async (threadId: string, nextCwd: string, nextCommandId?: string) => {
          if (!nextCommandId) throw new Error("Tunneled app-server ensureThread requires a machine command id.");
          const started = await this.requestParentAppServerAttach({
            type: "app_server_start_thread",
            commandId: nextCommandId,
            sessionId,
            cwd: nextCwd,
            threadId
          });
          return started.threadId;
        },
        startThread: async (nextCwd: string, nextCommandId?: string) => {
          if (!nextCommandId) throw new Error("Tunneled app-server startThread requires a machine command id.");
          const started = await this.requestParentAppServerAttach({
            type: "app_server_start_thread",
            commandId: nextCommandId,
            sessionId,
            cwd: nextCwd
          });
          return started.threadId;
        },
        stop: async () => {
          this.tunnel?.unregisterTarget(appServerId);
          this.sendRaw({ type: "app_server_stopped", sessionId });
          await appServer.stop();
        },
        wait: appServer.wait
      };
    } catch (error) {
      this.tunnel?.unregisterTarget(appServerId);
      await appServer.stop();
      throw error;
    }
  }

  private async requestParentAppServerAttach(message: {
    type: "app_server_ready";
    commandId: string;
    sessionId: string;
    appServerId: string;
    cwd: string;
    appServerUrl: string;
  } | {
    type: "app_server_start_thread";
    commandId: string;
    sessionId: string;
    cwd: string;
    threadId?: string;
  }) {
    if (!this.registered) throw new Error("Cannot attach app-server before machine registration.");
    const commandId = message.commandId;
    // 父 server attach 完成后才返回 threadId，避免 path thread bootstrap 先于 ThreadHub 注册完成。
    const promise = new Promise<{ sessionId: string; threadId: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAppServerAttaches.delete(commandId);
        reject(new Error(`Timed out waiting for parent app-server attach: ${commandId}`));
      }, 60_000);
      timer.unref?.();
      this.pendingAppServerAttaches.set(commandId, { resolve, reject, timer });
    });
    this.sendRaw(message);
    return await promise;
  }

  private resolvePendingAppServerAttach(commandId: string, value: { sessionId: string; threadId: string }) {
    const pending = this.pendingAppServerAttaches.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAppServerAttaches.delete(commandId);
    pending.resolve(value);
  }

  private rejectPendingAppServerAttach(commandId: string, error: Error) {
    const pending = this.pendingAppServerAttaches.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAppServerAttaches.delete(commandId);
    pending.reject(error);
  }

  private rejectPendingAppServerAttaches(error: Error) {
    for (const [commandId, pending] of this.pendingAppServerAttaches) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingAppServerAttaches.delete(commandId);
    }
  }

  private findRuntimeProject(sessionId: string) {
    const runtime = this.runtimeSession;
    if (!runtime || runtime.session.sessionId !== sessionId) return null;
    for (const [cwd, result] of runtime.projectsByCwd) {
      if (result.sessionId === sessionId) return { runtime, cwd };
    }
    return {
      runtime,
      cwd: runtime.cwd
    };
  }

  private async stopSession(command: MachineCommand): Promise<MachineStopSessionResult> {
    if (command.type !== "stop_session") throw new Error(`Unexpected command: ${command.type}`);
    const entry = this.findRuntimeProject(command.sessionId);
    if (!entry) return { sessionId: command.sessionId, stopped: false };
    this.runtimeSession = null;
    await entry.runtime.session.stop();
    return {
      sessionId: command.sessionId,
      stopped: true,
      cwd: entry.cwd
    };
  }

  private async listDirectory(command: MachineCommand): Promise<MachineDirectoryListing> {
    if (command.type !== "list_directory") throw new Error(`Unexpected command: ${command.type}`);
    const cwd = await resolveDirectory(command.cwd || os.homedir());
    const entries = await readdir(cwd, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(cwd, entry.name)
      }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    const parent = path.dirname(cwd);
    return {
      cwd,
      parent: parent === cwd ? undefined : parent,
      home: os.homedir(),
      entries: directories
    };
  }

  private async createGitWorktree(command: MachineCommand): Promise<MachineGitWorktreeResult> {
    if (command.type !== "create_git_worktree") throw new Error(`Unexpected command: ${command.type}`);
    const parentCwd = await resolveDirectory(command.parentCwd);
    const branch = normalizeBranchName(command.branch);
    const baseRef = command.baseRef?.trim() || undefined;
    await assertGitRepository(parentCwd);
    const customPath = command.path?.trim();
    const defaultPath = !customPath;
    const targetPath = path.resolve(defaultPath ? defaultWorktreePath(parentCwd, branch) : expandHome(customPath));
    if (defaultPath) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await addGitInfoExclude(parentCwd, ".codexhub/worktrees");
    }
    const branchExists = await gitBranchExists(parentCwd, branch);
    const args = branchExists
      ? ["worktree", "add", targetPath, branch]
      : ["worktree", "add", "-b", branch, targetPath, baseRef ?? "HEAD"];
    await runGit(parentCwd, args);
    const resolvedPath = await resolveDirectory(targetPath);
    return {
      parentCwd,
      path: resolvedPath,
      branch,
      ...(baseRef ? { baseRef } : {}),
      createdBranch: !branchExists
    };
  }

  private sendRaw(message: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private async stopSessions() {
    const runtime = this.runtimeSession;
    this.runtimeSession = null;
    if (runtime) await runtime.session.stop();
  }

  private updateStatus(status: CodexhubMachineStatus["status"], message?: string) {
    this.options.onStatus?.({
      status,
      machineId: this.machineId,
      apiBase: publicConnectionTarget(this.options.apiBase),
      message,
      updatedAt: new Date().toISOString()
    });
  }
}

const resolveDirectory = async (input: string) => {
  const cwd = path.resolve(expandHome(input.trim()));
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  await access(cwd);
  return cwd;
};

const normalizeBranchName = (input: string) => {
  const branch = input.trim();
  if (!branch) throw new Error("Worktree branch is required.");
  if (branch.startsWith("-")) throw new Error("Worktree branch cannot start with '-'.");
  if (branch.includes("..") || branch.includes("@{") || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(branch)) {
    throw new Error(`Invalid git branch name: ${branch}`);
  }
  return branch;
};

const defaultWorktreePath = (parentCwd: string, branch: string) => {
  return path.join(parentCwd, ".codexhub", "worktrees", safePathSegment(branch));
};

const safePathSegment = (value: string) =>
  value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";

const assertGitRepository = async (cwd: string) => {
  await runGit(cwd, ["rev-parse", "--show-toplevel"]);
};

const gitBranchExists = async (cwd: string, branch: string) => {
  try {
    await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
};

const addGitInfoExclude = async (cwd: string, pattern: string) => {
  const rawExcludePath = (await runGit(cwd, ["rev-parse", "--git-path", "info/exclude"])).trim();
  if (!rawExcludePath) return;
  const excludePath = path.isAbsolute(rawExcludePath) ? rawExcludePath : path.resolve(cwd, rawExcludePath);
  await mkdir(path.dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(pattern)) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(excludePath, `${prefix}${pattern}\n`, "utf8");
};

const runGit = async (cwd: string, args: string[]) => {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8
    });
    return typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
  } catch (error) {
    const failure = error as { stderr?: unknown; stdout?: unknown; message?: string };
    const detail = [failure.stderr, failure.stdout, failure.message]
      .map((value) => typeof value === "string" ? value.trim() : "")
      .find(Boolean);
    throw new Error(detail ? `git ${args.join(" ")} failed: ${detail}` : `git ${args.join(" ")} failed`);
  }
};

const expandHome = (input: string) => {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
};

const openWebSocket = async (url: string, signal: AbortSignal) => {
  if (signal.aborted) throw new Error("WebSocket connection aborted");
  const target = publicConnectionTarget(url);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    throw new Error(`WebSocket failed: ${target}`);
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () => {
      closeWebSocket(ws);
      finish(new Error(`WebSocket failed: ${target}`));
    };
    const onClose = () => finish(new Error(`WebSocket closed before opening: ${target}`));
    const onAbort = () => {
      closeWebSocket(ws);
      finish(new Error("WebSocket connection aborted"));
    };
    const timer = setTimeout(() => {
      closeWebSocket(ws);
      finish(new Error(`WebSocket connection timed out: ${target}`));
    }, 15_000);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
    ws.addEventListener("close", onClose, { once: true });
  });
  return ws;
};

const closeWebSocket = (ws: WebSocket | null) => {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.CONNECTING) ws.once("error", () => undefined);
    ws.terminate();
  } catch {
    // The socket may already be fully closed.
  }
};

const publicConnectionTarget = (value: string) => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "CodexHub server";
  }
};

const redactMachineRunnerError = (value: string, authToken: string | undefined) => {
  const token = authToken?.trim();
  if (!token) return value;
  return [token, encodeURIComponent(token)].reduce(
    (message, secret) => secret ? message.replaceAll(secret, "[redacted]") : message,
    value
  );
};

const abortableDelay = async (ms: number, signal: AbortSignal) => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
};

const waitForShutdown = async () => await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
  process.once("SIGHUP", resolve);
});

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveValue!: (value: T | PromiseLike<T>) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolveValue = resolve;
    });
  }

  resolve(value?: T) {
    if (this.settled) return;
    this.settled = true;
    this.resolveValue(value as T);
  }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const isMissingAppServerThreadError = (error: unknown) => {
  const message = errorText(error).toLowerCase();
  return message.includes("no rollout found for thread id")
    || message.includes("thread not found")
    || message.includes("not found for thread id");
};
