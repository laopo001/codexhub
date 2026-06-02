import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { spawn as spawnPty, type IPty } from "node-pty";
import { readCodexSessionRecordsAfter } from "../core/codexSession.js";
import { asRecord as asCodexRecord, codexRecordFromSession, type CodexRecord } from "../core/codexRecord.js";
import { readCodexUsage } from "../core/codexUsage.js";
import type { ProxyInput } from "../core/proxyInput.js";
import type { ThreadRunOptions, WorkerCommand } from "../core/threadHub.js";

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
  jsonlLine?: number;
  jsonlSyncing?: boolean;
  jsonlReplayKeepTurns?: number;
};

type BridgeState = {
  threadIds: string[];
  currentThreadId?: string;
};

type RuntimeSettings = {
  model?: string | null;
  modelReasoningEffort?: ThreadRunOptions["modelReasoningEffort"] | null;
};

type WorkerRegisterResponse = {
  workerId: string;
};

type WorkerCommandsResponse = {
  cursor: number;
  commands: WorkerCommand[];
};

type BridgeOptions = {
  apiBase: string;
  appServerUrl: string;
  workerId: string;
  cwd: string;
  ensureCurrentThread?: boolean;
  readyLabel?: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
};

type ProxyBridgeRunnerOptions = BridgeOptions & {
  statusBar?: CodexhubStatusBar | null;
};

export type HeadlessCodexhubWorkerOptions = {
  apiBase: string;
  cwd: string;
  port?: number;
  readyLabel?: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
};

export type HeadlessCodexhubWorkerHandle = {
  workerId: string;
  threadId: string;
  appServerUrl: string;
  cwd: string;
  ensureThread: (threadId: string) => Promise<string>;
  stop: () => Promise<void>;
  wait: () => Promise<ChildExit>;
};

export const registerCodexHubWorkerCommands = (program: Command) => {
  program
    .argument("[prompt]", "optional prompt to start the Codex session")
    .option("-C, --cd <dir>", "Codex working directory")
    .option("--port <port>", "local Codex app-server websocket port")
    .option("--headless", "do not launch the official Codex TUI")
    .option("-m, --model <model>", "model for remote turns")
    .option("-s, --sandbox <mode>", "sandbox mode for remote turns")
    .option("-a, --approval-policy <policy>", "approval policy for remote turns")
    .action(async (prompt: string | undefined) => {
      await runCodexhubWorker(program, program.opts<ConnectOptions>(), { type: "start", prompt });
    });

  program
    .command("resume")
    .argument("[session]", "Codex session/thread id or thread name")
    .argument("[prompt]", "optional prompt to send after resuming")
    .description("Resume an official Codex session with the codexhub worker bridge")
    .option("--server <url>", "codexhub server URL")
    .option("-C, --cd <dir>", "Codex working directory")
    .option("--port <port>", "local Codex app-server websocket port")
    .option("--last", "resume the most recent Codex session")
    .option("--all", "show all Codex sessions in the picker")
    .option("-m, --model <model>", "model for remote turns")
    .option("-s, --sandbox <mode>", "sandbox mode for remote turns")
    .option("-a, --approval-policy <policy>", "approval policy for remote turns")
    .action(async (sessionId: string | undefined, prompt: string | undefined, options: ResumeOptions) => {
      await runCodexhubWorker(program, options, {
        type: "resume",
        sessionId,
        prompt,
        last: options.last,
        all: options.all
      });
    });
};

