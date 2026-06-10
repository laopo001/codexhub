import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { access, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { spawn as spawnPty, type IPty } from "node-pty";
import {
  findCodexSessionFile,
  listCodexSessionsForCwd,
  readCodexSessionJsonlLinesFromFile,
  type CodexSessionSummary
} from "../core/codexSession.js";
import type { MachineCommand, MachineRegistration } from "../core/machineHub.js";
import type { ProxyInput } from "../core/proxyInput.js";
import type {
  SessionRegistration,
  ThreadRunOptions,
  WorkerCommand,
  WorkerEventInput,
  WorkerRecordsInput
} from "../core/threadHub.js";

type ConnectOptions = {
  server?: string;
  cd?: string;
  port?: string;
  headless?: boolean;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
};

type ResumeOptions = Omit<ConnectOptions, "headless"> & {
  last?: boolean;
  all?: boolean;
};

type TuiLaunch =
  | { type: "start"; prompt?: string }
  | { type: "resume"; sessionId?: string; prompt?: string; last?: boolean; all?: boolean };

type JsonRecord = Record<string, unknown>;

type PendingRequest = {
  method: string;
  threadId?: string;
  commandId?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type SyncedThread = {
  jsonlPath?: string;
  jsonlLine: number;
  jsonlKnownSize?: number;
  jsonlFileKey?: string;
  jsonlReplayFull: boolean;
  jsonlSyncing: boolean;
  jsonlPending: boolean;
  jsonlWatcher?: FSWatcher;
  jsonlWatcherPath?: string;
  jsonlDebounceTimer?: NodeJS.Timeout;
};

type BridgeState = {
  threadIds: string[];
  currentThreadId?: string;
};

type RuntimeSettings = {
  model?: string | null;
  modelReasoningEffort?: ThreadRunOptions["modelReasoningEffort"] | null;
};

type TurnRuntimeParams = {
  model?: string | null;
  effort?: ThreadRunOptions["modelReasoningEffort"];
};

type MachineTransportMessage =
  | { type: "registered"; machineId: string; machine?: unknown }
  | { type: "commands"; cursor: number; commands: MachineCommand[] }
  | { type: "session_registered"; sessionId: string; session?: unknown }
  | { type: "session_commands"; sessionId: string; cursor: number; commands: WorkerCommand[] }
  | { type: "session_error"; sessionId: string; message: string }
  | { type: "error"; message: string };

type HubTransportSink = {
  sendEvent: (event: WorkerEventInput) => void;
  sendRecords: (records: WorkerRecordsInput) => void;
  sendHeartbeat: (registration: Partial<SessionRegistration>) => void;
};

export type HeadlessSessionTransportContext = {
  sessionId: string;
  apiBase: string;
  machineId?: string;
  cwd: string;
  appServerUrl: string;
};

export type HeadlessSessionTransportCallbacks = {
  registration: () => SessionRegistration;
  handleCommand: (command: WorkerCommand) => Promise<unknown>;
  onState: (state: "connecting" | "online" | "offline", message: string) => void;
};

export type HeadlessSessionTransport = HubTransportSink & {
  start: () => void;
  stop: (options?: { unregister?: boolean }) => void;
};

export type HeadlessSessionTransportFactory = (
  context: HeadlessSessionTransportContext,
  callbacks: HeadlessSessionTransportCallbacks
) => HeadlessSessionTransport;

type BridgeOptions = {
  apiBase: string;
  appServerUrl: string;
  sessionId: string;
  machineId?: string;
  cwd: string;
  ensureCurrentThread?: boolean;
  initialTuiResume?: { threadId?: string };
  acceptTuiCurrentThreadEvents?: boolean;
  readyLabel?: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  transportFactory?: HeadlessSessionTransportFactory;
};

type ProxyBridgeRunnerOptions = BridgeOptions & {
  statusBar?: CodexhubStatusBar | null;
};

export type HeadlessCodexhubSessionOptions = {
  apiBase: string;
  cwd: string;
  machineId?: string;
  port?: number;
  readyLabel?: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  transportFactory?: HeadlessSessionTransportFactory;
};

export type HeadlessCodexhubSessionHandle = {
  sessionId: string;
  threadId: string;
  appServerUrl: string;
  cwd: string;
  ensureThread: (threadId: string) => Promise<string>;
  runTurn: (input: ProxyInput, threadId?: string) => Promise<string>;
  stop: () => Promise<void>;
  wait: () => Promise<ChildExit>;
};

export const registerCodexHubSessionCommands = (program: Command) => {
  program
    .argument("[prompt]", "optional prompt to start the Codex session")
    .option("-C, --cd <dir>", "Codex working directory")
    .option("--port <port>", "local Codex app-server websocket port")
    .option("--headless", "do not launch the official Codex TUI")
    .option("-m, --model <model>", "model for remote turns")
    .option("-s, --sandbox <mode>", "sandbox mode for remote turns")
    .option("-a, --approval-policy <policy>", "approval policy for remote turns")
    .action(async (prompt: string | undefined) => {
      await runCodexhubSession(program, program.opts<ConnectOptions>(), { type: "start", prompt });
    });

  program
    .command("resume")
    .argument("[session]", "Codex session/thread id or thread name")
    .argument("[prompt]", "optional prompt to send after resuming")
    .description("Resume an official Codex session with the codexhub runtime bridge")
    .option("--server <url>", "codexhub server URL")
    .option("-C, --cd <dir>", "Codex working directory")
    .option("--port <port>", "local Codex app-server websocket port")
    .option("--last", "resume the most recent Codex session")
    .option("--all", "show all Codex sessions in the picker")
    .option("-m, --model <model>", "model for remote turns")
    .option("-s, --sandbox <mode>", "sandbox mode for remote turns")
    .option("-a, --approval-policy <policy>", "approval policy for remote turns")
    .action(async (sessionId: string | undefined, prompt: string | undefined, options: ResumeOptions) => {
      await runCodexhubSession(program, options, {
        type: "resume",
        sessionId,
        prompt,
        last: options.last,
        all: options.all
      });
    });
};

async function runCodexhubSession(program: Command, options: ConnectOptions, launch: TuiLaunch) {
  const rootOptions = program.opts<{ server: string }>();
  const apiBase = options.server ?? rootOptions.server;
  const cwd = path.resolve(options.cd ?? process.cwd());
  const port = options.port ? Number(options.port) : await findFreePort();
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${options.port}`);

  const appServerUrl = `ws://127.0.0.1:${port}`;
  const sessionId = createSessionId();
  const machineId = createSessionMachineId(sessionId);
  const appServer = await startCodexAppServer(cwd, appServerUrl, port);
  let bridgeRunner: ProxyBridgeRunner | null = null;
  let tui: CodexTuiPty | null = null;
  let statusBar: CodexhubStatusBar | null = null;
  let cleanedUp = false;
  const appServerStopped = waitForChild(appServer).then(({ code, signal }) => {
    if (!cleanedUp) process.exitCode = code ?? (signal ? 1 : 1);
    return { code, signal };
  });
  const cleanup = cleanupOnce(async () => {
    cleanedUp = true;
    tui?.kill();
    statusBar?.stop();
    await bridgeRunner?.stop();
    await terminateChild(appServer, appServerStopped);
  });
  const onSignal = (signal: NodeJS.Signals) => {
    void cleanup().finally(() => process.exit(signalExitCode(signal)));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  try {
    console.error([
      `codexhub session started: ${sessionId}`,
      `server: ${apiBase} (optional)`,
      `cwd: ${cwd}`,
      `app-server: ${appServerUrl}`
    ].join("\n"));

    statusBar = CodexhubStatusBar.start({ apiBase, sessionId, cwd });
    bridgeRunner = new ProxyBridgeRunner({
      apiBase,
      appServerUrl,
      sessionId,
      machineId,
      cwd,
      ensureCurrentThread: Boolean(options.headless),
      initialTuiResume: launch.type === "resume" ? { threadId: launch.sessionId } : undefined,
      acceptTuiCurrentThreadEvents: !options.headless,
      model: options.model,
      sandbox: options.sandbox,
      approvalPolicy: options.approvalPolicy,
      transportFactory: (_context, callbacks) => new MachineBackedSessionTransport({
        apiBase,
        sessionId: sessionId,
        machineId,
        machineName: `codexhub session ${sessionId.slice(-8)}`,
        cwd
      }, callbacks),
      statusBar
    });
    bridgeRunner.start();

    if (options.headless) {
      await Promise.race([waitForShutdown(), appServerStopped]);
      return;
    }

    // Resume emits one-shot thread notifications. Wait only for the local app-server bridge,
    // never for the optional codexhub server transport, so offline/local-first TUI startup still works.
    await Promise.race([bridgeRunner.waitForLocalAppBridgeReady(), delay(1500)]);
    tui = CodexTuiPty.start(cwd, appServerUrl, launch, statusBar ? {
      reservedRows: () => statusBar?.reservedRows() ?? 0,
      onOutput: () => statusBar?.redrawSoon()
    } : undefined);
    await Promise.race([tui.waitForExit().then(applyPtyExitCode), appServerStopped]);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    await cleanup();
  }
}

export async function startHeadlessCodexhubSession(options: HeadlessCodexhubSessionOptions): Promise<HeadlessCodexhubSessionHandle> {
  const cwd = path.resolve(options.cwd);
  const port = options.port ?? await findFreePort();
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${options.port}`);

  const appServerUrl = `ws://127.0.0.1:${port}`;
  const sessionId = createSessionId();
  const appServer = await startCodexAppServer(cwd, appServerUrl, port);
  const bridgeRunner = new ProxyBridgeRunner({
    apiBase: options.apiBase,
    appServerUrl,
    sessionId,
    machineId: options.machineId,
    cwd,
    ensureCurrentThread: true,
    readyLabel: options.readyLabel,
    model: options.model,
    sandbox: options.sandbox,
    approvalPolicy: options.approvalPolicy,
    transportFactory: options.transportFactory,
    statusBar: null
  });
  const appServerStopped = waitForChild(appServer);
  const cleanup = cleanupOnce(async () => {
    await bridgeRunner.stop();
    await terminateChild(appServer, appServerStopped);
  });

  bridgeRunner.start();
  try {
    const ready = await Promise.race([
      bridgeRunner.waitForReady(),
      appServerStopped.then(({ code, signal }) => {
        throw new Error(`codex app-server exited before headless session was ready: code=${code ?? ""} signal=${signal ?? ""}`);
      })
    ]);
    return {
      sessionId,
      threadId: ready.threadId,
      appServerUrl,
      cwd,
      ensureThread: (threadId: string) => bridgeRunner.ensureThread(threadId),
      runTurn: (input: ProxyInput, threadId?: string) => bridgeRunner.runTurn(input, threadId),
      stop: cleanup,
      wait: () => appServerStopped
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

class ProxyBridgeRunner {
  private bridge: CodexAppServerBridge | null = null;
  private transport: HeadlessSessionTransport | null = null;
  private stopping = false;
  private loopStarted = false;
  private lastState: "offline" | "online" | null = null;
  private lastReadyThreadId: string | null = null;
  private readonly ready = new Deferred<{ sessionId: string; threadId: string }>();
  private readonly localAppBridgeReady = new Deferred<void>();
  private readonly stopped = new Deferred<void>();
  private bridgeState: BridgeState = { threadIds: [] };

  constructor(private readonly options: ProxyBridgeRunnerOptions) {}

  start() {
    if (this.loopStarted) return;
    this.loopStarted = true;
    void this.runLoop();
  }

  async stop() {
    this.stopping = true;
    this.transport?.stop({ unregister: true });
    this.bridge?.close();
    await Promise.race([this.stopped.promise, delay(2000)]);
  }

  waitForReady() {
    return this.ready.promise;
  }

  waitForLocalAppBridgeReady() {
    return this.localAppBridgeReady.promise;
  }

  async ensureThread(threadId: string) {
    const trimmed = threadId.trim();
    if (!trimmed) throw new Error("Missing thread id.");
    if (!this.bridge) throw new Error("codexhub bridge is not connected.");
    const currentThreadId = await this.bridge.ensureThreadCurrent(trimmed);
    this.bridgeState = this.bridge.snapshotState();
    return currentThreadId;
  }

  async runTurn(input: ProxyInput, threadId?: string) {
    if (!this.bridge) throw new Error("codexhub bridge is not connected.");
    const activeThreadId = await this.bridge.runLocalTurn(input, threadId);
    this.bridgeState = this.bridge.snapshotState();
    return activeThreadId;
  }

  private async runLoop() {
    try {
      while (!this.stopping) {
        this.options.statusBar?.setProxyState("connecting");
        try {
          const sink: HubTransportSink = {
            sendEvent: (event) => this.transport?.sendEvent(event),
            sendRecords: (records) => this.transport?.sendRecords(records),
            sendHeartbeat: (registration) => this.transport?.sendHeartbeat(registration)
          };
          this.bridge = await CodexAppServerBridge.connect(this.options, this.bridgeState, sink);
          const callbacks: HeadlessSessionTransportCallbacks = {
            registration: () => {
              this.bridgeState = this.bridge?.snapshotState() ?? this.bridgeState;
              return {
                machineId: this.options.machineId,
                name: sessionDisplayName(this.options.sessionId),
                workingDirectory: this.options.cwd,
                appServerUrl: this.options.appServerUrl,
                pid: process.pid,
                hostname: os.hostname()
              };
            },
            handleCommand: async (command) => {
              if (!this.bridge) throw new Error("codexhub bridge is not connected.");
              const result = await this.bridge.runCommand(command);
              this.bridgeState = this.bridge.snapshotState();
              return result;
            },
            onState: (state, message) => this.setTransportState(state, message)
          };
          const transportContext: HeadlessSessionTransportContext = {
            sessionId: this.options.sessionId,
            apiBase: this.options.apiBase,
            machineId: this.options.machineId,
            cwd: this.options.cwd,
            appServerUrl: this.options.appServerUrl
          };
          this.transport = this.options.transportFactory
            ? this.options.transportFactory(transportContext, callbacks)
            : new MachineBackedSessionTransport({
              apiBase: this.options.apiBase,
              sessionId: this.options.sessionId,
              machineId: this.options.machineId ?? createSessionMachineId(this.options.sessionId),
              machineName: `codexhub session ${this.options.sessionId.slice(-8)}`,
              cwd: this.options.cwd
            }, callbacks);
          this.localAppBridgeReady.resolve();
          if (this.options.ensureCurrentThread) {
            const threadId = await this.bridge.ensureCurrentThread();
            this.bridgeState = this.bridge.snapshotState();
            this.logHeadlessReady(threadId);
            this.ready.resolve({ sessionId: this.options.sessionId, threadId });
          }
          this.transport.start();
          await this.runBridge(this.bridge);
        } catch (error) {
          if (this.stopping) return;
          this.options.statusBar?.setProxyState("offline");
          this.logState("offline", `codexhub local bridge offline: ${errorText(error)}`);
        } finally {
          if (this.bridge) this.bridgeState = this.bridge.snapshotState();
          this.transport?.stop({ unregister: this.stopping });
          this.transport = null;
          this.bridge?.close();
          this.bridge = null;
        }
        if (!this.stopping) await delay(5000);
      }
    } finally {
      this.stopped.resolve();
    }
  }

  private async runBridge(bridge: CodexAppServerBridge) {
    const stopped = new Deferred<void>();
    const fail = (label: string) => (error: unknown) => {
      if (!this.stopping) stopped.reject(new Error(`${label}: ${errorText(error)}`));
    };
    void bridge.runThreadSyncLoop().catch(fail("thread sync"));
    void bridge.runJsonlRecordSyncLoop().catch(fail("jsonl sync"));
    void bridge.runHeartbeatLoop().catch(fail("heartbeat"));
    void bridge.waitForClose().then(() => stopped.reject(new Error("app-server bridge closed")));
    await stopped.promise;
  }

  private setTransportState(state: "connecting" | "online" | "offline", message: string) {
    this.options.statusBar?.setProxyState(state);
    if (state === "connecting") return;
    if (state === "online") this.bridge?.resetServerMirrorState();
    this.logState(state, message);
  }

  private logState(state: "offline" | "online", message: string) {
    if (this.lastState === state) return;
    this.lastState = state;
    console.error(message);
  }

  private logHeadlessReady(threadId: string) {
    if (this.lastReadyThreadId === threadId) return;
    this.lastReadyThreadId = threadId;
    console.error([
      `${this.options.readyLabel ?? "codexhub headless session ready"}:`,
      `  sessionId: ${this.options.sessionId}`,
      `  threadId: ${threadId}`
    ].join("\n"));
  }
}

class MachineBackedSessionTransport implements HeadlessSessionTransport {
  private ws: WebSocket | null = null;
  private stopped = false;
  private loopStarted = false;
  private machineRegistered = false;
  private sessionRegistered = false;
  private machineCursor = 0;
  private sessionCursor = 0;
  private pendingOutgoing: unknown[] = [];
  private sessionCommandChain = Promise.resolve();

  constructor(
    private readonly options: {
      apiBase: string;
      sessionId: string;
      machineId: string;
      machineName: string;
      cwd: string;
    },
    private readonly callbacks: HeadlessSessionTransportCallbacks
  ) {}

  start() {
    if (this.loopStarted) return;
    this.loopStarted = true;
    void this.runLoop();
  }

  stop(options: { unregister?: boolean } = {}) {
    this.stopped = true;
    if (options.unregister && this.ws?.readyState === WebSocket.OPEN) {
      if (this.sessionRegistered) this.sendRaw({ type: "session_unregister", sessionId: this.sessionId });
      if (this.machineRegistered) this.sendRaw({ type: "unregister" });
    }
    this.ws?.close();
    this.ws = null;
    this.pendingOutgoing = [];
  }

  sendEvent(event: WorkerEventInput) {
    this.sendOrQueue({ type: "session_event", sessionId: this.sessionId, event });
  }

  sendRecords(records: WorkerRecordsInput) {
    this.sendOrQueue({ type: "session_records", sessionId: this.sessionId, records });
  }

  sendHeartbeat(registration: Partial<SessionRegistration>) {
    this.sendOrQueue({ type: "session_heartbeat", sessionId: this.sessionId, registration }, { queue: false });
  }

  private get sessionId() {
    return this.options.sessionId;
  }

  private async runLoop() {
    while (!this.stopped) {
      this.callbacks.onState("connecting", `codexhub machine transport connecting: ${this.options.machineId}`);
      try {
        await this.connectOnce();
        if (!this.stopped) this.callbacks.onState("offline", "codexhub machine transport offline: websocket closed");
      } catch (error) {
        if (!this.stopped) this.callbacks.onState("offline", `codexhub machine transport offline: ${errorText(error)}`);
      } finally {
        this.machineRegistered = false;
        this.sessionRegistered = false;
        this.ws?.close();
        this.ws = null;
      }
      if (!this.stopped) await delay(5000);
    }
  }

  private async connectOnce() {
    const ws = await openWebSocket(machineTransportUrl(this.options.apiBase));
    this.ws = ws;
    const closed = new Deferred<void>();
    const heartbeat = setInterval(() => this.sendMachineHeartbeat(), 10_000);
    heartbeat.unref?.();
    ws.addEventListener("message", (event) => this.handleMessage(event.data));
    ws.addEventListener("error", () => {
      if (!this.stopped) console.error("codexhub machine transport websocket error");
      ws.close();
    });
    ws.addEventListener("close", () => {
      clearInterval(heartbeat);
      closed.resolve();
    }, { once: true });
    this.sendRaw({
      type: "register",
      commandCursor: this.machineCursor,
      registration: this.machineRegistration()
    });
    await closed.promise;
  }

  private machineRegistration(): MachineRegistration {
    return {
      machineId: this.options.machineId,
      type: "local",
      name: this.options.machineName,
      hostname: os.hostname(),
      pid: process.pid,
      platform: `${process.platform}-${process.arch}`,
      cwd: this.options.cwd,
      capabilities: { projectLauncher: false }
    };
  }

  private sendMachineHeartbeat() {
    if (!this.machineRegistered) return;
    this.sendRaw({ type: "heartbeat", registration: this.machineRegistration() });
  }

  private handleMessage(data: unknown) {
    const message = parseMachineTransportMessage(data);
    if (!message) {
      console.error("codexhub machine transport received invalid message");
      return;
    }
    if (message.type === "registered") {
      this.machineRegistered = true;
      this.registerSession();
      return;
    }
    if (message.type === "commands") {
      this.machineCursor = Math.max(this.machineCursor, message.cursor);
      this.failUnsupportedMachineCommands(message.commands);
      return;
    }
    if (message.type === "session_registered") {
      this.sessionRegistered = true;
      this.callbacks.onState("online", `codexhub session connected through machine: ${message.sessionId}`);
      this.flushPending();
      return;
    }
    if (message.type === "session_commands") {
      if (message.sessionId !== this.sessionId) return;
      this.sessionCursor = Math.max(this.sessionCursor, message.cursor);
      this.enqueueSessionCommands(message.commands);
      return;
    }
    if (message.type === "session_error") {
      console.error(`codexhub machine session server error: ${message.message}`);
      return;
    }
    console.error(`codexhub machine transport server error: ${message.message}`);
  }

  private registerSession() {
    if (!this.machineRegistered) return;
    this.callbacks.onState("connecting", `codexhub session registering through machine: ${this.sessionId}`);
    this.sendRaw({
      type: "session_register",
      sessionId: this.sessionId,
      commandCursor: this.sessionCursor,
      registration: this.callbacks.registration()
    });
  }

  private failUnsupportedMachineCommands(commands: MachineCommand[]) {
    for (const command of commands) {
      this.sendRaw({
        type: "command_error",
        commandId: command.commandId,
        message: "This foreground Codex session is not a project launcher. Run `codexhub machine` for project browsing."
      });
      this.machineCursor = Math.max(this.machineCursor, command.seq);
    }
  }

  private enqueueSessionCommands(commands: WorkerCommand[]) {
    this.sessionCommandChain = this.sessionCommandChain.then(async () => {
      for (const command of commands) {
        try {
          const result = await this.callbacks.handleCommand(command);
          if (result !== undefined) {
            this.sendOrQueue({
              type: "session_command_result",
              sessionId: this.sessionId,
              commandId: command.commandId,
              result
            });
          }
        } catch (error) {
          this.sendOrQueue({
            type: "session_command_error",
            sessionId: this.sessionId,
            commandId: command.commandId,
            message: errorText(error)
          });
        } finally {
          this.sessionCursor = Math.max(this.sessionCursor, command.seq);
        }
      }
    }).catch((error) => {
      console.error(`codexhub machine session command queue failed: ${errorText(error)}`);
    });
  }

  private flushPending() {
    for (const message of this.pendingOutgoing.splice(0)) this.sendRaw(message);
  }

  private sendOrQueue(message: unknown, options: { queue?: boolean } = {}) {
    if (this.sessionRegistered && this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw(message);
      return;
    }
    if (options.queue === false) return;
    this.pendingOutgoing.push(message);
    if (this.pendingOutgoing.length > 1000) this.pendingOutgoing.splice(0, this.pendingOutgoing.length - 1000);
  }

  private sendRaw(message: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }
}

class CodexAppServerBridge {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly syncedThreads = new Map<string, SyncedThread>();
  private readonly loadedThreads = new Set<string>();
  private nextId = 1;
  private closed = false;
  private currentThreadId: string | undefined;
  private readonly forwardedRuntimeSettings = new Map<string, string>();
  private readonly bridgeStartedThreads = new Set<string>();
  private bridgeStartedUnknownCount = 0;
  private initialTuiResumeCurrentPending: boolean;
  private readonly closeSignal = new Deferred<void>();

  private constructor(
    private readonly options: BridgeOptions,
    private readonly ws: WebSocket,
    initialState: BridgeState,
    private readonly hub: HubTransportSink
  ) {
    this.currentThreadId = initialState.currentThreadId;
    this.initialTuiResumeCurrentPending = Boolean(options.initialTuiResume);
    for (const threadId of initialState.threadIds) this.bindThread(threadId);
  }

  static async connect(options: BridgeOptions, initialState: BridgeState = { threadIds: [] }, hub: HubTransportSink) {
    const ws = await openWebSocket(options.appServerUrl);
    const bridge = new CodexAppServerBridge(options, ws, initialState, hub);
    ws.addEventListener("message", (event) => void bridge.handleMessage(event.data));
    ws.addEventListener("error", () => {
      if (!bridge.closed) console.error("codex app-server websocket error");
    });
    ws.addEventListener("close", () => bridge.markClosed());
    await bridge.request("initialize", {
      clientInfo: { name: "codexhub", title: "codexhub bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    bridge.notify("initialized");
    return bridge;
  }

  snapshotState(): BridgeState {
    return {
      threadIds: [...this.syncedThreads.keys()],
      currentThreadId: this.currentThreadId
    };
  }

  async ensureCurrentThread() {
    if (this.currentThreadId) {
      const threadId = await this.ensureThreadLoaded(this.currentThreadId, this.options.cwd, this.options.model);
      await this.forwardCurrentThreadChanged(threadId);
      return threadId;
    }
    const result = asRecord(await this.request("thread/start", {
      cwd: this.options.cwd,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...runtimePermissionParams(this.options),
      threadSource: "user"
    }));
    const thread = asRecord(result?.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex app-server thread/start did not return thread.id");
    this.markThreadLoaded(threadId);
    await this.forwardCurrentThreadChanged(threadId);
    return threadId;
  }

  async ensureThreadCurrent(threadId: string) {
    const currentThreadId = await this.ensureThreadLoaded(threadId, this.options.cwd, this.options.model, { threadId });
    await this.forwardCurrentThreadChanged(currentThreadId);
    return currentThreadId;
  }

  async runCommand(command: WorkerCommand) {
    return await this.handleCommand(command);
  }

  async runLocalTurn(input: ProxyInput, threadId?: string) {
    const targetThreadId = threadId
      ? await this.ensureThreadLoaded(threadId, this.options.cwd, this.options.model, undefined, {
        markBridgeStarted: true
      })
      : await this.ensureCurrentThread();
    this.markBridgeStartedThread(targetThreadId);
    await this.request("turn/start", {
      threadId: targetThreadId,
      input: toAppServerInput(input),
      ...turnRuntimeParams(undefined)
    }, { threadId: targetThreadId });
    return targetThreadId;
  }

  async runHeartbeatLoop(intervalMs = 10_000) {
    while (!this.closed) {
      await this.heartbeat();
      await delay(intervalMs);
    }
  }

  async runThreadSyncLoop() {
    while (!this.closed) {
      await delay(1500);
      if (this.closed) return;
      const entries = [...this.syncedThreads];
      await this.syncRuntimeSettings(entries.map(([threadId]) => threadId));
    }
  }

  async runJsonlRecordSyncLoop(intervalMs = 2000) {
    while (!this.closed) {
      await this.syncJsonlRecords();
      await delay(intervalMs);
    }
  }

  close() {
    this.markClosed();
    this.ws.close();
  }

  waitForClose() {
    return this.closeSignal.promise;
  }

  private markClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.syncedThreads.values()) this.closeJsonlWatcher(state);
    this.closeSignal.resolve();
  }

  private async handleCommand(command: WorkerCommand) {
    if (command.type === "list_threads") {
      return {
        threads: await listCodexSessionsForCwd(command.workingDirectory, { limit: command.limit })
      };
    }

    if (command.type === "observe_thread_records") {
      if (!command.threadId) throw new Error("observe_thread_records command requires threadId");
      this.bindThread(command.threadId);
      return;
    }

    if (command.type === "unobserve_thread_records") {
      if (!command.threadId) throw new Error("unobserve_thread_records command requires threadId");
      this.unbindThread(command.threadId);
      return;
    }

    if (command.type === "start_thread") {
      const threadId = await this.startNewThread(
        command.workingDirectory,
        commandModel(command.options, this.options.model),
        command
      );
      return { threadId };
    }

    if (command.type === "resume_thread") {
      if (!command.threadId) throw new Error("resume_thread command requires threadId");
      const threadId = await this.ensureThreadLoaded(
        command.threadId,
        command.workingDirectory,
        commandModel(command.options, this.options.model),
        command,
        { markBridgeStarted: true }
      );
      await this.forwardCurrentThreadChanged(threadId);
      return { threadId };
    }

    if (command.type === "stop") {
      if (command.threadId && command.turnId) {
        await this.ensureThreadLoaded(command.threadId, command.workingDirectory, commandModel(command.options, this.options.model), undefined, {
          markBridgeStarted: true
        });
        await this.request("turn/interrupt", {
          threadId: command.threadId,
          turnId: command.turnId
        }, command);
      }
      return;
    }

    if (command.type === "steer") {
      if (!command.threadId) throw new Error("steer command requires threadId");
      if (!command.turnId) throw new Error("steer command requires active turnId");
      if (!command.input) throw new Error("steer command requires input");
      const threadId = await this.ensureThreadLoaded(
        command.threadId,
        command.workingDirectory,
        commandModel(command.options, this.options.model),
        undefined,
        { markBridgeStarted: true }
      );
      await this.request("turn/steer", {
        threadId,
        expectedTurnId: command.turnId,
        input: toAppServerInput(command.input)
      }, command);
      return;
    }

    if (command.type === "fork_thread") {
      if (!command.threadId) throw new Error("fork_thread command requires threadId");
      const model = commandModel(command.options, this.options.model);
      await this.ensureThreadLoaded(command.threadId, command.workingDirectory, model, undefined, {
        markBridgeStarted: true
      });
      this.markBridgeStartedUnknownThread();
      const result = asRecord(await this.request("thread/fork", {
        threadId: command.threadId,
        cwd: command.workingDirectory,
        ...(model === undefined ? {} : { model }),
        ...runtimePermissionParams(this.options),
        threadSource: "user"
      }, command));
      const thread = asRecord(result?.thread);
      const threadId = typeof thread?.id === "string" ? thread.id : undefined;
      if (!threadId) throw new Error("Codex app-server thread/fork did not return thread.id");
      this.markThreadLoaded(threadId);
      return;
    }

    if (command.type === "rollback_thread") {
      if (!command.threadId) throw new Error("rollback_thread command requires threadId");
      if (!command.numTurns || command.numTurns < 1) throw new Error("rollback_thread command requires numTurns >= 1");
      await this.ensureThreadLoaded(command.threadId, command.workingDirectory, commandModel(command.options, this.options.model), undefined, {
        markBridgeStarted: true
      });
      await this.request("thread/rollback", {
        threadId: command.threadId,
        numTurns: command.numTurns
      }, command);
      this.resetJsonlCursor(command.threadId);
      return;
    }

    if (!command.input || !command.threadId) return;
    const threadId = command.threadId;
    const model = commandModel(command.options, this.options.model);
    const loadedThreadId = await this.ensureThreadLoaded(threadId, command.workingDirectory, model, command, {
      markBridgeStarted: true
    });
    await this.applyGoalMode(loadedThreadId, command.input, command.options);
    this.markBridgeStartedThread(loadedThreadId);
    await this.request("turn/start", {
      threadId: loadedThreadId,
      input: toAppServerInput(inputForCollaborationMode(command.input, command.options)),
      ...turnRuntimeParams(command.options)
    }, command);
  }

  private async applyGoalMode(threadId: string, input: ProxyInput, options: ThreadRunOptions | undefined) {
    if (!options?.goalMode) return;
    await this.request("thread/goal/set", {
      threadId,
      objective: goalObjective(input, options),
      status: "active",
      ...(hasOwn(options, "goalTokenBudget") ? { tokenBudget: options.goalTokenBudget } : {})
    }, { threadId });
  }

  private async startNewThread(
    cwd: string,
    model: string | null | undefined,
    command: { commandId?: string; threadId?: string }
  ) {
    const result = asRecord(await this.request("thread/start", {
      cwd,
      ...(model === undefined ? {} : { model }),
      ...runtimePermissionParams(this.options),
      threadSource: "user"
    }, command));
    const thread = asRecord(result?.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex app-server thread/start did not return thread.id");
    this.markThreadLoaded(threadId);
    await this.forwardCurrentThreadChanged(threadId);
    return threadId;
  }

  private request(method: string, params: unknown, command?: { threadId?: string; commandId?: string }) {
    const id = this.nextId++;
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        method,
        threadId: command?.threadId,
        commandId: command?.commandId,
        resolve,
        reject
      });
      this.ws.send(JSON.stringify(message));
    });
  }

  private notify(method: string, params?: unknown) {
    this.ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  private async handleMessage(data: unknown) {
    const message = parseJsonRecord(data);
    if (!message) return;

    if ((typeof message.id === "string" || typeof message.id === "number") && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      this.rememberThreads(message);
      const error = asRecord(message.error);
      const threadId = threadIdForPendingMessage(pending, message);
      if (threadId && (!error || pending.method !== "thread/read")) {
        await this.forwardThreadEvent(threadId, pending.commandId, message, { heartbeat: pending.method !== "thread/read" });
        if (!error) await this.forwardExecutionStateFromMessage(threadId, message);
      }
      if (error) pending.reject(new Error(JSON.stringify(error)));
      else {
        this.rememberLoadedThread(pending, message);
        pending.resolve(message.result);
      }
      return;
    }

    if ((typeof message.id === "string" || typeof message.id === "number") && typeof message.method === "string") {
      this.respondToServerRequest(message);
      return;
    }

    const threadId = this.threadIdForMessage(message);
    if (threadId) {
      await this.forwardStateEventsFromMessage(threadId, message);
      await this.forwardThreadEvent(threadId, undefined, message);
    }
  }

  private rememberThreads(message: JsonRecord) {
    const result = asRecord(message.result);
    const resultThread = asRecord(result?.thread);
    if (typeof resultThread?.id === "string") this.loadedThreads.add(resultThread.id);
  }

  private rememberLoadedThread(pending: PendingRequest, message: JsonRecord) {
    if (pending.method !== "thread/start" && pending.method !== "thread/resume" && pending.method !== "thread/fork") return;
    const threadId = resultThreadIdForMessage(message) ?? pending.threadId;
    if (threadId) {
      this.markThreadLoaded(threadId);
    }
  }

  private threadIdForMessage(message: JsonRecord) {
    const threadId = threadIdForMessage(message);
    if (!threadId) return undefined;
    return threadId;
  }

  private bindThread(threadId: string) {
    if (this.syncedThreads.has(threadId)) return;
    this.syncedThreads.set(threadId, {
      jsonlLine: 0,
      jsonlReplayFull: true,
      jsonlSyncing: false,
      jsonlPending: false
    });
    this.scheduleJsonlSync(threadId, { replayFull: true });
  }

  private unbindThread(threadId: string) {
    const state = this.syncedThreads.get(threadId);
    if (!state) return;
    this.closeJsonlWatcher(state);
    this.syncedThreads.delete(threadId);
    this.forwardedRuntimeSettings.delete(threadId);
  }

  private markThreadLoaded(threadId: string) {
    this.loadedThreads.add(threadId);
  }

  private resetJsonlCursor(threadId: string) {
    const state = this.syncedThreads.get(threadId);
    if (!state) return;
    state.jsonlPath = undefined;
    state.jsonlLine = 0;
    state.jsonlKnownSize = undefined;
    state.jsonlFileKey = undefined;
    state.jsonlReplayFull = true;
    this.closeJsonlWatcher(state);
    this.scheduleJsonlSync(threadId, { replayFull: true });
  }

  private async ensureThreadLoaded(
    threadId: string,
    cwd: string,
    model?: string | null,
    command?: { threadId?: string; commandId?: string },
    options: { markBridgeStarted?: boolean } = {}
  ) {
    if (this.loadedThreads.has(threadId)) return threadId;
    if (options.markBridgeStarted) this.markBridgeStartedThread(threadId);
    const result = asRecord(await this.request("thread/resume", {
      threadId,
      cwd,
      ...(model === undefined ? {} : { model }),
      ...runtimePermissionParams(this.options)
    }, command));
    const thread = asRecord(result?.thread);
    const loadedThreadId = typeof thread?.id === "string" ? thread.id : threadId;
    this.markThreadLoaded(loadedThreadId);
    return loadedThreadId;
  }

  private async syncJsonlRecords() {
    await Promise.all([...this.syncedThreads.keys()].map((threadId) => this.syncThreadJsonl(threadId)));
  }

  private scheduleJsonlSync(
    threadId: string,
    options: { replayFull?: boolean; delayMs?: number } = {}
  ) {
    const state = this.syncedThreads.get(threadId);
    if (!state || this.closed) return;
    if (options.replayFull) state.jsonlReplayFull = true;
    if (state.jsonlDebounceTimer) clearTimeout(state.jsonlDebounceTimer);
    state.jsonlDebounceTimer = setTimeout(() => {
      state.jsonlDebounceTimer = undefined;
      void this.syncThreadJsonl(threadId).catch((error) => {
        console.error(`codexhub bridge failed to sync JSONL for ${threadId}: ${errorText(error)}`);
      });
    }, options.delayMs ?? 75);
    state.jsonlDebounceTimer.unref?.();
  }

  private async syncThreadJsonl(threadId: string) {
    const state = this.syncedThreads.get(threadId);
    if (!state || this.closed) return;
    const stillObserved = () => this.syncedThreads.get(threadId) === state && !this.closed;
    if (state.jsonlSyncing) {
      state.jsonlPending = true;
      return;
    }

    state.jsonlSyncing = true;
    state.jsonlPending = false;
    try {
      const filePath = await findCodexSessionFile(threadId);
      if (!stillObserved()) return;
      if (!filePath) return;
      const currentStat = await stat(filePath).catch(() => null);
      if (!stillObserved()) return;
      const fileKey = currentStat ? `${currentStat.dev}:${currentStat.ino}` : undefined;
      const pathChanged = Boolean(state.jsonlPath && state.jsonlPath !== filePath);
      const fileReplaced = Boolean(state.jsonlFileKey && fileKey && state.jsonlFileKey !== fileKey);
      const truncated = typeof state.jsonlKnownSize === "number"
        && currentStat
        && currentStat.size < state.jsonlKnownSize;
      const replace = !state.jsonlPath || pathChanged || fileReplaced || truncated || state.jsonlReplayFull;
      const afterLine = replace ? 0 : state.jsonlLine;
      const batch = await readCodexSessionJsonlLinesFromFile(filePath, { afterLine });
      if (!stillObserved()) return;
      if (replace || batch.lines.length) {
        this.hub.sendRecords({
          threadId,
          mode: replace ? "replace" : "append",
          path: batch.path,
          lastLine: batch.lastLine,
          lines: batch.lines,
          heartbeat: false
        });
      }
      state.jsonlPath = batch.path;
      state.jsonlLine = batch.lastLine;
      state.jsonlKnownSize = currentStat?.size;
      state.jsonlFileKey = fileKey;
      state.jsonlReplayFull = false;
      this.ensureJsonlWatcher(threadId, batch.path);
    } finally {
      state.jsonlSyncing = false;
      if (state.jsonlPending && !this.closed) this.scheduleJsonlSync(threadId);
    }
  }

  private ensureJsonlWatcher(threadId: string, filePath: string) {
    const state = this.syncedThreads.get(threadId);
    if (!state || state.jsonlWatcherPath === filePath && state.jsonlWatcher) return;
    this.closeJsonlWatcher(state);
    try {
      state.jsonlWatcher = watch(filePath, { persistent: false }, () => this.scheduleJsonlSync(threadId));
      state.jsonlWatcherPath = filePath;
      state.jsonlWatcher.on("error", () => {
        this.closeJsonlWatcher(state);
        this.scheduleJsonlSync(threadId, { replayFull: true, delayMs: 250 });
      });
    } catch {
      state.jsonlWatcher = undefined;
    }
  }

  private closeJsonlWatcher(state: SyncedThread) {
    if (state.jsonlDebounceTimer) clearTimeout(state.jsonlDebounceTimer);
    state.jsonlDebounceTimer = undefined;
    state.jsonlWatcher?.close();
    state.jsonlWatcher = undefined;
    state.jsonlWatcherPath = undefined;
  }

  private async listAppServerThreads(workingDirectory: string, limit?: number): Promise<CodexSessionSummary[]> {
    const result = asRecord(await this.request("thread/list", {
      cwd: workingDirectory,
      limit: Number.isInteger(limit) && limit !== undefined && limit > 0 ? limit : null,
      sortKey: "updated_at",
      sortDirection: "desc"
    }));
    const data = Array.isArray(result?.data) ? result.data : [];
    return data
      .map((thread) => appServerThreadSummary(asRecord(thread), workingDirectory))
      .filter((thread): thread is CodexSessionSummary => Boolean(thread));
  }

  resetServerMirrorState() {
    this.forwardedRuntimeSettings.clear();
    for (const [threadId, state] of this.syncedThreads) {
      state.jsonlPath = undefined;
      state.jsonlLine = 0;
      state.jsonlKnownSize = undefined;
      state.jsonlFileKey = undefined;
      state.jsonlReplayFull = true;
      this.closeJsonlWatcher(state);
      this.scheduleJsonlSync(threadId, { replayFull: true });
    }
  }

  private async syncRuntimeSettings(threadIds: string[]) {
    if (!threadIds.length) return;
    try {
      const settings = await this.readRuntimeSettings();
      const snapshot = JSON.stringify(settings);
      await Promise.all(threadIds.map(async (threadId) => {
        if (this.forwardedRuntimeSettings.get(threadId) === snapshot) return;
        this.forwardedRuntimeSettings.set(threadId, snapshot);
        await this.forwardRuntimeSettings(threadId, settings);
      }));
    } catch (error) {
      console.error(`codexhub bridge failed to sync runtime settings: ${errorText(error)}`);
    }
  }

  private async readRuntimeSettings(): Promise<RuntimeSettings> {
    const result = asRecord(await this.request("config/read", {
      cwd: this.options.cwd,
      includeLayers: false
    }));
    const config = asRecord(result?.config);
    const model = config?.model;
    const modelReasoningEffort = config?.model_reasoning_effort;
    return {
      model: typeof model === "string" && model ? model : null,
      modelReasoningEffort: isModelReasoningEffort(modelReasoningEffort) ? modelReasoningEffort : null
    };
  }

  private async forwardThreadEvent(
    threadId: string,
    commandId: string | undefined,
    message: JsonRecord,
    options: { heartbeat?: boolean } = {}
  ) {
    this.hub.sendEvent({ type: "thread_event", threadId, commandId, message, heartbeat: options.heartbeat });
  }

  private async forwardStateEventsFromMessage(threadId: string, message: JsonRecord) {
    const method = typeof message.method === "string" ? message.method : "";
    if (method === "thread/started") {
      this.markThreadLoaded(threadId);
      if (this.bridgeStartedThreads.has(threadId)) {
        this.bridgeStartedThreads.delete(threadId);
      } else if (this.bridgeStartedUnknownCount > 0) {
        this.bridgeStartedUnknownCount -= 1;
      } else {
        await this.forwardCurrentThreadChanged(threadId);
      }
    }
    if (this.shouldForwardTuiResumeCurrent(method, threadId)) {
      await this.forwardCurrentThreadChanged(threadId);
    }
    await this.forwardExecutionStateFromMessage(threadId, message);

    if (method !== "thread/settings/updated") return;
    const params = asRecord(message.params);
    const settings = asRecord(params?.threadSettings) ?? asRecord(params?.settings);
    if (!settings) return;
    await this.forwardRuntimeSettings(threadId, {
      model: typeof settings.model === "string" && settings.model ? settings.model : null,
      modelReasoningEffort: isModelReasoningEffort(settings.effort)
        ? settings.effort
        : isModelReasoningEffort(settings.modelReasoningEffort)
          ? settings.modelReasoningEffort
          : null
    });
  }

  private async forwardExecutionStateFromMessage(threadId: string, message: JsonRecord) {
    const method = typeof message.method === "string" ? message.method : "";
    const params = asRecord(message.params);
    if (method === "turn/started") {
      const turn = asRecord(params?.turn);
      await this.forwardThreadExecutionChanged(threadId, true, typeof turn?.id === "string" ? turn.id : undefined);
      return;
    }
    if (method === "turn/completed") {
      await this.forwardThreadExecutionChanged(threadId, false);
      return;
    }
    if (method === "thread/status/changed") {
      const thread = asRecord(params?.thread);
      const status = asRecord(params?.status) ?? asRecord(thread?.status);
      const type = typeof status?.type === "string" ? status.type : "";
      if (type === "active" || type === "running") {
        await this.forwardThreadExecutionChanged(threadId, true);
        return;
      }
      if (type === "idle" || type === "complete" || type === "completed") {
        await this.forwardThreadExecutionChanged(threadId, false);
      }
    }
  }

  private async forwardCurrentThreadChanged(threadId: string, _heartbeat = false) {
    if (this.currentThreadId === threadId) return;
    this.currentThreadId = threadId;
  }

  private shouldForwardTuiResumeCurrent(method: string, threadId: string) {
    if (!this.options.acceptTuiCurrentThreadEvents) return false;
    if (this.bridgeStartedThreads.has(threadId) || this.bridgeStartedUnknownCount > 0) return false;

    if (this.initialTuiResumeCurrentPending && isInitialTuiResumeCurrentMethod(method)) {
      const hintedThreadId = this.options.initialTuiResume?.threadId?.trim();
      if (hintedThreadId && hintedThreadId !== threadId) return false;
      this.initialTuiResumeCurrentPending = false;
      return true;
    }

    return Boolean(this.currentThreadId)
      && this.currentThreadId !== threadId
      && isTuiResumeCurrentMethod(method);
  }

  private markBridgeStartedThread(threadId: string) {
    this.bridgeStartedThreads.add(threadId);
    const timer = setTimeout(() => this.bridgeStartedThreads.delete(threadId), 30_000);
    timer.unref?.();
  }

  private markBridgeStartedUnknownThread() {
    this.bridgeStartedUnknownCount += 1;
    const timer = setTimeout(() => {
      this.bridgeStartedUnknownCount = Math.max(0, this.bridgeStartedUnknownCount - 1);
    }, 30_000);
    timer.unref?.();
  }

  private async forwardThreadExecutionChanged(threadId: string, running: boolean, turnId?: string) {
    this.hub.sendEvent({ type: "thread_execution_changed", threadId, running, turnId, heartbeat: false });
  }

  private async forwardRuntimeSettings(threadId: string, settings: RuntimeSettings) {
    this.hub.sendEvent({
      type: "runtime_settings_changed",
      threadId,
      model: settings.model,
      modelReasoningEffort: settings.modelReasoningEffort,
      heartbeat: false
    });
  }

  private respondToServerRequest(message: JsonRecord) {
    const method = typeof message.method === "string" ? message.method : "";
    const id = message.id;
    if (method === "item/commandExecution/requestApproval") {
      this.ws.send(JSON.stringify({ id, result: { decision: "decline" } }));
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      this.ws.send(JSON.stringify({ id, result: { decision: "decline" } }));
      return;
    }
    if (method === "execCommandApproval") {
      this.ws.send(JSON.stringify({ id, result: { decision: "denied" } }));
      return;
    }
    if (method === "applyPatchApproval") {
      this.ws.send(JSON.stringify({ id, result: { decision: "denied" } }));
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.ws.send(JSON.stringify({ id, result: { answers: {} } }));
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.ws.send(JSON.stringify({ id, result: { action: "cancel", content: null, _meta: null } }));
      return;
    }
    this.ws.send(JSON.stringify({
      id,
      error: {
        code: -32601,
        message: `codexhub bridge does not handle app-server request: ${method}`
      }
    }));
  }

  private async heartbeat() {
    this.hub.sendHeartbeat({
      workingDirectory: this.options.cwd,
      appServerUrl: this.options.appServerUrl,
      pid: process.pid,
      hostname: os.hostname()
    });
  }

}

class CodexTuiPty {
  private readonly exitSignal = new Deferred<PtyExit>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private rawModeEnabled = false;
  private exited = false;

  private constructor(
    private readonly pty: IPty,
    private readonly chrome?: PtyChrome
  ) {}

  static start(cwd: string, appServerUrl: string, launch: TuiLaunch, chrome?: PtyChrome) {
    const term = terminalName();
    const pty = spawnPty("codex", codexTuiArgs(cwd, appServerUrl, launch), {
      cwd,
      name: term,
      cols: process.stdout.columns ?? 80,
      rows: terminalRows(chrome?.reservedRows() ?? 0),
      env: { ...process.env, TERM: term }
    });
    const wrapper = new CodexTuiPty(pty, chrome);
    wrapper.attach();
    return wrapper;
  }

  waitForExit() {
    return this.exitSignal.promise;
  }

  kill() {
    this.restoreTerminal();
    if (!this.exited) {
      try {
        this.pty.kill();
      } catch {
        // The child may already be gone; cleanup must still unregister the session.
      }
    }
  }

  private attach() {
    this.disposables.push(this.pty.onData((data) => {
      process.stdout.write(data);
      this.chrome?.onOutput();
    }));
    this.disposables.push(this.pty.onExit((event) => {
      this.exited = true;
      this.restoreTerminal();
      this.exitSignal.resolve(event);
    }));

    const onInput = (data: Buffer) => {
      this.pty.write(data);
    };
    process.stdin.on("data", onInput);
    this.disposables.push({ dispose: () => process.stdin.off("data", onInput) });

    const onResize = () => {
      this.resize();
    };
    process.stdout.on("resize", onResize);
    this.disposables.push({ dispose: () => process.stdout.off("resize", onResize) });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      this.rawModeEnabled = true;
    }
    process.stdin.resume();
    this.resize();
  }

  private resize() {
    this.pty.resize(Math.max(process.stdout.columns ?? 80, 2), terminalRows(this.chrome?.reservedRows() ?? 0));
  }

  private restoreTerminal() {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    if (this.rawModeEnabled && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      this.rawModeEnabled = false;
    }
  }
}

function codexTuiArgs(cwd: string, appServerUrl: string, launch: TuiLaunch) {
  if (launch.type === "start") {
    const args = ["--remote", appServerUrl, "-C", cwd];
    if (launch.prompt) args.push(launch.prompt);
    return args;
  }
  const args = ["resume", "--remote", appServerUrl, "-C", cwd];
  if (launch.last) args.push("--last");
  if (launch.all) args.push("--all");
  if (launch.sessionId) args.push(launch.sessionId);
  if (launch.prompt) args.push(launch.prompt);
  return args;
}

type PtyChrome = {
  reservedRows: () => number;
  onOutput: () => void;
};

type StatusRuntimeSessionSummary = {
  sessionId: string;
  workingDirectory: string;
  online: boolean;
  threads?: Array<{
    threadId: string;
    running: boolean;
  }>;
};

class CodexhubStatusBar {
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private redrawTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private proxyState: "offline" | "connecting" | "online" = "offline";
  private text: string;

  private constructor(
    private readonly options: { apiBase: string; sessionId: string; cwd: string }
  ) {
    this.text = this.renderText();
  }

  static start(options: { apiBase: string; sessionId: string; cwd: string }) {
    if (!process.stdout.isTTY) return null;
    const bar = new CodexhubStatusBar(options);
    bar.attach();
    return bar;
  }

  setProxyState(state: "offline" | "connecting" | "online") {
    if (this.proxyState === state) return;
    this.proxyState = state;
    this.text = this.renderText();
    this.redrawSoon();
  }

  reservedRows() {
    if (this.stopped || !process.stdout.isTTY) return 0;
    return (process.stdout.rows ?? 0) >= 5 ? 1 : 0;
  }

  redrawSoon() {
    if (this.stopped || !this.reservedRows() || this.redrawTimer) return;
    this.redrawTimer = globalThis.setTimeout(() => {
      this.redrawTimer = null;
      this.draw();
    }, 25);
    this.redrawTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.redrawTimer) clearTimeout(this.redrawTimer);
    this.refreshTimer = null;
    this.redrawTimer = null;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.clear();
  }

  private attach() {
    const onResize = () => this.draw();
    process.stdout.on("resize", onResize);
    this.disposables.push({ dispose: () => process.stdout.off("resize", onResize) });
    this.refreshTimer = setInterval(() => void this.refresh(), 3000);
    this.refreshTimer.unref?.();
    void this.refresh();
    this.draw();
  }

  private async refresh() {
    if (this.stopped) return;
    try {
      const sessionData = await apiJson<{ sessions?: StatusRuntimeSessionSummary[] }>(this.options.apiBase, "/api/sessions");
      this.proxyState = "online";
      this.text = this.renderText(sessionData.sessions ?? []);
    } catch {
      this.proxyState = "offline";
      this.text = this.renderText();
    }
    this.draw();
  }

  private renderText(sessions: StatusRuntimeSessionSummary[] = []) {
    const onlineSessions = sessions.filter((session) => session.online).length;
    const thisSession = sessions.find((session) => session.sessionId === this.options.sessionId);
    const sessionState = thisSession
      ? (thisSession.online ? "online" : "offline")
      : this.proxyState === "online" ? "connecting" : this.proxyState;
    const latestThread = thisSession?.threads?.[0];
    const running = Boolean(thisSession?.threads?.some((thread) => thread.running));
    return [
      `codexhub ${this.options.sessionId.slice(0, 14)} ${sessionState}`,
      `thread ${latestThread ? latestThread.threadId : "none"}`,
      `running ${running ? 1 : 0}`,
      `sessions ${onlineSessions}/${sessions.length}`
    ].join(" | ");
  }

  private draw() {
    if (this.stopped || !this.reservedRows()) return;
    const rows = process.stdout.rows ?? 0;
    const cols = process.stdout.columns ?? 0;
    if (rows < 5 || cols < 10) return;
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[7m${fitStatusText(this.text, cols)}\x1b[0m\x1b[K\x1b8`);
  }

  private clear() {
    if (!process.stdout.isTTY) return;
    const rows = process.stdout.rows ?? 0;
    if (rows < 1) return;
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[0m\x1b[K\x1b8`);
  }
}

const startCodexAppServer = async (cwd: string, appServerUrl: string, port: number) => {
  const launch = await codexAppServerLaunch(appServerUrl);
  const child = spawn(launch.command, launch.args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  await waitForReady(port, child);
  return child;
};

const codexAppServerLaunch = async (appServerUrl: string) => {
  if (process.platform === "linux" && await fileExists("/usr/bin/setpriv")) {
    return {
      command: "/usr/bin/setpriv",
      args: ["--pdeathsig", "TERM", "codex", "app-server", "--listen", appServerUrl]
    };
  }
  return {
    command: "codex",
    args: ["app-server", "--listen", appServerUrl]
  };
};

const fileExists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const waitForReady = async (port: number, child: ChildProcess) => {
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const url = `http://127.0.0.1:${port}/readyz`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    if (exited) throw new Error("codex app-server exited before becoming ready");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling until timeout
    }
    await delay(150);
  }
  throw new Error(`codex app-server did not become ready: ${url}`);
};

const openWebSocket = async (url: string) => {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`WebSocket failed: ${url}`)), { once: true });
  });
  return ws;
};

