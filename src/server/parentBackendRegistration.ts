import { randomUUID } from "node:crypto";
import os from "node:os";
import WebSocket from "ws";
import { machineTransportUrl } from "../core/machineTransportProtocol.js";
import type { MachineHub } from "../core/machineHub.js";
import type { RemoteBackendCommand } from "../core/remoteBackend.js";
import type { ThreadHub } from "../core/threadHub.js";
import type { MachineActivitySummary, MachineCapabilities, MachineRegistrationProject } from "../shared/machineTypes.js";
import type { SessionRegistration, SessionEventInput, ThreadStreamEvent, ThreadSummary } from "../shared/threadTypes.js";
import { remoteBackendCommandSchema } from "../shared/apiContract.js";

type ParentBackendStatus = {
  status: "starting" | "connecting" | "online" | "offline" | "stopped";
  machineId: string;
  message?: string;
  updatedAt: string;
};

type BackendCommandMessage = {
  type: "backend_command";
  protocolVersion: 1;
  sessionId: string;
  commandId: string;
  generation: string;
  command: RemoteBackendCommand;
};

type BackendCommandLedgerEntry = {
  promise: Promise<unknown>;
  completion?: Promise<void>;
  fingerprint: string;
  inFlight: boolean;
  result?: unknown;
  error?: string;
};

export type ParentBackendRegistrationOptions = {
  apiBase: string;
  authToken?: string;
  machineId: string;
  name: string;
  localMachineId: string;
  threads: ThreadHub;
  machines: MachineHub;
  projects: () => MachineRegistrationProject[];
  activities: () => MachineActivitySummary[];
  capabilities?: Partial<MachineCapabilities>;
  retainThreadRecordSubscription: (threadId: string) => void;
  releaseThreadRecordSubscription: (threadId: string) => void;
  onStatus?: (status: ParentBackendStatus) => void;
};

export type ParentBackendRegistrationHandle = {
  start: () => Promise<void>;
  refreshRegistration: () => void;
  publishThreadEvent: (event: ThreadStreamEvent) => void;
  publishRuntimeProjection: () => void;
  stop: () => Promise<void>;
};

export const startParentBackendRegistration = (options: ParentBackendRegistrationOptions): ParentBackendRegistrationHandle => {
  const runner = new ParentBackendRegistration(options);
  return {
    start: () => runner.start(),
    refreshRegistration: () => runner.refreshRegistration(),
    publishThreadEvent: (event) => runner.publishThreadEvent(event),
    publishRuntimeProjection: () => runner.publishRuntimeProjection(),
    stop: () => runner.stop()
  };
};

class ParentBackendRegistration {
  private ws: WebSocket | null = null;
  private stopped = false;
  private loopStarted = false;
  private loopPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private remoteSessionId = randomUUID();
  private localSessionId: string | undefined;
  private generation = randomUUID();
  private relaySeq = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly abortController = new AbortController();
  private runtimeBindingPromise: Promise<void> | null = null;
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((error: Error) => void) | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private commandChain = Promise.resolve();
  private readonly commandLedger = new Map<string, BackendCommandLedgerEntry>();
  private readonly machineCommandLedger = new Map<string, { result?: unknown; error?: string }>();
  private machineCommandCursor = 0;
  private readonly recordSubscriptions = new Set<string>();

  constructor(private readonly options: ParentBackendRegistrationOptions) {
  }

  async start() {
    const session = await this.waitForLocalRuntime();
    this.bindLocalRuntime(session);
    if (!this.loopStarted) {
      this.loopStarted = true;
      this.loopPromise = this.runLoop();
      this.heartbeatTimer = setInterval(() => {
        void this.refreshRuntimeBinding();
      }, 5_000);
      this.heartbeatTimer.unref?.();
    }
  }