async function runCodexhubWorker(program: Command, options: ConnectOptions, launch: TuiLaunch) {
  const rootOptions = program.opts<{ server: string }>();
  const apiBase = options.server ?? rootOptions.server;
  const cwd = path.resolve(options.cd ?? process.cwd());
  const port = options.port ? Number(options.port) : await findFreePort();
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${options.port}`);

  const appServerUrl = `ws://127.0.0.1:${port}`;
  const workerId = createWorkerId();
  const appServer = await startCodexAppServer(cwd, appServerUrl, port);
  let bridgeRunner: ProxyBridgeRunner | null = null;
  let tui: CodexTuiPty | null = null;
  let statusBar: CodexhubStatusBar | null = null;
  let cleanedUp = false;
  const cleanup = cleanupOnce(async () => {
    cleanedUp = true;
    tui?.kill();
    statusBar?.stop();
    await bridgeRunner?.stop();
    appServer.kill("SIGTERM");
  });
  const onSignal = (signal: NodeJS.Signals) => {
    void cleanup().finally(() => process.exit(signalExitCode(signal)));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  try {
    const appServerStopped = waitForChild(appServer).then(({ code, signal }) => {
      if (!cleanedUp) process.exitCode = code ?? (signal ? 1 : 1);
    });

    console.error([
      `codexhub local started: ${workerId}`,
      `server: ${apiBase} (optional)`,
      `cwd: ${cwd}`,
      `app-server: ${appServerUrl}`
    ].join("\n"));

    statusBar = CodexhubStatusBar.start({ apiBase, workerId, cwd });
    bridgeRunner = new ProxyBridgeRunner({
      apiBase,
      appServerUrl,
      workerId,
      cwd,
      ensureCurrentThread: Boolean(options.headless),
      model: options.model,
      sandbox: options.sandbox,
      approvalPolicy: options.approvalPolicy,
      statusBar
    });
    bridgeRunner.start();

    if (options.headless) {
      await Promise.race([waitForShutdown(), appServerStopped]);
      return;
    }

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

export async function startHeadlessCodexhubWorker(options: HeadlessCodexhubWorkerOptions): Promise<HeadlessCodexhubWorkerHandle> {
  const cwd = path.resolve(options.cwd);
  const port = options.port ?? await findFreePort();
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${options.port}`);

  const appServerUrl = `ws://127.0.0.1:${port}`;
  const workerId = createWorkerId();
  const appServer = await startCodexAppServer(cwd, appServerUrl, port);
  const bridgeRunner = new ProxyBridgeRunner({
    apiBase: options.apiBase,
    appServerUrl,
    workerId,
    cwd,
    ensureCurrentThread: true,
    readyLabel: options.readyLabel,
    model: options.model,
    sandbox: options.sandbox,
    approvalPolicy: options.approvalPolicy,
    statusBar: null
  });
  const appServerStopped = waitForChild(appServer);
  const cleanup = cleanupOnce(async () => {
    await bridgeRunner.stop();
    appServer.kill("SIGTERM");
  });

  bridgeRunner.start();
  try {
    const ready = await Promise.race([
      bridgeRunner.waitForReady(),
      appServerStopped.then(({ code, signal }) => {
        throw new Error(`codex app-server exited before headless worker was ready: code=${code ?? ""} signal=${signal ?? ""}`);
      })
    ]);
    return {
      workerId,
      threadId: ready.threadId,
      appServerUrl,
      cwd,
      ensureThread: (threadId: string) => bridgeRunner.ensureThread(threadId),
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
  private registered = false;
  private stopping = false;
  private loopStarted = false;
  private lastState: "offline" | "online" | null = null;
  private lastReadyThreadId: string | null = null;
  private readonly ready = new Deferred<{ workerId: string; threadId: string }>();
  private bridgeState: BridgeState = { threadIds: [] };

  constructor(private readonly options: ProxyBridgeRunnerOptions) {}

  start() {
    if (this.loopStarted) return;
    this.loopStarted = true;
    void this.runLoop();
  }

  async stop() {
    this.stopping = true;
    this.bridge?.close();
    await this.unregister();
  }

  waitForReady() {
    return this.ready.promise;
  }

  async ensureThread(threadId: string) {
    const trimmed = threadId.trim();
    if (!trimmed) throw new Error("Missing thread id.");
    if (!this.bridge) throw new Error("codexhub bridge is not connected.");
    const currentThreadId = await this.bridge.ensureThreadCurrent(trimmed);
    this.bridgeState = this.bridge.snapshotState();
    return currentThreadId;
  }

  private async runLoop() {
    while (!this.stopping) {
      this.options.statusBar?.setProxyState("connecting");
      try {
        await this.register();
        this.bridge = await CodexAppServerBridge.connect(this.options, this.bridgeState);
        if (this.options.ensureCurrentThread) {
          const threadId = await this.bridge.ensureCurrentThread();
          this.bridgeState = this.bridge.snapshotState();
          this.logHeadlessReady(threadId);
          this.ready.resolve({ workerId: this.options.workerId, threadId });
        }
        this.options.statusBar?.setProxyState("online");
        this.logState("online", `codexhub proxy connected: ${this.options.workerId}`);
        await this.runBridge(this.bridge);
      } catch (error) {
        if (this.stopping) return;
        this.options.statusBar?.setProxyState("offline");
        this.logState("offline", `codexhub proxy offline: ${errorText(error)}`);
      } finally {
        if (this.bridge) this.bridgeState = this.bridge.snapshotState();
        this.bridge?.close();
        this.bridge = null;
        await this.unregister();
      }
      if (!this.stopping) await delay(5000);
    }
  }

  private async register() {
    await apiJson<WorkerRegisterResponse>(this.options.apiBase, "/api/workers/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: this.options.workerId,
        name: workerDisplayName(this.options.workerId),
        workingDirectory: this.options.cwd,
        appServerUrl: this.options.appServerUrl,
        pid: process.pid,
        hostname: os.hostname(),
        currentThreadId: this.bridgeState.currentThreadId
      })
    });
    this.registered = true;
  }

  private async unregister() {
    if (!this.registered) return;
    this.registered = false;
    await unregisterWorker(this.options.apiBase, this.options.workerId);
  }

  private async runBridge(bridge: CodexAppServerBridge) {
    const stopped = new Deferred<void>();
    const fail = (label: string) => (error: unknown) => {
      if (!this.stopping) stopped.reject(new Error(`${label}: ${errorText(error)}`));
    };
    void bridge.runCommandLoop().catch(fail("command loop"));
    void bridge.runThreadSyncLoop().catch(fail("thread sync"));
    void bridge.runJsonlRecordSyncLoop().catch(fail("jsonl record sync"));
    void bridge.runHeartbeatLoop().catch(fail("heartbeat"));
    void bridge.waitForClose().then(() => stopped.reject(new Error("app-server bridge closed")));
    await stopped.promise;
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
      `${this.options.readyLabel ?? "codexhub headless worker ready"}:`,
      `  workerId: ${this.options.workerId}`,
      `  threadId: ${threadId}`
    ].join("\n"));
  }
}