const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resolve(port));
  });
});

const toAppServerInput = (input: ProxyInput) => {
  if (typeof input === "string") return [{ type: "text", text: input, text_elements: [] }];
  return input.map((item) => {
    if (item.type === "text") return { type: "text", text: item.text, text_elements: [] };
    return {
      type: "image",
      url: item.url,
      ...(item.detail ? { detail: item.detail } : {})
    };
  });
};

const inputForCollaborationMode = (input: ProxyInput, options: ThreadRunOptions | undefined): ProxyInput => {
  if (options?.collaborationMode !== "plan") return input;
  if (typeof input === "string") return `${planModePrefix()}\n\nUser request:\n${input}`;
  return [{ type: "text", text: planModePrefix() }, ...input];
};

const planModePrefix = () => [
  "Plan mode is active for this turn.",
  "Do not modify files, apply patches, commit, install packages, or run mutating commands.",
  "Inspect and reason as needed, then produce a concrete plan or ask the minimum clarifying question needed before implementation."
].join(" ");

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const commandModel = (options: ThreadRunOptions | undefined, fallback?: string) => {
  if (options && hasOwn(options, "model")) return options.model;
  return fallback;
};

const runtimePermissionParams = (options: Pick<BridgeOptions, "sandbox" | "approvalPolicy">) => ({
  ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
  ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox })
});

