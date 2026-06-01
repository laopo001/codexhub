import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { spawn as spawnPty, type IPty } from "node-pty";
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

type JsonRecord = Record<string, unknown>;

type PendingRequest = {
  method: string;
  threadId?: string;
  commandId?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type SyncedThread = {
  failures: number;
  syncing: boolean;
  lastSnapshot?: string;
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
  model?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
};

type ProxyBridgeRunnerOptions = BridgeOptions & {
  statusBar?: CodexpStatusBar | null;
};

export const registerConnectCommand = (program: Command) => {
  program
    .command("connect")
    .description("Connect this folder to a codex-proxy server using the official Codex app-server/TUI")
    .option("--server <url>", "codex-proxy server URL")
    .option("-C, --cd <dir>", "Codex working directory")
    .option("--port <port>", "local Codex app-server websocket port")
    .option("--headless", "do not launch the official Codex TUI")
    .option("-m, --model <model>", "model for remote turns")
    .option("-s, --sandbox <mode>", "sandbox mode for remote turns", "workspace-write")
    .option("-a, --approval-policy <policy>", "approval policy for remote turns", "never")
    .action(async (options: ConnectOptions) => {
      const rootOptions = program.opts<{ server: string; cwd: string }>();
      const apiBase = options.server ?? rootOptions.server;
      const cwd = path.resolve(options.cd ?? rootOptions.cwd ?? process.cwd());
      const port = options.port ? Number(options.port) : await findFreePort();
      if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${options.port}`);

      const appServerUrl = `ws://127.0.0.1:${port}`;
      const workerId = createWorkerId();
      const appServer = await startCodexAppServer(cwd, appServerUrl, port);
      let bridgeRunner: ProxyBridgeRunner | null = null;
      let tui: CodexTuiPty | null = null;
      let statusBar: CodexpStatusBar | null = null;
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
          `codexp local started: ${workerId}`,
          `server: ${apiBase} (optional)`,
          `cwd: ${cwd}`,
          `app-server: ${appServerUrl}`
        ].join("\n"));

        statusBar = CodexpStatusBar.start({ apiBase, workerId, cwd });
        bridgeRunner = new ProxyBridgeRunner({
          apiBase,
          appServerUrl,
          workerId,
          cwd,
          model: options.model,
          sandbox: options.sandbox ?? "workspace-write",
          approvalPolicy: options.approvalPolicy ?? "never",
          statusBar
        });
        bridgeRunner.start();

        if (options.headless) {
          await Promise.race([waitForShutdown(), appServerStopped]);
          return;
        }

        tui = CodexTuiPty.start(cwd, appServerUrl, statusBar ? {
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
    });
};

class ProxyBridgeRunner {
  private bridge: CodexAppServerBridge | null = null;
  private registered = false;
  private stopping = false;
  private loopStarted = false;
  private lastState: "offline" | "online" | null = null;

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

  private async runLoop() {
    while (!this.stopping) {
      this.options.statusBar?.setProxyState("connecting");
      try {
        await this.register();
        this.bridge = await CodexAppServerBridge.connect(this.options);
        this.options.statusBar?.setProxyState("online");
        this.logState("online", `codexp proxy connected: ${this.options.workerId}`);
        await this.runBridge(this.bridge);
      } catch (error) {
        if (this.stopping) return;
        this.options.statusBar?.setProxyState("offline");
        this.logState("offline", `codexp proxy offline: ${errorText(error)}`);
      } finally {
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
        hostname: os.hostname()
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
    void bridge.runHeartbeatLoop().catch(fail("heartbeat"));
    void bridge.waitForClose().then(() => stopped.reject(new Error("app-server bridge closed")));
    await stopped.promise;
  }

  private logState(state: "offline" | "online", message: string) {
    if (this.lastState === state) return;
    this.lastState = state;
    console.error(message);
  }
}

class CodexAppServerBridge {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly syncedThreads = new Map<string, SyncedThread>();
  private nextId = 1;
  private cursor = 0;
  private closed = false;
  private readonly forwardedRuntimeSettings = new Map<string, string>();
  private readonly closeSignal = new Deferred<void>();

  private constructor(
    private readonly options: BridgeOptions,
    private readonly ws: WebSocket
  ) {}

  static async connect(options: BridgeOptions) {
    const ws = await openWebSocket(options.appServerUrl);
    const bridge = new CodexAppServerBridge(options, ws);
    ws.addEventListener("message", (event) => void bridge.handleMessage(event.data));
    ws.addEventListener("error", () => {
      if (!bridge.closed) console.error("codex app-server websocket error");
    });
    ws.addEventListener("close", () => bridge.markClosed());
    await bridge.request("initialize", {
      clientInfo: { name: "codexp", title: "codex-proxy bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    bridge.notify("initialized");
    return bridge;
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
      for (const [threadId, state] of entries) {
        if (this.closed) return;
        await this.syncThread(threadId, state);
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
      const result = asRecord(await this.request("thread/fork", {
        threadId: command.threadId,
        cwd: command.workingDirectory,
        ...(model === undefined ? {} : { model }),
        approvalPolicy: this.options.approvalPolicy,
        sandbox: this.options.sandbox,
        threadSource: "user"
      }, command));
      const thread = asRecord(result?.thread);
      const threadId = typeof thread?.id === "string" ? thread.id : undefined;
      if (!threadId) throw new Error("Codex app-server thread/fork did not return thread.id");
      this.bindThread(threadId);
      return;
    }

    if (!command.input || !command.threadId) return;
    const threadId = command.threadId;
    if (!this.syncedThreads.has(threadId)) {
      const model = commandModel(command.options, this.options.model);
      await this.request("thread/resume", {
        threadId,
        cwd: command.workingDirectory,
        ...(model === undefined ? {} : { model }),
        approvalPolicy: this.options.approvalPolicy,
        sandbox: this.options.sandbox
      }, command);
      this.bindThread(threadId);
    }
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
        await this.forward(threadId, pending.commandId, message, { heartbeat: pending.method !== "thread/read" });
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
    if (threadId) await this.forward(threadId, undefined, message);
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
      this.syncedThreads.set(threadId, { failures: 0, syncing: false });
    }
  }

  private async syncThread(threadId: string, state: SyncedThread) {
    if (state.syncing) return;
    state.syncing = true;
    try {
      const result = await this.request("thread/read", {
        threadId,
        includeTurns: true
      });
      const snapshot = JSON.stringify(result);
      if (snapshot !== state.lastSnapshot) {
        state.lastSnapshot = snapshot;
        await this.forward(threadId, undefined, { result }, { heartbeat: false, current: false });
      }
      state.failures = 0;
    } catch (error) {
      const text = errorText(error);
      if (text.includes("is not materialized yet") || text.includes("includeTurns is unavailable before first user message")) {
        state.failures = 0;
        return;
      }
      state.failures += 1;
      if (text.includes("ephemeral threads do not support includeTurns")) {
        this.syncedThreads.delete(threadId);
      } else if (state.failures === 3) {
        console.error(`codexp bridge failed to sync thread ${threadId}: ${text}`);
      }
    } finally {
      state.syncing = false;
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
        await this.forward(threadId, undefined, {
          method: "thread/settings/updated",
          params: {
            threadId,
            threadSettings: {
              model: settings.model ?? null,
              effort: settings.modelReasoningEffort ?? null
            }
          }
        }, { heartbeat: false, current: false });
      }));
    } catch (error) {
      console.error(`codexp bridge failed to sync runtime settings: ${errorText(error)}`);
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

  private async forward(
    threadId: string,
    commandId: string | undefined,
    message: JsonRecord,
    options: { heartbeat?: boolean; current?: boolean } = {}
  ) {
    await apiJson(this.options.apiBase, `/api/workers/${encodeURIComponent(this.options.workerId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, commandId, message, heartbeat: options.heartbeat, current: options.current })
    }).catch((error) => {
      console.error(`codexp bridge failed to forward app-server event: ${errorText(error)}`);
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
        message: `codexp bridge does not handle app-server request: ${method}`
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

  static start(cwd: string, appServerUrl: string, chrome?: PtyChrome) {
    const term = terminalName();
    const pty = spawnPty("codex", ["--remote", appServerUrl, "-C", cwd], {
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

type PtyChrome = {
  reservedRows: () => number;
  onOutput: () => void;
};

type StatusThreadSummary = {
  workingDirectory: string;
  running: boolean;
};

type StatusWorkerSummary = {
  workerId: string;
  workingDirectory: string;
  online: boolean;
};

class CodexpStatusBar {
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
    const bar = new CodexpStatusBar(options);
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
      const [threadData, workerData] = await Promise.all([
        apiJson<{ threads?: StatusThreadSummary[] }>(this.options.apiBase, "/api/threads"),
        apiJson<{ workers?: StatusWorkerSummary[] }>(this.options.apiBase, "/api/workers")
      ]);
      this.proxyState = "online";
      this.text = this.renderText(threadData.threads ?? [], workerData.workers ?? []);
    } catch {
      this.proxyState = "offline";
      this.text = this.renderText();
    }
    this.draw();
  }

  private renderText(threads: StatusThreadSummary[] = [], workers: StatusWorkerSummary[] = []) {
    const workspaceThreads = threads.filter((thread) => thread.workingDirectory === this.options.cwd);
    const runningThreads = workspaceThreads.filter((thread) => thread.running).length;
    const onlineWorkers = workers.filter((worker) => worker.online).length;
    const thisWorker = workers.find((worker) => worker.workerId === this.options.workerId);
    const workerState = thisWorker
      ? (thisWorker.online ? "online" : "offline")
      : this.proxyState === "online" ? "connecting" : this.proxyState;
    return [
      `codexp ${this.options.workerId.slice(0, 14)} ${workerState}`,
      `threads ${workspaceThreads.length}/${threads.length}`,
      `running ${runningThreads}`,
      `workers ${onlineWorkers}/${workers.length}`,
      path.basename(this.options.cwd) || this.options.cwd
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

const resultThreadIdForMessage = (message: JsonRecord) => {
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  return typeof resultThread?.id === "string" ? resultThread.id : undefined;
};

const createWorkerId = () => `local-${safeWorkerPart(os.hostname())}-${process.pid}-${randomUUID().slice(0, 8)}`;

const workerDisplayName = (workerId: string) => `codexp-${workerId.split("-").at(-1) ?? workerId.slice(-8)}`;

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