  refreshRegistration() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: "heartbeat", registration: this.machineRegistration() });
    void this.refreshRuntimeBinding();
  }

  async stop() {
    this.stopPromise ??= this.stopInternal();
    return await this.stopPromise;
  }

  publishRuntimeProjection() {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.localSessionId) return;
    const runtime = this.options.threads.runtimeForMachine(this.options.localMachineId, { includeOffline: true });
    if (!runtime) return;
    const remappedRuntime = {
      ...runtime,
      machineId: this.options.machineId,
      threads: runtime.threads.map((thread) => remapThreadSummary(thread, this.options.machineId))
    };
    this.sendSessionEvent({
      type: "runtime_projection",
      runtime: remappedRuntime,
      threads: remappedRuntime.threads,
      generation: this.generation,
      relaySeq: ++this.relaySeq,
      heartbeat: false
    });
  }

  publishThreadEvent(event: ThreadStreamEvent) {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.localSessionId) return;
    if (event.thread.runtime.machineId !== this.options.localMachineId) return;
    const remapped = remapThreadEvent(event, this.options.machineId);
    const projected: ThreadStreamEvent = this.recordSubscriptions.has(event.threadId)
      ? remapped
      : { ...remapped, record: undefined, records: undefined, delta: undefined };
    this.sendSessionEvent({
      type: "thread_projection",
      event: projected,
      generation: this.generation,
      relaySeq: ++this.relaySeq,
      heartbeat: false
    });
  }

  private async stopInternal() {
    this.stopped = true;
    this.abortController.abort();
    this.failHandshake(new Error("Parent backend registration stopped"));
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const threadId of this.recordSubscriptions) this.options.releaseThreadRecordSubscription(threadId);
    this.recordSubscriptions.clear();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: "unregister" });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.ws?.close();
    await this.loopPromise;
    this.setStatus("stopped", "parent backend registration stopped");
  }

  private async runLoop() {
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch (error) {
        if (this.stopped) break;
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus("offline", message);
        await delay(5_000, this.abortController.signal);
      }
    }
  }

  private async connectOnce() {
    this.setStatus("connecting", "connecting to parent backend");
    const session = await this.waitForLocalRuntime();
    this.bindLocalRuntime(session);
    const ws = await openWebSocket(
      machineTransportUrl(this.options.apiBase, this.options.authToken),
      this.abortController.signal
    );
    if (this.stopped) {
      ws.close();
      return;
    }
    this.ws = ws;
    const closed = new Promise<void>((resolve) => ws.once("close", resolve));
    const handshake = this.beginHandshake();
    ws.once("close", () => this.failHandshake(new Error("Parent backend handshake closed")));
    ws.on("message", (data) => this.handleMessage(data));
    ws.on("error", () => ws.close());
    this.send({
      type: "backend_register",
      protocolVersion: 1,
      generation: this.generation,
      commandCursor: this.machineCommandCursor,
      registration: this.machineRegistration()
    });
    try {
      await handshake;
    } catch (error) {
      ws.close();
      await closed;
      throw error;
    }
    await closed;
    if (this.ws === ws) this.ws = null;
    for (const threadId of this.recordSubscriptions) this.options.releaseThreadRecordSubscription(threadId);
    this.recordSubscriptions.clear();
    if (!this.stopped) throw new Error("parent backend websocket closed");
  }

  private handleMessage(data: WebSocket.RawData) {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data.toString()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "registered") {
      void this.registerRuntime().catch((error: unknown) => {
        this.failHandshake(error instanceof Error ? error : new Error(String(error)));
        this.ws?.close();
      });
      return;
    }
    if (message.type === "session_registered" && message.sessionId === this.remoteSessionId) {
      this.resolveHandshake();
      this.setStatus("online", "registered local runtime with parent");
      this.publishRuntimeProjection();
      return;
    }
    if (message.type === "commands" && Array.isArray(message.commands)) {
      this.commandChain = this.commandChain.then(async () => {
        for (const command of message.commands as Array<Record<string, unknown>>) await this.handleMachineCommand(command);
      });
      return;
    }
    if (message.type === "backend_command") {
      if (message.protocolVersion !== 1 || message.sessionId !== this.remoteSessionId || message.generation !== this.generation) return;
      const command = remoteBackendCommandSchema.safeParse(message.command);
      if (!command.success) {
        this.send({
          type: "backend_command_error",
          sessionId: typeof message.sessionId === "string" ? message.sessionId : "invalid",
          commandId: typeof message.commandId === "string" ? message.commandId : "invalid",
          generation: typeof message.generation === "string" ? message.generation : "invalid",
          message: "Invalid backend command payload"
        });
        return;
      }
      void this.handleBackendCommand({ ...message, command: command.data as RemoteBackendCommand } as BackendCommandMessage);
      return;
    }
    if (message.type === "error") {
      this.failHandshake(new Error(typeof message.message === "string" ? message.message : "Parent backend rejected registration"));
      this.ws?.close();
    }
  }

  private beginHandshake() {
    this.failHandshake(new Error("Parent backend handshake superseded"));
    return new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        this.handshakeResolve = null;
        this.handshakeReject = null;
        reject(new Error("Parent backend handshake timed out"));
      }, 10_000);
      this.handshakeTimer.unref?.();
    });
  }

  private resolveHandshake() {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const resolve = this.handshakeResolve;
    this.handshakeResolve = null;
    this.handshakeReject = null;
    resolve?.();
  }

  private failHandshake(error: Error) {
    if (!this.handshakeResolve && !this.handshakeReject) return;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const reject = this.handshakeReject;
    this.handshakeResolve = null;
    this.handshakeReject = null;
    reject?.(error);
  }

  private async registerRuntime() {
    const session = await this.waitForLocalRuntime();
    if (session.sessionId !== this.localSessionId) {
      // 代次属于连接握手；runtime 更换后必须重新握手，不能在旧连接内更换代次。
      if (this.localSessionId) this.send({ type: "session_unregister", sessionId: this.remoteSessionId });
      this.ws?.close();
      return;
    }
    this.send({ type: "session_register", sessionId: this.remoteSessionId, registration: this.sessionRegistration(session) });
  }

  private bindLocalRuntime(session: { sessionId: string }) {
    if (session.sessionId === this.localSessionId) return;
    this.remoteSessionId = randomUUID();
    this.localSessionId = session.sessionId;
    this.generation = randomUUID();
    this.relaySeq = 0;
    this.commandLedger.clear();
  }

  private async handleBackendCommand(message: BackendCommandMessage) {
    if (message.protocolVersion !== 1 || message.sessionId !== this.remoteSessionId || message.generation !== this.generation) return;
    const remoteSessionId = this.remoteSessionId;
    const generation = this.generation;
    const cached = this.commandLedger.get(message.commandId);
    if (cached) {
      if (cached.fingerprint !== commandFingerprint(message.command)) {
        this.send({ type: "backend_command_error", sessionId: remoteSessionId, commandId: message.commandId, generation, message: "Backend command id was reused with a different payload" });
        return;
      }
      if (cached.error) {
        this.send({ type: "backend_command_error", sessionId: remoteSessionId, commandId: message.commandId, generation, message: cached.error });
        return;
      }
      try {
        const value = await cached.promise;
        this.send({ type: "backend_command_result", sessionId: remoteSessionId, commandId: message.commandId, generation, result: value });
        void this.sendCompletion(message.commandId, cached.completion, remoteSessionId, generation);
      } catch (error) {
        this.send({ type: "backend_command_error", sessionId: remoteSessionId, commandId: message.commandId, generation, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const execution = this.executeBackendCommand(message.command);
    const promise = execution.then((value) => isCompletionDispatch(value) ? value.result : value);
    this.remember(this.commandLedger, message.commandId, {
      promise,
      completion: execution.then(
        (value) => isCompletionDispatch(value) ? value.completion : undefined,
        () => undefined
      ),
      fingerprint: commandFingerprint(message.command),
      inFlight: true
    });
    try {
      const result = await promise;
      const entry = this.commandLedger.get(message.commandId);
      if (entry) {
        entry.result = result;
        if (entry.completion) {
          void entry.completion.then(
            () => this.markCommandComplete(message.commandId),
            () => this.markCommandComplete(message.commandId)
          );
        } else {
          entry.inFlight = false;
          this.trimLedger(this.commandLedger);
        }
      }
      this.send({ type: "backend_command_result", sessionId: remoteSessionId, commandId: message.commandId, generation, result });
      void this.sendCompletion(message.commandId, this.commandLedger.get(message.commandId)?.completion, remoteSessionId, generation);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const entry = this.commandLedger.get(message.commandId);
      if (entry) {
        entry.inFlight = false;
        entry.error = text;
        this.trimLedger(this.commandLedger);
      }
      this.send({ type: "backend_command_error", sessionId: remoteSessionId, commandId: message.commandId, generation, message: text });
    }
  }

  private async executeBackendCommand(command: RemoteBackendCommand): Promise<unknown> {
    const localSessionId = this.localSessionId;
    if (!localSessionId) throw new Error("Local runtime session is not registered.");
    const session = this.options.threads.listSessions().find((item) => item.sessionId === localSessionId && item.online);
    if (!session || session.machineId !== this.localMachineId()) throw new Error("Backend command is not scoped to the local runtime.");
    if (command.threadId && command.type !== "resume_thread") {
      const thread = this.options.threads.getThread(command.threadId);
      if (!thread || thread.runtime.machineId !== this.localMachineId()) {
        throw new Error(`Backend command thread is not local: ${command.threadId}`);
      }
    }
    if (command.type === "subscribe_thread_records") {
      const threadId = command.threadId;
      if (!threadId) throw new Error("subscribe_thread_records requires threadId");
      if (!this.recordSubscriptions.has(threadId)) {
        this.recordSubscriptions.add(threadId);
        this.options.retainThreadRecordSubscription(threadId);
        const detail = this.options.threads.getThreadPage(threadId);
        if (detail) this.publishThreadEvent({
          seq: detail.lastSeq,
          threadId,
          kind: "thread",
          historical: true,
          thread: remapThreadSummary(detail, this.options.machineId),
          records: detail.records,
          backgroundTerminals: detail.backgroundTerminals,
          queue: this.options.threads.queuedTurnItems(threadId),
          snapshot: {
            snapshotId: randomUUID(),
            page: 0,
            reset: true,
            complete: detail.history ? !detail.history.hasOlder : false,
            history: detail.history
          }
        });
      }
      return { result: { subscribed: true }, completion: Promise.resolve() };
    }
    if (command.type === "unsubscribe_thread_records") {
      const threadId = command.threadId;
      if (threadId && this.recordSubscriptions.delete(threadId)) this.options.releaseThreadRecordSubscription(threadId);
      return { result: { subscribed: false }, completion: Promise.resolve() };
    }
    const dispatched = await this.options.threads.dispatchRemoteBackendCommand(localSessionId, command);
    if (isCompletionDispatch(dispatched)) {
      const { completion, ...result } = dispatched;
      return { result, completion };
    }
    return { result: dispatched, completion: Promise.resolve() };
  }

  private async sendCompletion(commandId: string, completion: Promise<void> | undefined, sessionId: string, generation: string) {
    try {
      await completion;
      this.send({
        type: "backend_command_done",
        sessionId,
        commandId,
        generation
      });
    } catch (error) {
      this.send({
        type: "backend_command_done",
        sessionId,
        commandId,
        generation,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleMachineCommand(command: Record<string, unknown>) {
    const commandId = typeof command.commandId === "string" ? command.commandId : "";
    const type = typeof command.type === "string" ? command.type : "";
    if (!commandId) return;
    const cached = this.machineCommandLedger.get(commandId);
    if (cached) {
      this.machineCommandCursor = Math.max(this.machineCommandCursor, Number(command.seq) || 0);
      if (cached.error) this.send({ type: "command_error", commandId, message: cached.error });
      else this.send({ type: "command_result", commandId, result: cached.result });
      return;
    }
    try {
      const result = await this.executeMachineCommand(type, command);
      this.remember(this.machineCommandLedger, commandId, { result });
      this.machineCommandCursor = Math.max(this.machineCommandCursor, Number(command.seq) || 0);
      this.send({ type: "command_result", commandId, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.remember(this.machineCommandLedger, commandId, { error: message });
      this.machineCommandCursor = Math.max(this.machineCommandCursor, Number(command.seq) || 0);
      this.send({ type: "command_error", commandId, message });
    }
  }

  private async executeMachineCommand(type: string, command: Record<string, unknown>) {
    const machineId = this.localMachineId();
    if (type === "ensure_runtime") {
      const runtime = await this.waitForLocalRuntime();
      return { sessionId: this.remoteSessionId, cwd: runtime.workingDirectory, reused: true };
    }
    if (type === "start_session") {
      const cwd = typeof command.cwd === "string" ? command.cwd : undefined;
      const threadId = typeof command.threadId === "string" ? command.threadId : undefined;
      const thread = threadId
        ? await this.options.threads.resumeMachineThread(machineId, threadId, cwd)
        : await this.options.threads.startMachineThread(machineId, cwd);
      return { sessionId: this.remoteSessionId, threadId: thread.threadId, cwd: thread.workingDirectory };
    }
    if (type === "stop_session") throw new Error("Parent cannot stop the child-owned local runtime.");
    if (type === "list_directory") return await this.options.machines.listDirectory(machineId, { cwd: typeof command.cwd === "string" ? command.cwd : undefined }).promise;
    if (type === "preview_file") return await this.options.machines.previewFile(machineId, { path: String(command.path) }).promise;
    if (type === "read_file_chunk") return await this.options.machines.readFileChunk(machineId, {
      path: String(command.path), offset: Number(command.offset), length: Number(command.length),
      expectedSize: Number(command.expectedSize), expectedModifiedAtMs: Number(command.expectedModifiedAtMs)
    }).promise;
    if (type === "create_git_worktree") return await this.options.machines.createGitWorktree(machineId, {
      parentCwd: String(command.parentCwd), branch: String(command.branch),
      baseRef: typeof command.baseRef === "string" ? command.baseRef : undefined,
      path: typeof command.path === "string" ? command.path : undefined
    }).promise;
    throw new Error(`Unsupported backend machine command: ${type}`);
  }

  private localMachineId() {
    return this.options.localMachineId;
  }

  private remember<T>(map: Map<string, T>, key: string, value: T) {
    map.set(key, value);
    this.trimLedger(map);
  }

  private markCommandComplete(commandId: string) {
    const entry = this.commandLedger.get(commandId);
    if (!entry) return;
    entry.inFlight = false;
    this.trimLedger(this.commandLedger);
  }

  private trimLedger<T>(map: Map<string, T>) {
    while (map.size > 500) {
      const evict = [...map.entries()].find(([, entry]) => !(entry as T & { inFlight?: boolean }).inFlight)?.[0];
      if (!evict) return;
      map.delete(evict);
    }
  }

  private async refreshRuntimeBinding() {
    if (this.stopped) return;
    if (this.runtimeBindingPromise) return await this.runtimeBindingPromise;
    this.runtimeBindingPromise = (async () => {
      const session = await this.waitForLocalRuntime(2_000).catch(() => undefined);
      if (!session) return;
      if (session.sessionId !== this.localSessionId && this.ws?.readyState === WebSocket.OPEN) {
        await this.registerRuntime();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: "heartbeat", registration: this.machineRegistration() });
        if (this.localSessionId) {
          this.send({ type: "session_heartbeat", sessionId: this.remoteSessionId, registration: this.sessionRegistration(session) });
        }
        this.publishRuntimeProjection();
      }
    })().finally(() => {
      this.runtimeBindingPromise = null;
    });
    await this.runtimeBindingPromise;
  }

  private async waitForLocalRuntime(timeoutMs = 30_000) {
    if (this.abortController.signal.aborted) throw new Error("Parent backend registration stopped");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const session = this.options.threads.listSessions().find((item) => item.machineId === this.options.localMachineId && item.online);
      if (session) return session;
      await delay(50, this.abortController.signal);
      if (this.abortController.signal.aborted) throw new Error("Parent backend registration stopped");
    }
    throw new Error(`Local machine runtime did not register: ${this.options.localMachineId}`);
  }

  private machineRegistration() {
    return {
      machineId: this.options.machineId,
      type: "registered" as const,
      name: this.options.name,
      hostname: os.hostname(),
      pid: process.pid,
      platform: `${process.platform}-${process.arch}`,
      cwd: process.cwd(),
      capabilities: { projectLauncher: true, ...this.options.capabilities },
      projects: this.options.projects(),
      activities: this.options.activities()
    };
  }

  private sessionRegistration(session: { workingDirectory: string; pid?: number; hostname?: string; cliVersion?: string }): SessionRegistration {
    return {
      machineId: this.options.machineId,
      name: this.options.name,
      workingDirectory: session.workingDirectory,
      pid: session.pid,
      hostname: session.hostname,
      cliVersion: session.cliVersion
    };
  }

  private sendSessionEvent(event: SessionEventInput) {
    this.send({ type: "session_event", sessionId: this.remoteSessionId, event });
  }

  private send(message: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private setStatus(status: ParentBackendStatus["status"], message?: string) {
    this.options.onStatus?.({ status, machineId: this.options.machineId, message, updatedAt: new Date().toISOString() });
  }
}

const remapThreadSummary = (thread: ThreadSummary, machineId: string): ThreadSummary => ({
  ...thread,
  runtime: { ...thread.runtime, machineId }
});

const remapThreadEvent = (event: ThreadStreamEvent, machineId: string): ThreadStreamEvent => ({
  ...event,
  thread: remapThreadSummary(event.thread, machineId)
});

const openWebSocket = async (url: string, signal: AbortSignal) => {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      ws.close();
      finish(new Error("Parent backend registration stopped"));
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      ws.close();
      finish(new Error("WebSocket connection to parent backend timed out"));
    }, 10_000);
    signal.addEventListener("abort", onAbort, { once: true });
    ws.once("open", () => finish());
    ws.once("error", () => finish(new Error("WebSocket failed while connecting to parent backend")));
    ws.once("close", () => finish(new Error("WebSocket closed while connecting to parent backend")));
    if (signal.aborted) onAbort();
  });
  return ws;
};

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

const isCompletionDispatch = (value: unknown): value is { result: unknown; completion: Promise<void> } => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return "completion" in record && record.completion instanceof Promise && "result" in record;
};

const commandFingerprint = (command: RemoteBackendCommand) => JSON.stringify(command);