const turnRuntimeParams = (options: ThreadRunOptions | undefined): TurnRuntimeParams => {
  const params: TurnRuntimeParams = {};
  if (!options) return params;
  if (hasOwn(options, "model")) params.model = options.model;
  if (hasOwn(options, "modelReasoningEffort")) params.effort = options.modelReasoningEffort;
  return params;
};

const goalObjective = (input: ProxyInput, options: ThreadRunOptions) => {
  if (typeof options.goalObjective === "string" && options.goalObjective.trim()) {
    return options.goalObjective.trim();
  }
  const text = typeof input === "string"
    ? input
    : input
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n\n");
  const objective = text.trim();
  return objective ? objective.slice(0, 4000) : "Pursue the attached user request.";
};

const isModelReasoningEffort = (value: unknown): value is ThreadRunOptions["modelReasoningEffort"] =>
  value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";

const isInitialTuiResumeCurrentMethod = (method: string) =>
  method === "thread/status/changed" || isTuiResumeCurrentMethod(method);

const isTuiResumeCurrentMethod = (method: string) =>
  method === "thread/goal/cleared" || method === "thread/goal/updated";

const threadIdForMessage = (message: JsonRecord) => {
  const params = asRecord(message.params);
  const thread = asRecord(params?.thread);
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  return typeof params?.threadId === "string"
    ? params.threadId
    : typeof thread?.id === "string"
      ? thread.id
      : typeof resultThread?.id === "string"
        ? resultThread.id
        : undefined;
};

