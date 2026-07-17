import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  startCodexAppServerProcess,
  type ChildExit,
  type CodexAppServerLaunchOptions,
  type CodexAppServerProcessHandle
} from "./codexAppServerProcess.js";
import {
  dispatchAppServerCommand,
  permissionParams,
  toAppServerInput,
  turnRequestParams,
  type AppServerCollaborationMode
} from "./appServerCommandDispatcher.js";
import {
  builtinCommandPaletteEntries,
  commandPaletteEntryFromPlugin,
  commandPaletteEntryFromSkill,
  dedupeCommandPaletteEntries,
  pluginNameFromId,
  pluginNameFromSkillName,
  stringField
} from "./commandPalette.js";
import { accountRateLimitsPayloadFromValue } from "../core/threadUsage.js";
import type { AppServerSocketLike } from "../core/appServerTunnel.js";
import type { ProxyInput } from "../shared/inputTypes.js";
import { isModelReasoningEffort } from "../shared/usageTypes.js";
import type {
  AppServerApprovalDecision,
  AppServerApprovalKind,
  AppServerUserInputAnswers,
  CommandPalette,
  CommandPaletteEntry,
  CommandPalettePart,
  ModelCatalogItem,
  SessionCommand,
  SessionEventInput,
  SessionRegistration,
  ThreadCandidateSummary,
  ThreadRunOptions
} from "../shared/threadTypes.js";

export { startCodexAppServerProcess };
export type { CodexAppServerProcessHandle };

type JsonRecord = Record<string, unknown>;