class CodexAppServerBridge {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly syncedThreads = new Map<string, SyncedThread>();
  private nextId = 1;
  private cursor = 0;
  private closed = false;
  private currentThreadId: string | undefined;
  private readonly forwardedRuntimeSettings = new Map<string, string>();
  private readonly bridgeStartedThreads = new Set<string>();
  private bridgeStartedUnknownCount = 0;
  private readonly closeSignal = new Deferred<void>();

  private constructor(
    private readonly options: BridgeOptions,
    private readonly ws: WebSocket,
    initialState: BridgeState
  ) {
    this.currentThreadId = initialState.currentThreadId;
    for (const threadId of initialState.threadIds) this.bindThread(threadId);
  }

  static async connect(options: BridgeOptions, initialState: BridgeState = { threadIds: [] }) {
    const ws = await openWebSocket(options.appServerUrl);
    const bridge = new CodexAppServerBridge(options, ws, initialState);
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
    if (this.currentThreadId) return this.currentThreadId;
    const result = asRecord(await this.request("thread/start", {
      cwd: this.options.cwd,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...runtimePermissionParams(this.options),
      threadSource: "user"
    }));
    const thread = asRecord(result?.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex app-server thread/start did not return thread.id");
    this.bindThread(threadId);
    await this.forwardCurrentThreadChanged(threadId);
    return threadId;
  }

  async ensureThreadCurrent(threadId: string) {
    if (this.currentThreadId === threadId) return threadId;
    const result = asRecord(await this.request("thread/resume", {
      threadId,
      cwd: this.options.cwd,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...runtimePermissionParams(this.options)
    }, { threadId }));
    const thread = asRecord(result?.thread);
    const currentThreadId = typeof thread?.id === "string" ? thread.id : threadId;
    this.bindThread(currentThreadId);
    await this.forwardCurrentThreadChanged(currentThreadId);
    return currentThreadId;
  }

  async runCommandLoop() {
    while (!this.closed) {
      const response = await apiJson<WorkerCommandsResponse>(
        this.options.apiBase,
        `/api/workers/${encodeURIComponent(this.options.workerId)}/commands?${new URLSearchParams({ after: String(this.cursor) })}`
      );
      if (this.closed) return;
      this.cursor = Math.max(this.cursor, response.cursor);
      for (const command of response.commands) {
        if (this.closed) return;
        await this.handleCommand(command);
        this.cursor = Math.max(this.cursor, command.seq);
      }
    }
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

  async runJsonlRecordSyncLoop() {
    while (!this.closed) {
      await delay(1000);
      if (this.closed) return;
      for (const [threadId, state] of [...this.syncedThreads]) {
        if (this.closed) return;
        await this.syncJsonlRecords(threadId, state);
      }
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
    this.closeSignal.resolve();
  }

  private async handleCommand(command: WorkerCommand) {
    if (command.type === "stop") {
      if (command.threadId && command.turnId) {
        await this.request("turn/interrupt", {
          threadId: command.threadId,
          turnId: command.turnId
        }, command);
      }
      return;
    }

    if (command.type === "fork_thread") {
      if (!command.threadId) throw new Error("fork_thread command requires threadId");
      const model = commandModel(command.options, this.options.model);
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
      this.bindThread(threadId);
      return;
    }

    if (command.type === "rollback_thread") {
      if (!command.threadId) throw new Error("rollback_thread command requires threadId");
      if (!command.numTurns || command.numTurns < 1) throw new Error("rollback_thread command requires numTurns >= 1");
      await this.request("thread/rollback", {
        threadId: command.threadId,
        numTurns: command.numTurns
      }, command);
      this.bindThread(command.threadId);
      this.resetJsonlCursor(command.threadId, command.keepTurns);
      return;
    }

    if (!command.input || !command.threadId) return;
    const threadId = command.threadId;
    if (!this.syncedThreads.has(threadId)) {
      const model = commandModel(command.options, this.options.model);
      this.markBridgeStartedThread(threadId);
      await this.request("thread/resume", {
        threadId,
        cwd: command.workingDirectory,
        ...(model === undefined ? {} : { model }),
        ...runtimePermissionParams(this.options)
      }, command);
      this.bindThread(threadId);
    }
    this.markBridgeStartedThread(threadId);
    await this.request("turn/start", {
      threadId,
      input: toAppServerInput(command.input),
      ...turnRuntimeParams(command.options)
    }, command);
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
      else pending.resolve(message.result);
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
    if (typeof resultThread?.id === "string") this.bindThread(resultThread.id);
  }

  private threadIdForMessage(message: JsonRecord) {
    const threadId = threadIdForMessage(message);
    if (!threadId) return undefined;
    this.bindThread(threadId);
    return threadId;
  }

  private bindThread(threadId: string) {
    if (!this.syncedThreads.has(threadId)) {
      this.syncedThreads.set(threadId, {});
    }
  }

  private resetJsonlCursor(threadId: string, keepTurns?: number) {
    const state = this.syncedThreads.get(threadId) ?? {};
    state.jsonlPath = undefined;
    state.jsonlLine = 0;
    state.jsonlReplayKeepTurns = keepTurns;
    this.syncedThreads.set(threadId, state);
  }

  private async syncJsonlRecords(threadId: string, state: SyncedThread) {
    if (state.jsonlSyncing) return;
    state.jsonlSyncing = true;
    try {
      const batch = await readCodexSessionRecordsAfter(threadId, state.jsonlLine ?? 0);
      if (!batch) return;
      if (state.jsonlPath && state.jsonlPath !== batch.path) {
        state.jsonlLine = 0;
        const resetBatch = await readCodexSessionRecordsAfter(threadId, 0);
        if (!resetBatch) return;
        state.jsonlPath = resetBatch.path;
        state.jsonlLine = resetBatch.lastLine;
        const records = this.recordsForJsonlSync(resetBatch.records, state)
          .filter(shouldMirrorJsonlRecord)
          .map((record) => codexRecordFromSession(record, threadId));
        if (records.length) await this.forwardRecords(threadId, records);
        return;
      }
      state.jsonlPath = batch.path;
      state.jsonlLine = batch.lastLine;

      const records = this.recordsForJsonlSync(batch.records, state)
        .filter(shouldMirrorJsonlRecord)
        .map((record) => codexRecordFromSession(record, threadId));
      if (records.length) await this.forwardRecords(threadId, records);
    } catch (error) {
      console.error(`codexhub bridge failed to sync jsonl records for ${threadId}: ${errorText(error)}`);
    } finally {
      state.jsonlSyncing = false;
    }
  }

  private recordsForJsonlSync<T extends { turnId?: string }>(
    records: T[],
    state: SyncedThread
  ): T[] {
    if (!state.jsonlReplayKeepTurns) return records;
    const keepTurnIds: string[] = [];
    for (const record of records) {
      if (!record.turnId || keepTurnIds.includes(record.turnId)) continue;
      if (keepTurnIds.length >= state.jsonlReplayKeepTurns) continue;
      keepTurnIds.push(record.turnId);
    }
    const allowed = new Set(keepTurnIds);
    state.jsonlReplayKeepTurns = undefined;
    return records.filter((record) => !record.turnId || allowed.has(record.turnId));
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
    await apiJson(this.options.apiBase, `/api/workers/${encodeURIComponent(this.options.workerId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "thread_event", threadId, commandId, message, heartbeat: options.heartbeat })
    }).catch((error) => {
      console.error(`codexhub bridge failed to forward app-server event: ${errorText(error)}`);
    });
  }

  private async forwardStateEventsFromMessage(threadId: string, message: JsonRecord) {
    const method = typeof message.method === "string" ? message.method : "";
    if (method === "thread/started") {
      if (this.bridgeStartedThreads.has(threadId)) {
        this.bridgeStartedThreads.delete(threadId);
      } else if (this.bridgeStartedUnknownCount > 0) {
        this.bridgeStartedUnknownCount -= 1;
      } else {
        await this.forwardCurrentThreadChanged(threadId);
      }
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

  private async forwardCurrentThreadChanged(threadId: string, heartbeat = false) {
    if (this.currentThreadId === threadId) return;
    this.currentThreadId = threadId;
    await apiJson(this.options.apiBase, `/api/workers/${encodeURIComponent(this.options.workerId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "worker_current_changed", currentThreadId: threadId, heartbeat })
    }).catch((error) => {
      console.error(`codexhub bridge failed to forward current thread change: ${errorText(error)}`);
    });
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
    await apiJson(this.options.apiBase, `/api/workers/${encodeURIComponent(this.options.workerId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "thread_execution_changed", threadId, running, turnId, heartbeat: false })
    }).catch((error) => {
      console.error(`codexhub bridge failed to forward thread execution state: ${errorText(error)}`);
    });
  }

  private async forwardRuntimeSettings(threadId: string, settings: RuntimeSettings) {
    await apiJson(this.options.apiBase, `/api/workers/${encodeURIComponent(this.options.workerId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "runtime_settings_changed",
        threadId,
        model: settings.model,
        modelReasoningEffort: settings.modelReasoningEffort,
        heartbeat: false
      })
    }).catch((error) => {
      console.error(`codexhub bridge failed to forward runtime settings: ${errorText(error)}`);
    });
  }

  private async forwardRecords(threadId: string, records: CodexRecord[]) {
    await apiJson(this.options.apiBase, `/api/workers/${encodeURIComponent(this.options.workerId)}/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, records, heartbeat: false })
    }).catch((error) => {
      console.error(`codexhub bridge failed to forward jsonl records: ${errorText(error)}`);
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
    const codexUsage = await readCodexUsage().catch(() => undefined);
    const threadCodexUsage = Object.fromEntries((await Promise.all(
      [...this.syncedThreads.keys()].map(async (threadId) => {
        const usage = await readCodexUsage(threadId).catch(() => undefined);
        return usage ? [threadId, usage] as const : null;
      })
    )).filter((item): item is readonly [string, Awaited<ReturnType<typeof readCodexUsage>>] => Boolean(item)));

    await apiJson(this.options.apiBase, `/api/workers/${encodeURIComponent(this.options.workerId)}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workingDirectory: this.options.cwd,
        appServerUrl: this.options.appServerUrl,
        pid: process.pid,
        hostname: os.hostname(),
        codexUsage,
        threadCodexUsage
      })
    }).catch(() => undefined);
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
        // The child may already be gone; cleanup must still unregister the worker.
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