const threadIdForPendingMessage = (pending: Pick<PendingRequest, "method" | "threadId">, message: JsonRecord) => {
  if (pending.method === "thread/fork") {
    return resultThreadIdForMessage(message) ?? threadIdForMessage(message) ?? pending.threadId;
  }
  return threadIdForMessage(message) ?? pending.threadId;
};

const appServerThreadSummary = (
  thread: JsonRecord | null,
  workingDirectory: string
): CodexSessionSummary | null => {
  const threadId = typeof thread?.id === "string" ? thread.id : "";
  const cwd = typeof thread?.cwd === "string" ? thread.cwd : workingDirectory;
  if (!threadId || cwd !== workingDirectory) return null;
  return {
    threadId,
    cwd,
    path: typeof thread?.path === "string" ? thread.path : "",
    updatedAt: appServerTimestamp(thread?.updatedAt),
    firstUserMessage: typeof thread?.preview === "string" ? thread.preview : "",
    lastAssistantMessage: "",
    artifactCount: 0,
    messageCount: 0
  };
};

const appServerTimestamp = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === "string" && value) return value;
  return new Date(0).toISOString();
};

const resultThreadIdForMessage = (message: JsonRecord) => {
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  return typeof resultThread?.id === "string" ? resultThread.id : undefined;
};