type PendingRequest = {
  method: string;
  threadId?: string;
  commandId?: string;
  timeout?: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type PendingApprovalRequest = {
  requestId: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type PendingUserInputRequest = {
  requestId: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type SyncedThread = {
  // 快照同步按订阅的 thread 维护；实时 app-server 事件仍走同一条 WebSocket。
  appServerTurnsSyncing: boolean;
  appServerTurnsPending: boolean;
  appServerTurnsDebounceTimer?: NodeJS.Timeout;
};

type BridgeState = {
  threadIds: string[];
  // 这个 bridge 本地的 headless turn 兜底目标，不是 server/session 的 current thread。
  defaultThreadId?: string;
  threadCwds?: Record<string, string>;
};

type ThreadSettings = {
  model?: string | null;
  modelReasoningEffort?: ThreadRunOptions["modelReasoningEffort"] | null;
  serviceTier?: ThreadRunOptions["serviceTier"] | null;
  approvalPolicy?: ThreadRunOptions["approvalPolicy"] | null;
  sandboxPolicy?: ThreadRunOptions["sandboxPolicy"] | null;
  collaborationMode?: "plan" | "default" | null;
};

type HubTransportSink = {
  sendEvent: (event: SessionEventInput) => void;
  sendHeartbeat: (registration: Partial<SessionRegistration>) => void;
};

export type AppServerTransportFactory = () => Promise<AppServerSocketLike>;

export type HeadlessSessionTransportContext = {
  sessionId: string;
  apiBase: string;
  machineId?: string;
  cwd: string;
  appServerUrl: string;
};

export type HeadlessSessionTransportCallbacks = {
  registration: () => SessionRegistration;
  handleCommand: (command: SessionCommand) => Promise<unknown>;
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
  appServerTransportFactory?: AppServerTransportFactory;
  sessionId: string;
  machineId?: string;
  cwd: string;
  ensureDefaultThread?: boolean;
  readyLabel?: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  transportFactory: HeadlessSessionTransportFactory;
};

export type HeadlessCodexhubSessionOptions = {
  apiBase: string;
  cwd: string;
  machineId?: string;
  port?: number;
  appServerLaunch?: CodexAppServerLaunchOptions;
  readyLabel?: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  transportFactory: HeadlessSessionTransportFactory;
};

export type HeadlessCodexhubSessionHandle = {
  sessionId: string;
  threadId: string;
  appServerUrl: string;
  cwd: string;
  ensureThread: (threadId: string, cwd?: string) => Promise<string>;
  startThread: (cwd: string) => Promise<string>;
  runTurn: (input: ProxyInput, threadId?: string) => Promise<string>;
  stop: () => Promise<void>;
  wait: () => Promise<ChildExit>;
};

export type AttachedCodexhubSessionOptions = Omit<BridgeOptions, "sessionId" | "ensureDefaultThread"> & {
  sessionId?: string;
};

export async function startHeadlessCodexhubSession(options: HeadlessCodexhubSessionOptions): Promise<HeadlessCodexhubSessionHandle> {
  const cwd = path.resolve(options.cwd);
  // 这里的 headless session 自己启动 app-server，作为 machine runtime 暴露给 server。
  const appServer = await startCodexAppServerProcess(cwd, options.port, options.appServerLaunch);
  const sessionId = createSessionId();
  const bridgeRunner = new ProxyBridgeRunner({
    apiBase: options.apiBase,
    appServerUrl: appServer.appServerUrl,
    sessionId,
    machineId: options.machineId,
    cwd,
    ensureDefaultThread: true,
    readyLabel: options.readyLabel,
    model: options.model,
    sandbox: options.sandbox,
    approvalPolicy: options.approvalPolicy,
    transportFactory: options.transportFactory
  });
  const appServerStopped = appServer.wait();
  const cleanup = cleanupOnce(async () => {
    await bridgeRunner.stop();
    await appServer.stop();
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
      appServerUrl: appServer.appServerUrl,
      cwd,
      ensureThread: (threadId: string, cwd?: string) => bridgeRunner.ensureThread(threadId, cwd),
      startThread: (cwd: string) => bridgeRunner.startThread(cwd),
      runTurn: (input: ProxyInput, threadId?: string) => bridgeRunner.runTurn(input, threadId),
      stop: cleanup,
      wait: () => appServerStopped
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function startAttachedCodexhubSession(options: AttachedCodexhubSessionOptions): Promise<HeadlessCodexhubSessionHandle> {
  const cwd = path.resolve(options.cwd);
  const sessionId = options.sessionId?.trim() || createSessionId();
  // 这里的 attached session 不启动新进程，只把已有 app-server 接到 ThreadHub。
  const bridgeRunner = new ProxyBridgeRunner({
    ...options,
    sessionId,
    cwd,
    ensureDefaultThread: true
  });
  const cleanup = cleanupOnce(async () => {
    await bridgeRunner.stop();
  });

  bridgeRunner.start();
  try {
    const ready = await bridgeRunner.waitForReady();
    return {
      sessionId,
      threadId: ready.threadId,
      appServerUrl: options.appServerUrl,
      cwd,
      ensureThread: (threadId: string, cwd?: string) => bridgeRunner.ensureThread(threadId, cwd),
      startThread: (nextCwd: string) => bridgeRunner.startThread(nextCwd),
      runTurn: (input: ProxyInput, threadId?: string) => bridgeRunner.runTurn(input, threadId),
      stop: cleanup,
      wait: () => new Promise<ChildExit>(() => undefined)
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
  private readonly stopped = new Deferred<void>();
  private bridgeState: BridgeState = { threadIds: [] };

  constructor(private readonly options: BridgeOptions) {}

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

  async ensureThread(threadId: string, cwd?: string) {
    const trimmed = threadId.trim();
    if (!trimmed) throw new Error("Missing thread id.");
    if (!this.bridge) throw new Error("codexhub bridge is not connected.");
    const defaultThreadId = await this.bridge.ensureThreadDefault(trimmed, cwd);
    this.bridgeState = this.bridge.snapshotState();
    return defaultThreadId;
  }

  async startThread(cwd: string) {
    if (!this.bridge) throw new Error("codexhub bridge is not connected.");
    const { threadId } = await this.bridge.startThread(cwd, this.options.model);
    this.bridgeState = this.bridge.snapshotState();
    return threadId;
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
        try {
          // 重连时会重建 transport，但保留已订阅 thread 和 headless 默认 thread。
          const sink: HubTransportSink = {
            sendEvent: (event) => this.transport?.sendEvent(event),
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
          this.transport = this.options.transportFactory(transportContext, callbacks);
          if (this.options.ensureDefaultThread) {
            const threadId = await this.bridge.ensureDefaultThread();
            this.bridgeState = this.bridge.snapshotState();
            this.logHeadlessReady(threadId);
            this.ready.resolve({ sessionId: this.options.sessionId, threadId });
          }
          this.transport.start();
          await this.runBridge(this.bridge);
        } catch (error) {
          if (this.stopping) return;
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
    // 任一后台循环失败都会断开本次 bridge；runLoop 会用最新快照重连。
    void bridge.runThreadSyncLoop().catch(fail("thread sync"));
    void bridge.runHeartbeatLoop().catch(fail("heartbeat"));
    void bridge.waitForClose().then(() => stopped.reject(new Error("app-server bridge closed")));
    await stopped.promise;
  }

  private setTransportState(state: "connecting" | "online" | "offline", message: string) {
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

class CodexAppServerBridge {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly pendingApprovals = new Map<string, PendingApprovalRequest>();
  private readonly pendingUserInputs = new Map<string, PendingUserInputRequest>();
  private readonly syncedThreads = new Map<string, SyncedThread>();
  private readonly loadedThreads = new Set<string>();
  private readonly threadCwds = new Map<string, string>();
  private nextId = 1;
  private closed = false;
  private defaultThreadId: string | undefined;
  private readonly forwardedThreadSettings = new Map<string, string>();
  private readonly appServerThreadSettings = new Map<string, ThreadSettings>();
  private readonly planResetModes = new Map<string, AppServerCollaborationMode>();
  private readonly bridgeStartedThreads = new Set<string>();
  private bridgeStartedUnknownCount = 0;
  private readonly closeSignal = new Deferred<void>();

  private constructor(
    private readonly options: BridgeOptions,
    private readonly ws: AppServerSocketLike,
    initialState: BridgeState,
    private readonly hub: HubTransportSink
  ) {
    this.defaultThreadId = initialState.defaultThreadId;
    for (const [threadId, cwd] of Object.entries(initialState.threadCwds ?? {})) {
      this.threadCwds.set(threadId, cwd);
    }
    for (const threadId of initialState.threadIds) this.bindThread(threadId, this.threadCwds.get(threadId));
  }

  static async connect(options: BridgeOptions, initialState: BridgeState = { threadIds: [] }, hub: HubTransportSink) {
    const ws = options.appServerTransportFactory
      ? await options.appServerTransportFactory()
      : await openWebSocket(options.appServerUrl);
    const bridge = new CodexAppServerBridge(options, ws, initialState, hub);
    ws.addEventListener("message", (event) => void bridge.handleMessage(event.data));
    ws.addEventListener("error", () => {
      if (!bridge.closed) console.error("codex app-server websocket error");
    });
    ws.addEventListener("close", () => bridge.markClosed());
    // 官方 app-server 通过这条 socket 说 JSON-RPC，必须先 initialize。
    await bridge.request("initialize", {
      clientInfo: { name: "codexhub", title: "codexhub bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    bridge.notify("initialized");
    void bridge.syncAccountRateLimits();
    return bridge;
  }

  snapshotState(): BridgeState {
    return {
      threadIds: [...this.syncedThreads.keys()],
      defaultThreadId: this.defaultThreadId,
      threadCwds: Object.fromEntries(this.threadCwds)
    };
  }

  async ensureDefaultThread() {
    // 这里的 headless session 暴露一个 ready/default thread，用于 CLI 兜底和启动输出。
    if (this.defaultThreadId) {
      const threadId = await this.ensureThreadLoaded(this.defaultThreadId, this.options.cwd, this.options.model);
      await this.rememberDefaultThread(threadId);
      return threadId;
    }
    const result = asRecord(await this.request("thread/start", {
      cwd: this.options.cwd,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...permissionParams(this.options),
      threadSource: "user"
    }));
    const thread = asRecord(result?.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex app-server thread/start did not return thread.id");
    this.markThreadLoaded(threadId);
    await this.rememberDefaultThread(threadId);
    return threadId;
  }

  async ensureThreadDefault(threadId: string, cwd?: string) {
    const defaultThreadId = await this.ensureThreadLoaded(threadId, cwd ?? this.options.cwd, this.options.model, { threadId });
    await this.rememberDefaultThread(defaultThreadId);
    return defaultThreadId;
  }

  async startThread(cwd: string, model?: string | null) {
    return await this.startNewThread(cwd, model, {});
  }

  async runCommand(command: SessionCommand) {
    return await this.handleCommand(command);
  }

  async runLocalTurn(input: ProxyInput, threadId?: string) {
    const targetThreadId = threadId
      ? await this.ensureThreadLoaded(threadId, this.options.cwd, this.options.model, undefined, {
        markBridgeStarted: true
      })
      : await this.ensureDefaultThread();
    this.markBridgeStartedThread(targetThreadId);
    await this.request("turn/start", {
      threadId: targetThreadId,
      input: toAppServerInput(input),
      ...turnRequestParams(undefined)
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
      await this.syncThreadSettings(entries.map(([threadId]) => threadId));
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
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("codex app-server bridge closed before request completed"));
    }
    this.pending.clear();
    this.pendingApprovals.clear();
    this.pendingUserInputs.clear();
    for (const state of this.syncedThreads.values()) {
      this.closeAppServerTurnsSync(state);
    }
    this.closeSignal.resolve();
  }

  private async handleCommand(command: SessionCommand) {
    return await dispatchAppServerCommand(command, {
      defaultModel: this.options.model,
      permissionParams: permissionParams(this.options),
      listThreads: (cwd, limit) => this.listAppServerThreads(cwd, limit),
      listModels: (includeHidden) => this.listAppServerModels(includeHidden),
      listCollaborationModes: () => this.request("collaborationMode/list", {}),
      cachedThreadSettings: (threadId) => this.appServerThreadSettings.get(threadId),
      readThreadSettings: (cwd) => this.readThreadSettings(cwd),
      cacheThreadCollaborationMode: (threadId, value) => {
        this.appServerThreadSettings.set(threadId, {
          ...this.appServerThreadSettings.get(threadId),
          model: value.settings.model,
          modelReasoningEffort: value.settings.reasoning_effort,
          collaborationMode: value.mode
        });
      },
      planResetModes: this.planResetModes,
      listCommandPalette: (cwd, part) => this.listAppServerCommandPalette(cwd, part),
      bindThread: (threadId, cwd) => this.bindThread(threadId, cwd),
      unbindThread: (threadId) => this.unbindThread(threadId),
      syncThreadTurns: (threadId) => this.syncThreadAppServerTurns(threadId),
      startThread: (cwd, model, context) => this.startNewThread(cwd, model, context),
      loadThread: (threadId, cwd, model, context, options) =>
        this.loadThread(threadId, cwd, model, context, options),
      ensureThreadLoaded: (threadId, cwd, model, context, options) =>
        this.ensureThreadLoaded(threadId, cwd, model, context, options),
      rememberDefaultThread: (threadId) => this.rememberDefaultThread(threadId),
      request: (method, params, context) => this.request(method, params, context),
      scheduleThreadSync: (threadId) => this.scheduleAppServerTurnsSync(threadId),
      forwardThreadExecutionChanged: (threadId, running, turnId) =>
        this.forwardThreadExecutionChanged(threadId, running, turnId),
      resolveApprovalRequest: (approvalId, decision) => this.resolveApprovalRequest(approvalId, decision),
      resolveUserInputRequest: (userInputId, answers) => this.resolveUserInputRequest(userInputId, answers),
      markBridgeStartedUnknownThread: () => this.markBridgeStartedUnknownThread(),
      markThreadLoaded: (threadId) => this.markThreadLoaded(threadId),
      markBridgeStartedThread: (threadId) => this.markBridgeStartedThread(threadId)
    });
  }
  private async startNewThread(
    cwd: string,
    model: string | null | undefined,
    command: { commandId?: string; threadId?: string }
  ) {
    const result = asRecord(await this.request("thread/start", {
      cwd,
      ...(model === undefined ? {} : { model }),
      ...permissionParams(this.options),
      threadSource: "user"
    }, command));
    const thread = asRecord(result?.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex app-server thread/start did not return thread.id");
    this.rememberThreadCwd(threadId, cwd);
    this.markThreadLoaded(threadId);
    await this.rememberDefaultThread(threadId);
    return { threadId, ...(thread ? { thread } : {}) };
  }

  private request(method: string, params: unknown, command?: { threadId?: string; commandId?: string }) {
    // 每个请求都登记 pending，响应回来时才能把结果和 command/thread 对上。
    const id = this.nextId++;
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error(`codex app-server request timed out after ${appServerRequestTimeoutMs()}ms: ${method}`));
      }, appServerRequestTimeoutMs());
      timeout.unref?.();
      this.pending.set(id, {
        method,
        threadId: command?.threadId,
        commandId: command?.commandId,
        timeout,
        resolve,
        reject
      });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown) {
    this.ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  private async handleMessage(data: unknown) {
    const message = parseJsonRecord(data);
    if (!message) return;
    this.rememberThreads(message);

    // 这里的 JSON-RPC 响应会回到 pending command，但其中仍可能携带 thread 状态。
    if ((typeof message.id === "string" || typeof message.id === "number") && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      const error = asRecord(message.error);
      const threadId = threadIdForPendingMessage(pending, message);
      if (threadId) {
        await this.forwardThreadEvent(threadId, pending.commandId, message);
        if (!error) await this.forwardExecutionStateFromMessage(threadId, message);
      }
      if (error) pending.reject(new Error(JSON.stringify(error)));
      else {
        this.rememberLoadedThread(pending, message);
        pending.resolve(message.result);
      }
      return;
    }

    if (this.forwardSessionEventFromMessage(message)) return;

    if ((typeof message.id === "string" || typeof message.id === "number") && typeof message.method === "string") {
      this.respondToServerRequest(message);
      return;
    }

    const threadId = this.threadIdForMessage(message);
    if (threadId) {
      await this.forwardAppServerThreadNotification(threadId, message);
    }
  }

  private rememberThreads(message: JsonRecord) {
    const result = asRecord(message.result);
    const resultThread = asRecord(result?.thread);
    if (typeof resultThread?.id === "string") {
      this.loadedThreads.add(resultThread.id);
      this.rememberThreadCwdFromThread(resultThread);
    }
    const params = asRecord(message.params);
    const paramsThread = asRecord(params?.thread);
    if (paramsThread) this.rememberThreadCwdFromThread(paramsThread);
  }

  private rememberLoadedThread(pending: PendingRequest, message: JsonRecord) {
    if (pending.method !== "thread/start" && pending.method !== "thread/resume" && pending.method !== "thread/fork") return;
    const threadId = resultThreadIdForMessage(message);
    if (threadId) {
      this.markThreadLoaded(threadId);
    }
  }

  private threadIdForMessage(message: JsonRecord) {
    const threadId = threadIdForMessage(message);
    if (!threadId) return undefined;
    return threadId;
  }

  private forwardSessionEventFromMessage(message: JsonRecord) {
    const method = typeof message.method === "string" ? message.method : "";
    if (method !== "account/rateLimits/updated") return false;
    void this.syncAccountRateLimits().then((synced) => {
      if (!synced) this.forwardAccountRateLimits(message);
    });
    return true;
  }

  private async syncAccountRateLimits() {
    try {
      const result = await this.request("account/rateLimits/read", undefined);
      return this.forwardAccountRateLimits(result);
    } catch {
      return false;
    }
  }

  private forwardAccountRateLimits(value: unknown) {
    const rateLimits = accountRateLimitsPayloadFromValue(value);
    if (!rateLimits) return false;
    this.hub.sendEvent({
      type: "account_rate_limits_updated",
      rateLimits,
      heartbeat: false
    });
    return true;
  }

  private bindThread(threadId: string, cwd?: string) {
    if (cwd) this.rememberThreadCwd(threadId, cwd);
    if (this.syncedThreads.has(threadId)) return;
    this.syncedThreads.set(threadId, {
      appServerTurnsSyncing: false,
      appServerTurnsPending: false
    });
    this.scheduleAppServerTurnsSync(threadId);
  }

  private unbindThread(threadId: string) {
    const state = this.syncedThreads.get(threadId);
    if (!state) return;
    this.closeAppServerTurnsSync(state);
    this.syncedThreads.delete(threadId);
    this.forwardedThreadSettings.delete(threadId);
  }

  private markThreadLoaded(threadId: string) {
    this.loadedThreads.add(threadId);
  }

  private rememberThreadCwd(threadId: string, cwd: string | undefined | null) {
    const value = typeof cwd === "string" && cwd ? cwd : undefined;
    if (!threadId || !value) return;
    this.threadCwds.set(threadId, value);
  }

  private rememberThreadCwdFromThread(thread: JsonRecord) {
    const threadId = typeof thread.id === "string" ? thread.id : "";
    const cwd = typeof thread.cwd === "string" ? thread.cwd : undefined;
    this.rememberThreadCwd(threadId, cwd);
  }

  private async ensureThreadLoaded(
    threadId: string,
    cwd: string,
    model?: string | null,
    command?: { threadId?: string; commandId?: string },
    options: { markBridgeStarted?: boolean } = {}
  ) {
    return (await this.loadThread(threadId, cwd, model, command, options)).threadId;
  }

  private async loadThread(
    threadId: string,
    cwd: string,
    model?: string | null,
    command?: { threadId?: string; commandId?: string },
    options: { markBridgeStarted?: boolean } = {}
  ) {
    if (this.loadedThreads.has(threadId)) return { threadId };
    // 执行 app-server 操作前先 resume thread，确保 cwd/model 和当前 runtime 绑定。
    this.rememberThreadCwd(threadId, cwd);
    if (options.markBridgeStarted) this.markBridgeStartedThread(threadId);
    const result = asRecord(await this.request("thread/resume", {
      threadId,
      cwd,
      ...(model === undefined ? {} : { model }),
      ...permissionParams(this.options)
    }, command));
    const thread = asRecord(result?.thread);
    if (!thread || typeof thread.id !== "string") {
      throw new Error("Codex app-server thread/resume did not return thread.id");
    }
    const loadedThreadId = thread.id;
    this.rememberThreadCwd(loadedThreadId, typeof thread?.cwd === "string" ? thread.cwd : cwd);
    this.markThreadLoaded(loadedThreadId);
    return { threadId: loadedThreadId, thread };
  }

  private scheduleAppServerTurnsSync(
    threadId: string,
    options: { delayMs?: number } = {}
  ) {
    const state = this.syncedThreads.get(threadId);
    if (!state || this.closed) return;
    if (state.appServerTurnsDebounceTimer) clearTimeout(state.appServerTurnsDebounceTimer);
    state.appServerTurnsDebounceTimer = setTimeout(() => {
      state.appServerTurnsDebounceTimer = undefined;
      void this.syncThreadAppServerTurns(threadId).catch((error) => {
        console.error(`codexhub bridge failed to sync app-server turns for ${threadId}: ${errorText(error)}`);
      });
    }, options.delayMs ?? 75);
    state.appServerTurnsDebounceTimer.unref?.();
  }

  private async syncThreadAppServerTurns(threadId: string) {
    const state = this.syncedThreads.get(threadId);
    if (!state || this.closed) return;
    const stillObserved = () => this.syncedThreads.get(threadId) === state && !this.closed;
    if (state.appServerTurnsSyncing) {
      state.appServerTurnsPending = true;
      return;
    }

    state.appServerTurnsSyncing = true;
    state.appServerTurnsPending = false;
    try {
      const cwd = this.threadCwds.get(threadId) ?? this.options.cwd;
      const loadedThreadId = await this.ensureThreadLoaded(threadId, cwd, this.options.model, undefined, {
        markBridgeStarted: true
      });
      if (!stillObserved()) return;
      const goalResult = asRecord(await this.request("thread/goal/get", { threadId: loadedThreadId }));
      if (!goalResult || !hasOwn(goalResult, "goal")) {
        throw new Error("Codex app-server thread/goal/get did not return goal");
      }
      if (!stillObserved()) return;
      await this.forwardThreadEvent(
        loadedThreadId,
        undefined,
        { result: goalResult },
        { heartbeat: false, historical: true }
      );
      if (!stillObserved()) return;
      // 快照补历史 records；实时 app-server 消息会单独转发。
      const turns = await this.listAppServerThreadTurnsOrEmpty(loadedThreadId);
      if (!stillObserved()) return;
      this.hub.sendEvent({
        type: "thread_turns_snapshot",
        threadId: loadedThreadId,
        turns,
        heartbeat: false
      });
    } finally {
      state.appServerTurnsSyncing = false;
      if (state.appServerTurnsPending && !this.closed) this.scheduleAppServerTurnsSync(threadId);
    }
  }

  private closeAppServerTurnsSync(state: SyncedThread) {
    if (state.appServerTurnsDebounceTimer) clearTimeout(state.appServerTurnsDebounceTimer);
    state.appServerTurnsDebounceTimer = undefined;
    state.appServerTurnsPending = false;
  }

  private async listAppServerThreads(workingDirectory: string, limit?: number): Promise<ThreadCandidateSummary[]> {
    const result = asRecord(await this.request("thread/list", {
      cwd: workingDirectory,
      limit: Number.isInteger(limit) && limit !== undefined && limit > 0 ? limit : null,
      sortKey: "updated_at",
      sortDirection: "desc"
    }));
    const data = Array.isArray(result?.data) ? result.data : [];
    return data
      .map((thread) => appServerThreadSummary(asRecord(thread), workingDirectory))
      .filter((thread): thread is ThreadCandidateSummary => Boolean(thread));
  }

  private async listAppServerModels(includeHidden = false): Promise<ModelCatalogItem[]> {
    const models: ModelCatalogItem[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = asRecord(await this.request("model/list", {
        ...(cursor ? { cursor } : {}),
        limit: 200,
        includeHidden
      }));
      const data = Array.isArray(result?.data) ? result.data : [];
      models.push(...data
        .map((item) => appServerModelCatalogItem(asRecord(item)))
        .filter((item): item is ModelCatalogItem => Boolean(item)));
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    return models;
  }

  private async listAppServerCommandPalette(cwd: string, part: CommandPalettePart = "all"): Promise<CommandPalette> {
    if (part === "plugins") {
      const directSkills = await this.listCommandPaletteDirectSkills(cwd);
      const skillPluginNames = new Set(directSkills.flatMap((entry) => pluginNameFromSkillName(entry.name)));
      const pluginEntries = await this.listCommandPalettePluginEntries(cwd, skillPluginNames);
      return {
        cwd,
        generatedAt: new Date().toISOString(),
        entries: dedupeCommandPaletteEntries(pluginEntries)
      };
    }

    const { config, directSkills } = await this.listCommandPaletteCoreEntries(cwd);
    if (part === "core") {
      return {
        cwd,
        generatedAt: new Date().toISOString(),
        entries: dedupeCommandPaletteEntries([
          ...builtinCommandPaletteEntries(config),
          ...directSkills
        ])
      };
    }

    const skillPluginNames = new Set(directSkills.flatMap((entry) => pluginNameFromSkillName(entry.name)));
    const pluginEntries = await this.listCommandPalettePluginEntries(cwd, skillPluginNames);
    return {
      cwd,
      generatedAt: new Date().toISOString(),
      entries: dedupeCommandPaletteEntries([
        ...builtinCommandPaletteEntries(config),
        ...pluginEntries,
        ...directSkills
      ])
    };
  }

  private async listCommandPaletteCoreEntries(cwd: string) {
    const [config, directSkills] = await Promise.all([
      this.readCommandPaletteConfig(cwd).catch((error) => {
        console.error(`codexhub bridge failed to read app-server config for command palette: ${errorText(error)}`);
        return null;
      }),
      this.listCommandPaletteDirectSkills(cwd)
    ]);
    return { config, directSkills };
  }

  private async listCommandPaletteDirectSkills(cwd: string) {
    return await this.listAppServerSkillPaletteEntries(cwd).catch((error) => {
      console.error(`codexhub bridge failed to list app-server skills: ${errorText(error)}`);
      return [] as CommandPaletteEntry[];
    });
  }

  private async listCommandPalettePluginEntries(cwd: string, skillPluginNames: ReadonlySet<string>) {
    return await this.listAppServerPluginPaletteEntries(cwd, skillPluginNames).catch((error) => {
      console.error(`codexhub bridge failed to list app-server plugins: ${errorText(error)}`);
      return [] as CommandPaletteEntry[];
    });
  }

  private async readCommandPaletteConfig(cwd: string) {
    const result = asRecord(await this.request("config/read", {
      cwd,
      includeLayers: false
    }));
    return asRecord(result?.config);
  }

  private async listAppServerSkillPaletteEntries(cwd: string): Promise<CommandPaletteEntry[]> {
    const result = asRecord(await this.request("skills/list", {
      cwds: [cwd],
      forceReload: false
    }));
    const groups = Array.isArray(result?.data) ? result.data : [];
    return groups.flatMap((group) => {
      const record = asRecord(group);
      const skills = Array.isArray(record?.skills) ? record.skills : [];
      return skills
        .map((skill) => commandPaletteEntryFromSkill(asRecord(skill), undefined))
        .filter((entry): entry is CommandPaletteEntry => Boolean(entry));
    });
  }

  private async listAppServerPluginPaletteEntries(
    cwd: string,
    skillPluginNames: ReadonlySet<string>
  ): Promise<CommandPaletteEntry[]> {
    const result = asRecord(await this.request("plugin/list", {
      cwds: [cwd],
      marketplaceKinds: ["local", "vertical", "workspace-directory"]
    }));
    const marketplaces = Array.isArray(result?.marketplaces) ? result.marketplaces : [];
    const featuredPluginIds = Array.isArray(result?.featuredPluginIds)
      ? result.featuredPluginIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    const featuredPluginNames = new Set(featuredPluginIds.map(pluginNameFromId).filter(Boolean));
    const pluginReads = marketplaces.flatMap((marketplace) => {
      const marketplaceRecord = asRecord(marketplace);
      const marketplacePath = stringField(marketplaceRecord, "path");
      if (!marketplacePath) return [];
      const plugins = Array.isArray(marketplaceRecord?.plugins) ? marketplaceRecord.plugins : [];
      return plugins.flatMap((plugin) => {
        const pluginRecord = asRecord(plugin);
        const id = stringField(pluginRecord, "id");
        const name = stringField(pluginRecord, "name") || pluginNameFromId(id);
        if (!name) return [];
        const installed = pluginRecord?.installed === true;
        const enabled = pluginRecord?.enabled === true;
        const featured = (id && featuredPluginIds.includes(id)) || featuredPluginNames.has(name);
        if (!installed && !enabled && !featured && !skillPluginNames.has(name)) return [];
        return [{ marketplacePath, pluginName: name }];
      });
    });

    const details = await Promise.all(pluginReads.slice(0, 40).map(async ({ marketplacePath, pluginName }) => {
      try {
        return {
          pluginName,
          detail: asRecord(await this.request("plugin/read", {
            marketplacePath,
            pluginName
          }))
        };
      } catch (error) {
        console.error(`codexhub bridge failed to read app-server plugin ${pluginName}: ${errorText(error)}`);
        return { pluginName, detail: null };
      }
    }));

    return details.flatMap(({ detail, pluginName }) => {
      const plugin = asRecord(detail?.plugin);
      if (!plugin) return [];
      const summary = asRecord(plugin.summary);
      const pluginEntry = commandPaletteEntryFromPlugin(summary, pluginName);
      const pluginDisplayName = pluginEntry?.title || stringField(summary, "name") || pluginName || "Plugin";
      const skills = Array.isArray(plugin.skills) ? plugin.skills : [];
      return [
        ...(pluginEntry ? [pluginEntry] : []),
        ...skills
          .map((skill) => commandPaletteEntryFromSkill(asRecord(skill), pluginDisplayName))
          .filter((entry): entry is CommandPaletteEntry => Boolean(entry))
      ];
    });
  }

  private async listAppServerThreadTurns(threadId: string) {
    const turns: unknown[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = asRecord(await this.request("thread/turns/list", {
        threadId,
        cursor,
        limit: 50,
        sortDirection: "asc",
        itemsView: "full"
      }));
      const data = Array.isArray(result?.data) ? result.data : [];
      turns.push(...data);
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    return turns;
  }

  private async listAppServerThreadTurnsOrEmpty(threadId: string) {
    try {
      return await this.listAppServerThreadTurns(threadId);
    } catch (error) {
      if (appServerTurnsListUnavailableBeforeFirstMessage(error)) return [];
      throw error;
    }
  }

  resetServerMirrorState() {
    this.forwardedThreadSettings.clear();
    for (const [threadId] of this.syncedThreads) {
      // 当 server 侧 transport 重连后，需要重新推送已订阅 thread 的快照状态。
      this.scheduleAppServerTurnsSync(threadId);
    }
  }

  private async syncThreadSettings(threadIds: string[]) {
    if (!threadIds.length) return;
    try {
      await Promise.all(threadIds.map(async (threadId) => {
        // app-server 的 per-thread settings 是权威值；config/read 只作为尚未收到
        // thread/settings/updated 时的 cwd 初始兜底。
        let settings = this.appServerThreadSettings.get(threadId);
        if (!settings) {
          const configSettings = await this.readThreadSettings(this.threadCwds.get(threadId) ?? this.options.cwd);
          // A live notification may have arrived while config/read was pending.
          settings = this.appServerThreadSettings.get(threadId) ?? configSettings;
        }
        const snapshot = JSON.stringify(settings);
        if (this.forwardedThreadSettings.get(threadId) === snapshot) return;
        this.forwardedThreadSettings.set(threadId, snapshot);
        await this.forwardThreadSettings(threadId, settings);
      }));
    } catch (error) {
      console.error(`codexhub bridge failed to sync thread settings: ${errorText(error)}`);
    }
  }

  private async readThreadSettings(cwd: string): Promise<ThreadSettings> {
    const result = asRecord(await this.request("config/read", {
      cwd,
      includeLayers: false
    }));
    const config = asRecord(result?.config);
    const model = config?.model;
    const modelReasoningEffort = config?.model_reasoning_effort;
    const serviceTier = config?.service_tier;
    const approvalPolicy = config?.approval_policy;
    const sandboxPolicy = sandboxPolicyFromConfig(config);
    return {
      model: typeof model === "string" && model ? model : null,
      modelReasoningEffort: isModelReasoningEffort(modelReasoningEffort) ? modelReasoningEffort : null,
      serviceTier: typeof serviceTier === "string" && serviceTier ? serviceTier : null,
      ...(config && hasOwn(config, "approval_policy")
        ? { approvalPolicy: isThreadApprovalPolicy(approvalPolicy) ? approvalPolicy : null }
        : {}),
      ...(config && hasOwn(config, "sandbox_mode")
        ? { sandboxPolicy: sandboxPolicy ?? null }
        : {})
    };
  }

  private async forwardThreadEvent(
    threadId: string,
    commandId: string | undefined,
    message: JsonRecord,
    options: { heartbeat?: boolean; historical?: boolean } = {}
  ) {
    // 原始 app-server 消息保留给 ThreadHub 归一化为 transcript records。
    this.hub.sendEvent({
      type: "thread_event",
      threadId,
      commandId,
      message,
      heartbeat: options.heartbeat,
      historical: options.historical
    });
  }

  private async forwardAppServerThreadNotification(threadId: string, message: JsonRecord) {
    // 同一条 app-server 通知同时驱动控制面状态和 transcript，统一在这里排序。
    await this.forwardDerivedStateFromMessage(threadId, message);
    await this.forwardThreadEvent(threadId, undefined, message);
  }

  private async forwardDerivedStateFromMessage(threadId: string, message: JsonRecord) {
    // 从原始消息提取控制面状态，不直接生成 transcript record。
    const method = typeof message.method === "string" ? message.method : "";
    if (method === "thread/started") {
      this.markThreadLoaded(threadId);
      if (this.bridgeStartedThreads.has(threadId)) {
        this.bridgeStartedThreads.delete(threadId);
      } else if (this.bridgeStartedUnknownCount > 0) {
        this.bridgeStartedUnknownCount -= 1;
      } else {
        await this.rememberDefaultThread(threadId);
      }
    }
    await this.forwardExecutionStateFromMessage(threadId, message);

    if (method !== "thread/settings/updated") return;
    const params = asRecord(message.params);
    const settings = asRecord(params?.threadSettings);
    if (!settings) return;
    const collaborationMode = asRecord(settings.collaborationMode);
    const threadSettings: ThreadSettings = {
      model: typeof settings.model === "string" && settings.model ? settings.model : null,
      modelReasoningEffort: isModelReasoningEffort(settings.effort) ? settings.effort : null,
      serviceTier: typeof settings.serviceTier === "string" && settings.serviceTier
        ? settings.serviceTier
        : null,
      ...threadApprovalPolicySettings(settings),
      ...threadSandboxPolicySettings(settings),
      collaborationMode: collaborationMode?.mode === "plan" || collaborationMode?.mode === "default"
        ? collaborationMode.mode
        : null
    };
    this.appServerThreadSettings.set(threadId, threadSettings);
    this.forwardedThreadSettings.set(threadId, JSON.stringify(threadSettings));
    await this.forwardThreadSettings(threadId, threadSettings);
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
      const status = asRecord(params?.status);
      const type = typeof status?.type === "string" ? status.type : "";
      if (type === "active") {
        await this.forwardThreadExecutionChanged(threadId, true);
        return;
      }
      if (type === "idle" || type === "notLoaded" || type === "systemError") {
        await this.forwardThreadExecutionChanged(threadId, false);
      }
    }
  }

  private async rememberDefaultThread(threadId: string) {
    if (this.defaultThreadId === threadId) return;
    this.defaultThreadId = threadId;
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

  private async forwardThreadSettings(threadId: string, settings: ThreadSettings) {
    this.hub.sendEvent({
      type: "thread_settings_changed",
      threadId,
      model: settings.model,
      modelReasoningEffort: settings.modelReasoningEffort,
      serviceTier: settings.serviceTier,
      approvalPolicy: settings.approvalPolicy,
      sandboxPolicy: settings.sandboxPolicy,
      heartbeat: false
    });
  }

  private respondToServerRequest(message: JsonRecord) {
    // app-server 主动询问时，能交给 Web 的 approval request 先保持挂起。
    const method = typeof message.method === "string" ? message.method : "";
    const id = message.id;
    if (method === "item/commandExecution/requestApproval") {
      this.forwardApprovalRequest(message, "command_execution");
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      this.forwardApprovalRequest(message, "file_change");
      return;
    }
    if (method === "item/permissions/requestApproval") {
      this.forwardApprovalRequest(message, "permissions_request");
      return;
    }
    if (method === "item/tool/call") {
      this.ws.send(JSON.stringify({
        id,
        result: {
          contentItems: [{ type: "inputText", text: `codexhub bridge has no dynamic tool handler for ${method}` }],
          success: false
        }
      }));
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.forwardUserInputRequest(message);
      return;
    }
    if (method === "currentTime/read") {
      this.ws.send(JSON.stringify({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }));
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.forwardApprovalRequest(message, "mcp_elicitation");
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

  private forwardApprovalRequest(message: JsonRecord, kind: AppServerApprovalKind) {
    const method = typeof message.method === "string" ? message.method : "";
    const requestId = message.id;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const params = asRecord(message.params) ?? {};
    const threadId = approvalThreadId(params);
    if (!threadId) {
      this.ws.send(JSON.stringify({ id: requestId, result: approvalResponse(method, "deny", params) }));
      return;
    }

    const approvalId = randomUUID();
    this.pendingApprovals.set(approvalId, { requestId, method, params });
    this.hub.sendEvent({
      type: "approval_request",
      threadId,
      approval: {
        approvalId,
        method,
        requestId,
        kind,
        threadId,
        ...(approvalTurnId(params) ? { turnId: approvalTurnId(params) } : {}),
        ...(approvalItemId(params) ? { itemId: approvalItemId(params) } : {}),
        createdAt: approvalCreatedAt(params),
        params
      },
      heartbeat: false
    });
  }

  private resolveApprovalRequest(approvalId: string, decision: AppServerApprovalDecision) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new Error(`Approval request not found: ${approvalId}`);
    this.pendingApprovals.delete(approvalId);
    this.ws.send(JSON.stringify({
      id: pending.requestId,
      result: approvalResponse(pending.method, decision, pending.params)
    }));
  }

  private forwardUserInputRequest(message: JsonRecord) {
    const method = typeof message.method === "string" ? message.method : "";
    const requestId = message.id;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const params = asRecord(message.params) ?? {};
    const threadId = approvalThreadId(params);
    if (!threadId) {
      this.ws.send(JSON.stringify({ id: requestId, result: { answers: {} } }));
      return;
    }

    const userInputId = randomUUID();
    this.pendingUserInputs.set(userInputId, { requestId, method, params });
    this.hub.sendEvent({
      type: "user_input_request",
      threadId,
      userInput: {
        userInputId,
        method,
        requestId,
        threadId,
        ...(approvalTurnId(params) ? { turnId: approvalTurnId(params) } : {}),
        ...(approvalItemId(params) ? { itemId: approvalItemId(params) } : {}),
        createdAt: approvalCreatedAt(params),
        questions: userInputQuestions(params),
        params
      },
      heartbeat: false
    });
  }

  private resolveUserInputRequest(userInputId: string, answers: AppServerUserInputAnswers) {
    const pending = this.pendingUserInputs.get(userInputId);
    if (!pending) throw new Error(`User input request not found: ${userInputId}`);
    this.pendingUserInputs.delete(userInputId);
    this.ws.send(JSON.stringify({
      id: pending.requestId,
      result: { answers }
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

const appServerRequestTimeoutMs = () => envPositiveInt("CODEX_HUB_APP_SERVER_REQUEST_TIMEOUT_MS", 60_000);

const openWebSocket = async (url: string) => {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`WebSocket failed: ${url}`)), { once: true });
  });
  return ws;
};

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const envPositiveInt = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const isThreadApprovalPolicy = (value: unknown): value is ThreadRunOptions["approvalPolicy"] =>
  value === "untrusted" || value === "on-request" || value === "never";

const threadApprovalPolicySettings = (settings: Record<string, unknown>): Pick<ThreadSettings, "approvalPolicy"> => {
  if (hasOwn(settings, "approvalPolicy")) {
    return { approvalPolicy: isThreadApprovalPolicy(settings.approvalPolicy) ? settings.approvalPolicy : null };
  }
  return {};
};

const threadSandboxPolicySettings = (settings: Record<string, unknown>): Pick<ThreadSettings, "sandboxPolicy"> => {
  if (hasOwn(settings, "sandboxPolicy")) {
    return { sandboxPolicy: asThreadSandboxPolicy(settings.sandboxPolicy) ?? null };
  }
  return {};
};

const sandboxPolicyFromConfig = (config: JsonRecord | null): ThreadRunOptions["sandboxPolicy"] | undefined => {
  if (!config) return undefined;
  const mode = config.sandbox_mode;
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  if (mode !== "workspace-write") return undefined;
  const workspaceWrite = asRecord(config.sandbox_workspace_write);
  const writableRoots = Array.isArray(workspaceWrite?.writable_roots)
    ? workspaceWrite.writable_roots.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return {
    type: "workspaceWrite",
    writableRoots,
    networkAccess: workspaceWrite?.network_access === true,
    excludeTmpdirEnvVar: workspaceWrite?.exclude_tmpdir_env_var === true,
    excludeSlashTmp: workspaceWrite?.exclude_slash_tmp === true
  };
};

const asThreadSandboxPolicy = (value: unknown): ThreadRunOptions["sandboxPolicy"] | undefined => {
  const policy = asRecord(value);
  if (!policy || typeof policy.type !== "string") return undefined;
  if (policy.type === "dangerFullAccess") return { type: "dangerFullAccess" };
  if (policy.type === "readOnly" && typeof policy.networkAccess === "boolean") {
    return { type: "readOnly", networkAccess: policy.networkAccess };
  }
  if (policy.type === "externalSandbox" && (policy.networkAccess === "restricted" || policy.networkAccess === "enabled")) {
    return { type: "externalSandbox", networkAccess: policy.networkAccess };
  }
  if (policy.type !== "workspaceWrite" || !Array.isArray(policy.writableRoots)) return undefined;
  const writableRoots = policy.writableRoots.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (
    writableRoots.length !== policy.writableRoots.length
    || typeof policy.networkAccess !== "boolean"
    || typeof policy.excludeTmpdirEnvVar !== "boolean"
    || typeof policy.excludeSlashTmp !== "boolean"
  ) {
    return undefined;
  }
  return {
    type: "workspaceWrite",
    writableRoots,
    networkAccess: policy.networkAccess,
    excludeTmpdirEnvVar: policy.excludeTmpdirEnvVar,
    excludeSlashTmp: policy.excludeSlashTmp
  };
};

const approvalResponse = (
  method: string,
  decision: AppServerApprovalDecision,
  params?: Record<string, unknown>
) => {
  if (method === "mcpServer/elicitation/request") {
    if (decision === "cancel") return { action: "cancel", content: null, _meta: null };
    return decision === "approve" || decision === "approve_for_session"
      ? { action: "accept", content: mcpElicitationDefaultContent(params), _meta: null }
      : { action: "decline", content: null, _meta: null };
  }
  if (method === "item/permissions/requestApproval") {
    return permissionsApprovalResponse(decision, params);
  }
  return { decision: modernApprovalDecision(decision) };
};

const modernApprovalDecision = (decision: AppServerApprovalDecision) => {
  if (decision === "approve") return "accept";
  if (decision === "approve_for_session") return "acceptForSession";
  if (decision === "cancel") return "cancel";
  return "decline";
};

const permissionsApprovalResponse = (
  decision: AppServerApprovalDecision,
  params: Record<string, unknown> | undefined
) => {
  if (decision === "approve" || decision === "approve_for_session") {
    return {
      permissions: requestedPermissionsGrant(params),
      scope: decision === "approve_for_session" ? "session" : "turn"
    };
  }
  return { permissions: {}, scope: "turn" };
};

const requestedPermissionsGrant = (params: Record<string, unknown> | undefined) => {
  const permissions = asRecord(params?.permissions);
  if (!permissions) return {};
  const granted: Record<string, unknown> = {};
  if (permissions.network !== null && permissions.network !== undefined) granted.network = permissions.network;
  if (permissions.fileSystem !== null && permissions.fileSystem !== undefined) granted.fileSystem = permissions.fileSystem;
  return granted;
};

const mcpElicitationDefaultContent = (params: Record<string, unknown> | undefined) => {
  const requestedSchema = asRecord(params?.requestedSchema);
  const properties = asRecord(requestedSchema?.properties);
  if (!properties) return {};

  const content: Record<string, unknown> = {};
  for (const [key, rawSchema] of Object.entries(properties)) {
    const fieldSchema = asRecord(rawSchema);
    if (!fieldSchema || !Object.prototype.hasOwnProperty.call(fieldSchema, "default")) continue;
    content[key] = fieldSchema.default;
  }
  return content;
};

const userInputQuestions = (params: Record<string, unknown>) => {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return questions.flatMap((question) => {
    const record = asRecord(question);
    const id = stringValue(record?.id);
    if (!id) return [];
    return [{
      id,
      header: stringValue(record?.header) ?? "",
      question: stringValue(record?.question) ?? "",
      isOther: record?.isOther === true,
      isSecret: record?.isSecret === true,
      options: userInputOptions(record?.options)
    }];
  });
};

const userInputOptions = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const options = value.flatMap((option) => {
    const record = asRecord(option);
    const label = stringValue(record?.label);
    if (!label) return [];
    const description = stringValue(record?.description);
    return [{
      label,
      ...(description ? { description } : {})
    }];
  });
  return options.length ? options : null;
};

const approvalThreadId = (params: Record<string, unknown>) => {
  return stringValue(params.threadId);
};

const approvalTurnId = (params: Record<string, unknown>) =>
  stringValue(params.turnId);

const approvalItemId = (params: Record<string, unknown>) => stringValue(params.itemId);

const approvalCreatedAt = (params: Record<string, unknown>) => {
  const startedAtMs = typeof params.startedAtMs === "number" && Number.isFinite(params.startedAtMs)
    ? params.startedAtMs
    : undefined;
  return startedAtMs ? new Date(startedAtMs).toISOString() : new Date().toISOString();
};

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
  if (
    pending.method === "thread/start"
    || pending.method === "thread/resume"
    || pending.method === "thread/fork"
  ) {
    return resultThreadIdForMessage(message);
  }
  return threadIdForMessage(message) ?? pending.threadId;
};

const appServerThreadSummary = (
  thread: JsonRecord | null,
  workingDirectory: string
): ThreadCandidateSummary | null => {
  const threadId = typeof thread?.id === "string" ? thread.id : "";
  const cwd = typeof thread?.cwd === "string" ? thread.cwd : "";
  if (!threadId || cwd !== workingDirectory) return null;
  return {
    threadId,
    cwd,
    path: typeof thread?.path === "string" ? thread.path : "",
    title: typeof thread?.name === "string" ? thread.name : "",
    updatedAt: appServerTimestamp(thread?.updatedAt),
    firstUserMessage: typeof thread?.preview === "string" ? thread.preview : "",
    lastAssistantMessage: "",
    artifactCount: 0,
    messageCount: 0
  };
};

const appServerModelCatalogItem = (model: JsonRecord | null): ModelCatalogItem | null => {
  const modelName = stringValue(model?.model);
  const id = stringValue(model?.id);
  if (!id || !modelName) return null;
  const defaultReasoningEffort = stringValue(model?.defaultReasoningEffort) ?? null;
  const defaultServiceTier = stringValue(model?.defaultServiceTier) ?? null;
  return {
    id,
    model: modelName,
    ...(stringValue(model?.displayName) ? { displayName: stringValue(model?.displayName) } : {}),
    ...(stringValue(model?.description) ? { description: stringValue(model?.description) } : {}),
    ...(typeof model?.hidden === "boolean" ? { hidden: model.hidden } : {}),
    ...(typeof model?.isDefault === "boolean" ? { isDefault: model.isDefault } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    supportedReasoningEfforts: appServerReasoningOptions(model?.supportedReasoningEfforts, defaultReasoningEffort),
    ...(defaultServiceTier ? { defaultServiceTier } : {}),
    serviceTiers: appServerServiceTierOptions(model, defaultServiceTier)
  };
};

const appServerReasoningOptions = (value: unknown, defaultReasoningEffort: string | null) => {
  const seen = new Set<string>();
  const options: ModelCatalogItem["supportedReasoningEfforts"] = [];
  const push = (raw: unknown, description?: unknown) => {
    const option = stringValue(raw);
    if (!option || seen.has(option)) return;
    seen.add(option);
    options.push({
      value: option,
      label: option,
      ...(stringValue(description) ? { description: stringValue(description) } : {})
    });
  };
  for (const item of Array.isArray(value) ? value : []) {
    const record = asRecord(item);
    if (record) push(record.reasoningEffort, record.description);
  }
  push(defaultReasoningEffort);
  return options;
};

const appServerServiceTierOptions = (model: JsonRecord | null, defaultServiceTier: string | null) => {
  const seen = new Set<string>();
  const options: ModelCatalogItem["serviceTiers"] = [];
  const push = (raw: unknown, label?: unknown, description?: unknown) => {
    const value = stringValue(raw);
    if (!value || seen.has(value)) return;
    seen.add(value);
    const tierLabel = stringValue(label) ?? value;
    options.push({
      value,
      label: tierLabel,
      ...(stringValue(description) ? { description: stringValue(description) } : {})
    });
  };
  const rawServiceTiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers : [];
  for (const item of rawServiceTiers) {
    const tier = asRecord(item);
    if (tier) push(tier.id, tier.name, tier.description);
  }
  push(defaultServiceTier);
  return options;
};

const stringValue = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

const appServerTimestamp = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  return new Date(0).toISOString();
};

const resultThreadIdForMessage = (message: JsonRecord) => {
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  return typeof resultThread?.id === "string" ? resultThread.id : undefined;
};

export const createCodexhubSessionId = () => createSessionId();

const createSessionId = () => `local-${safeSessionPart(os.hostname())}-${process.pid}-${randomUUID().slice(0, 8)}`;

const sessionDisplayName = (sessionId: string) => `codexhub-${sessionId.split("-").at(-1) ?? sessionId.slice(-8)}`;

const safeSessionPart = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";

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

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const appServerTurnsListUnavailableBeforeFirstMessage = (error: unknown) => {
  const message = errorText(error);
  return message.includes("thread/turns/list")
    && message.includes("not materialized yet")
    && message.includes("before first user message");
};