type StatusWorkerSummary = {
  workerId: string;
  workingDirectory: string;
  online: boolean;
  currentThreadId?: string;
  currentThread?: {
    threadId: string;
    running: boolean;
  };
};

class CodexhubStatusBar {
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private redrawTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private proxyState: "offline" | "connecting" | "online" = "offline";
  private text: string;

  private constructor(
    private readonly options: { apiBase: string; workerId: string; cwd: string }
  ) {
    this.text = this.renderText();
  }

  static start(options: { apiBase: string; workerId: string; cwd: string }) {
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
      const workerData = await apiJson<{ workers?: StatusWorkerSummary[] }>(this.options.apiBase, "/api/workers");
      this.proxyState = "online";
      this.text = this.renderText(workerData.workers ?? []);
    } catch {
      this.proxyState = "offline";
      this.text = this.renderText();
    }
    this.draw();
  }

  private renderText(workers: StatusWorkerSummary[] = []) {
    const onlineWorkers = workers.filter((worker) => worker.online).length;
    const thisWorker = workers.find((worker) => worker.workerId === this.options.workerId);
    const workerState = thisWorker
      ? (thisWorker.online ? "online" : "offline")
      : this.proxyState === "online" ? "connecting" : this.proxyState;
    const currentThreadId = thisWorker?.currentThreadId ?? thisWorker?.currentThread?.threadId;
    const running = thisWorker?.currentThread?.running;
    return [
      `codexhub ${this.options.workerId.slice(0, 14)} ${workerState}`,
      `thread ${currentThreadId ? currentThreadId : "none"}`,
      `running ${running ? 1 : 0}`,
      `workers ${onlineWorkers}/${workers.length}`
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
  const child = spawn("codex", ["app-server", "--listen", appServerUrl], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  await waitForReady(port, child);
  return child;
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

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const commandModel = (options: ThreadRunOptions | undefined, fallback?: string) => {
  if (options && hasOwn(options, "model")) return options.model;
  return fallback;
};

const runtimePermissionParams = (options: Pick<BridgeOptions, "sandbox" | "approvalPolicy">) => ({
  ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
  ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox })
});

const turnRuntimeParams = (options: ThreadRunOptions | undefined) => {
  const params: { model?: string | null; effort?: ThreadRunOptions["modelReasoningEffort"] } = {};
  if (!options) return params;
  if (hasOwn(options, "model")) params.model = options.model;
  if (hasOwn(options, "modelReasoningEffort")) params.effort = options.modelReasoningEffort;
  return params;
};

const isModelReasoningEffort = (value: unknown): value is ThreadRunOptions["modelReasoningEffort"] =>
  value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";

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

const shouldMirrorJsonlRecord = (record: { type: string; payload: unknown }) => {
  const payload = asCodexRecord(record.payload);
  if (!payload) return false;
  if (record.type === "response_item") return payload.type !== "message";
  if (record.type !== "event_msg") return false;
  return payload.type === "user_message"
    || payload.type === "agent_message"
    || payload.type === "image_generation_end"
    || payload.type === "token_count";
};

const resultThreadIdForMessage = (message: JsonRecord) => {
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  return typeof resultThread?.id === "string" ? resultThread.id : undefined;
};

const createWorkerId = () => `local-${safeWorkerPart(os.hostname())}-${process.pid}-${randomUUID().slice(0, 8)}`;

const workerDisplayName = (workerId: string) => `codexhub-${workerId.split("-").at(-1) ?? workerId.slice(-8)}`;

const safeWorkerPart = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";

const apiJson = async <T = unknown>(apiBase: string, route: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(new URL(route, apiBase), init);
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};

const unregisterWorker = async (apiBase: string, workerId: string) => {
  await apiJson(apiBase, `/api/workers/${encodeURIComponent(workerId)}`, { method: "DELETE" }).catch(() => undefined);
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