const createSessionId = () => `local-${safeSessionPart(os.hostname())}-${process.pid}-${randomUUID().slice(0, 8)}`;

const createSessionMachineId = (sessionId: string) => `machine-session-${safeSessionPart(sessionId)}`;

const sessionDisplayName = (sessionId: string) => `codexhub-${sessionId.split("-").at(-1) ?? sessionId.slice(-8)}`;

const safeSessionPart = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";

const machineTransportUrl = (apiBase: string) => {
  const url = new URL("/api/machines/connect", apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const parseMachineTransportMessage = (data: unknown): MachineTransportMessage | null => {
  const message = parseJsonRecord(data);
  if (!message) return null;
  const type = typeof message?.type === "string" ? message.type : "";
  if (type === "registered") {
    const machineId = typeof message.machineId === "string" ? message.machineId : "";
    return machineId ? { type: "registered", machineId, machine: message.machine } : null;
  }
  if (type === "commands") {
    const cursor = typeof message.cursor === "number" ? message.cursor : NaN;
    return Number.isFinite(cursor) && Array.isArray(message.commands)
      ? { type: "commands", cursor, commands: message.commands as MachineCommand[] }
      : null;
  }
  if (type === "session_registered") {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    return sessionId ? { type: "session_registered", sessionId, session: message.session } : null;
  }
  if (type === "session_commands") {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const cursor = typeof message.cursor === "number" ? message.cursor : NaN;
    return sessionId && Number.isFinite(cursor) && Array.isArray(message.commands)
      ? { type: "session_commands", sessionId, cursor, commands: message.commands as WorkerCommand[] }
      : null;
  }
  if (type === "session_error") {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    return sessionId ? {
      type: "session_error",
      sessionId,
      message: typeof message.message === "string" ? message.message : "machine session server error"
    } : null;
  }
  if (type === "error") {
    return { type: "error", message: typeof message.message === "string" ? message.message : "machine transport server error" };
  }
  return null;
};

const HUB_API_TIMEOUT_MS = 15_000;

type ApiJsonInit = RequestInit & {
  timeoutMs?: number;
};

const apiJson = async <T = unknown>(apiBase: string, route: string, init: ApiJsonInit = {}): Promise<T> => {
  const { timeoutMs = HUB_API_TIMEOUT_MS, signal, ...requestInit } = init;
  const controller = new AbortController();
  let timedOut = false;
  let timeout: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeout.unref?.();
  }
  if (signal) {
    onAbort = () => controller.abort();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const response = await fetch(new URL(route, apiBase), { ...requestInit, signal: controller.signal });
    if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
    return await response.json() as T;
  } catch (error) {
    if (timedOut) throw new Error(`API request timed out after ${timeoutMs}ms: ${route}`);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
};

const parseJsonRecord = (data: unknown): JsonRecord | null => {
  try {
    if (typeof data === "string") return asRecord(JSON.parse(data));
    if (data instanceof ArrayBuffer) return asRecord(JSON.parse(Buffer.from(data).toString("utf8")));
    return asRecord(JSON.parse(String(data)));
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
};

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };
type PtyExit = { exitCode: number; signal?: number };

const waitForChild = async (child: ChildProcess) => await new Promise<ChildExit>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

const terminateChild = async (
  child: ChildProcess,
  stopped: Promise<ChildExit>,
  gracefulTimeoutMs = 3000,
  killTimeoutMs = 3000
) => {
  if (child.exitCode !== null || child.signalCode !== null) return await stopped;
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    stopped,
    delay(gracefulTimeoutMs).then(() => null)
  ]);
  if (graceful) return graceful;

  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  return await Promise.race([
    stopped,
    delay(killTimeoutMs).then(() => ({ code: child.exitCode, signal: child.signalCode }))
  ]);
};

const applyChildExitCode = ({ code, signal }: ChildExit) => {
  process.exitCode = code ?? (signal ? 1 : 0);
};

const applyPtyExitCode = ({ exitCode, signal }: PtyExit) => {
  process.exitCode = exitCode || (signal ? 1 : 0);
};

const terminalName = () => {
  const term = process.env.TERM;
  return term && term !== "dumb" ? term : "xterm-256color";
};

const terminalRows = (reservedRows: number) =>
  Math.max((process.stdout.rows ?? 24) - reservedRows, 2);

const fitStatusText = (text: string, columns: number) => {
  if (columns <= 0) return "";
  if (text.length >= columns) return text.slice(0, columns);
  return text.padEnd(columns, " ");
};

const waitForShutdown = async () => await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

const cleanupOnce = <T>(cleanup: () => T | Promise<T>) => {
  let called = false;
  return async () => {
    if (called) return undefined;
    called = true;
    return await cleanup();
  };
};

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveValue!: (value: T | PromiseLike<T>) => void;
  private rejectValue!: (error: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveValue = resolve;
      this.rejectValue = reject;
    });
  }

  resolve(value?: T) {
    if (this.settled) return;
    this.settled = true;
    this.resolveValue(value as T);
  }

  reject(error: unknown) {
    if (this.settled) return;
    this.settled = true;
    this.rejectValue(error);
  }
}

const signalExitCode = (signal: NodeJS.Signals) => {
  const signalNumbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  const signalNumber = signalNumbers[signal] ?? 1;
  return 128 + signalNumber;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
