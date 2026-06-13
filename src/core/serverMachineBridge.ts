import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type {
  MachineCommand,
  MachineDirectoryListing,
  MachineStartSessionResult,
  MachineStopSessionResult
} from "./machineHub.js";
import { MachineHub } from "./machineHub.js";
import type { StoredServerConnection } from "./serverState.js";
import type {
  SessionCommand,
  SessionSummary,
  ThreadHub,
  ThreadStreamEvent,
  ThreadSummary
} from "./threadHub.js";

export type ServerConnectionStatus = "offline" | "connecting" | "online" | "failed";

export type ServerConnectionView = Omit<StoredServerConnection, "authToken"> & {
  status: ServerConnectionStatus;
  online: boolean;
  connectedAt?: string;
  remoteMachineId?: string;
  lastError?: string;
  hasAuthToken: boolean;
};

export type ServerMachineBridgeManagerOptions = {
  machines: MachineHub;
  threads: ThreadHub;
  listConnections: () => StoredServerConnection[];
  updateConnection: (connectionId: string, input: {
    lastConnectedAt?: string;
    lastError?: string | null;
  }) => void;
  validateConnection?: (connection: StoredServerConnection) => Promise<string | null> | string | null;
  localMachineId: () => string | null;
  onChange?: () => void;
};

type ParentMachineMessage =
  | { type: "registered"; machineId: string; machine?: unknown }
  | { type: "commands"; cursor: number; commands: MachineCommand[] }
  | { type: "session_registered"; sessionId: string; session?: unknown }
  | { type: "session_commands"; sessionId: string; cursor: number; commands: SessionCommand[] }
  | { type: "session_error"; sessionId: string; message: string }
  | { type: "error"; message: string };

type ManagedBridgeStatus = {
  status: ServerConnectionStatus;
  connectedAt?: string;
  remoteMachineId?: string;
  lastError?: string;
};

export class ServerMachineBridgeManager {
  private readonly bridges = new Map<string, ServerMachineBridge>();

  constructor(private readonly options: ServerMachineBridgeManagerOptions) {}

  list(): ServerConnectionView[] {
    return this.options.listConnections().map((connection) => {
      const { authToken, ...publicConnection } = connection;
      const status = this.statusFor(connection.connectionId);
      return {
        ...publicConnection,
        ...status,
        online: status.status === "online",
        hasAuthToken: Boolean(authToken)
      };
    });
  }

  connect(connection: StoredServerConnection) {
    const existing = this.bridges.get(connection.connectionId);
    if (existing) return existing.view();
    const bridge = new ServerMachineBridge(connection, this.options, () => {
      this.options.onChange?.();
    });
    this.bridges.set(connection.connectionId, bridge);
    bridge.start();
    this.options.onChange?.();
    return bridge.view();
  }

  async disconnect(connectionId: string) {
    const bridge = this.bridges.get(connectionId);
    if (!bridge) return;
    this.bridges.delete(connectionId);
    await bridge.stop();
    this.options.onChange?.();
  }

  async remove(connectionId: string) {
    await this.disconnect(connectionId);
  }

  async autoConnectEnabled() {
    for (const connection of this.options.listConnections()) {
      if (connection.enabled) this.connect(connection);
    }
  }

  notifyThreadChange() {
    for (const bridge of this.bridges.values()) bridge.scheduleThreadSync();
  }

  async stopAll() {
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.allSettled(bridges.map((bridge) => bridge.stop()));
    this.options.onChange?.();
  }

  private statusFor(connectionId: string): ManagedBridgeStatus {
    return this.bridges.get(connectionId)?.view() ?? { status: "offline" };
  }
}

class ServerMachineBridge {
  private ws: WebSocket | null = null;
  private stopped = false;
  private registered = false;
  private commandCursor = 0;
  private commandChain = Promise.resolve();
  private sessionCommandChain = Promise.resolve();
  private status: ServerConnectionStatus = "offline";
  private connectedAt: string | undefined;
  private remoteMachineId: string | undefined;
  private lastError: string | undefined;
  private readonly mirroredSessions = new Map<string, string>();
  private readonly sessionCursors = new Map<string, number>();
  private readonly threadUnsubscribers = new Map<string, () => void>();
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connection: StoredServerConnection,
    private readonly options: ServerMachineBridgeManagerOptions,
    private readonly onChange: () => void
  ) {}

  start() {
    void this.runLoop();
  }

  view(): ManagedBridgeStatus {
    return {
      status: this.status,
      connectedAt: this.connectedAt,
      remoteMachineId: this.remoteMachineId,
      lastError: this.lastError
    };
  }

  async stop() {
    this.stopped = true;
    this.clearSyncTimer();
    this.clearThreadSubscriptions();
    if (this.registered) this.sendRaw({ type: "unregister" });
    await delay(50);
    this.ws?.close();
    this.setStatus("offline");
  }

  scheduleThreadSync() {
    if (!this.registered || this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncMirroredThreads();
    }, 100);
    this.syncTimer.unref?.();
  }

  private async runLoop() {
    while (!this.stopped) {
      try {
        this.setStatus("connecting");
        await this.connectOnce();
        if (!this.stopped) this.setStatus("offline", "websocket closed");
      } catch (error) {
        if (!this.stopped) this.setStatus("failed", errorText(error));
      } finally {
        this.registered = false;
        this.ws?.close();
        this.ws = null;
        this.mirroredSessions.clear();
        this.clearThreadSubscriptions();
      }
      if (!this.stopped) await delay(5000);
    }
  }

  private async connectOnce() {
    const validationError = await this.options.validateConnection?.(this.connection);
    if (validationError) throw new Error(validationError);
    const ws = await openWebSocket(machineTransportUrl(this.connection.url, this.connection.authToken));
    this.ws = ws;
    const closed = new Deferred<void>();
    const heartbeat = setInterval(() => this.heartbeat(), 10_000);
    heartbeat.unref?.();
    ws.addEventListener("message", (event) => this.handleMessage(event.data));
    ws.addEventListener("error", () => {
      if (!this.stopped) this.setStatus("failed", "websocket error");
      ws.close();
    });
    ws.addEventListener("close", () => {
      clearInterval(heartbeat);
      closed.resolve();
    }, { once: true });
    this.sendRaw({
      type: "register",
      commandCursor: this.commandCursor,
      registration: this.registration()
    });
    await closed.promise;
  }

  private registration() {
    return {
      machineId: this.connection.machineId,
      type: "server" as const,
      name: this.connection.name,
      hostname: os.hostname(),
      pid: process.pid,
      platform: `${process.platform}-${process.arch}`,
      cwd: process.cwd(),
      capabilities: { projectLauncher: false }
    };
  }

  private heartbeat() {
    if (!this.registered) return;
    this.sendRaw({ type: "heartbeat", registration: this.registration() });
    this.mirrorSessions();
    for (const sessionId of this.mirroredSessions.keys()) {
      const session = this.options.threads.listSessions().find((item) => item.sessionId === sessionId);
      if (!session) continue;
      this.sendRaw({ type: "session_heartbeat", sessionId, registration: sessionRegistration(session) });
    }
    this.syncMirroredThreads();
  }

  private handleMessage(data: unknown) {
    const message = parseParentMachineMessage(data);
    if (!message) {
      this.sendRaw({ type: "error", message: "invalid parent server message" });
      return;
    }
    if (message.type === "registered") {
      this.registered = true;
      this.connectedAt = new Date().toISOString();
      this.remoteMachineId = message.machineId;
      this.lastError = undefined;
      this.options.updateConnection(this.connection.connectionId, {
        lastConnectedAt: this.connectedAt,
        lastError: null
      });
      this.setStatus("online");
      this.mirrorSessions();
      this.syncMirroredThreads();
      return;
    }
    if (message.type === "commands") {
      this.commandCursor = Math.max(this.commandCursor, message.cursor);
      this.enqueueMachineCommands(message.commands);
      return;
    }
    if (message.type === "session_registered") return;
    if (message.type === "session_commands") {
      this.sessionCursors.set(message.sessionId, Math.max(this.sessionCursors.get(message.sessionId) ?? 0, message.cursor));
      this.enqueueSessionCommands(message.sessionId, message.commands);
      return;
    }
    if (message.type === "session_error") {
      this.lastError = message.message;
      this.onChange();
      return;
    }
    this.lastError = message.message;
    this.onChange();
  }

  private enqueueMachineCommands(commands: MachineCommand[]) {
    this.commandChain = this.commandChain.then(async () => {
      for (const command of commands) {
        try {
          const result = await this.runMachineCommand(command);
          this.sendRaw({ type: "command_result", commandId: command.commandId, result });
        } catch (error) {
          this.sendRaw({ type: "command_error", commandId: command.commandId, message: errorText(error) });
        } finally {
          this.commandCursor = Math.max(this.commandCursor, command.seq);
        }
      }
    }).catch((error) => {
      this.setStatus("failed", errorText(error));
    });
  }

  private async runMachineCommand(command: MachineCommand) {
    const machineId = this.requireLocalMachineId();
    if (command.type === "start_session") {
      const started = this.options.machines.startSession(machineId, { cwd: command.cwd, reuse: command.reuse });
      const result = await started.promise;
      this.mirrorSessions();
      this.syncMirroredThreads();
      return result satisfies MachineStartSessionResult;
    }
    if (command.type === "list_directory") {
      const listing = this.options.machines.listDirectory(machineId, { cwd: command.cwd });
      return await listing.promise satisfies MachineDirectoryListing;
    }
    if (command.type === "stop_session") {
      const stopped = this.options.machines.stopSession(machineId, { sessionId: command.sessionId });
      const result = await stopped.promise;
      this.mirrorSessions();
      return result satisfies MachineStopSessionResult;
    }
    throw new Error(`Unsupported machine command: ${(command as { type?: string }).type ?? "unknown"}`);
  }

  private enqueueSessionCommands(sessionId: string, commands: SessionCommand[]) {
    this.sessionCommandChain = this.sessionCommandChain.then(async () => {
      for (const command of commands) {
        try {
          const result = await this.runSessionCommand(sessionId, command);
          if (result !== undefined) {
            this.sendRaw({ type: "session_command_result", sessionId, commandId: command.commandId, result });
          }
        } catch (error) {
          this.sendRaw({
            type: "session_command_error",
            sessionId,
            commandId: command.commandId,
            message: errorText(error)
          });
        } finally {
          this.sessionCursors.set(sessionId, Math.max(this.sessionCursors.get(sessionId) ?? 0, command.seq));
        }
      }
    }).catch((error) => {
      this.setStatus("failed", errorText(error));
    });
  }

  private async runSessionCommand(sessionId: string, command: SessionCommand) {
    const threads = this.options.threads;
    if (command.type === "list_threads") return await threads.listSessionThreadCandidates(sessionId, command.limit, command.workingDirectory);
    if (command.type === "subscribe_thread_records") {
      if (!command.threadId) throw new Error("subscribe_thread_records requires threadId");
      threads.subscribeThreadRecords(command.threadId);
      return;
    }
    if (command.type === "unsubscribe_thread_records") {
      if (!command.threadId) throw new Error("unsubscribe_thread_records requires threadId");
      threads.unsubscribeThreadRecords(command.threadId);
      return;
    }
    if (command.type === "start_thread") {
      const detail = await threads.startSessionThread(sessionId, command.workingDirectory);
      this.sendThreadSnapshot(sessionId, detail.threadId);
      return detail;
    }
    if (command.type === "resume_thread") {
      if (!command.threadId) throw new Error("resume_thread requires threadId");
      const detail = await threads.resumeSessionThread(sessionId, command.threadId, command.workingDirectory);
      this.sendThreadSnapshot(sessionId, detail.threadId);
      return detail;
    }
    if (command.type === "fork_thread") {
      if (!command.threadId) throw new Error("fork_thread requires threadId");
      const detail = await threads.forkThread(command.threadId);
      this.sendThreadSnapshot(sessionId, detail.threadId);
      return detail;
    }
    if (command.type === "rollback_thread") {
      if (!command.threadId) throw new Error("rollback_thread requires threadId");
      if (!command.numTurns || command.numTurns < 1) throw new Error("rollback_thread requires numTurns >= 1");
      const detail = await threads.rollbackThreadTurns(command.threadId, command.numTurns, command.keepTurns);
      this.sendThreadSnapshot(sessionId, detail.threadId);
      return detail;
    }
    if (command.type === "stop") {
      if (command.threadId) return threads.stopTurn(command.threadId);
      return;
    }
    if (command.type === "set_goal") {
      if (!command.threadId) throw new Error("set_goal requires threadId");
      await threads.setGoal(command.threadId, command.goal ?? {});
      return { ok: true };
    }
    if (command.type === "clear_goal") {
      if (!command.threadId) throw new Error("clear_goal requires threadId");
      await threads.clearGoal(command.threadId);
      return { ok: true };
    }
    if (command.type === "turn" || command.type === "steer") {
      if (!command.threadId || !command.input) throw new Error(`${command.type} requires threadId and input`);
      const result = threads.runSessionThreadTurn(sessionId, command.threadId, command.input, "web", command.options, command.workingDirectory);
      await result.promise;
      return { ok: true };
    }
    return;
  }

  private mirrorSessions() {
    if (!this.registered) return;
    const localMachineId = this.options.localMachineId();
    if (!localMachineId) return;
    const sessions = this.options.threads.listSessions()
      .filter((session) => session.online && session.machineId === localMachineId);
    const active = new Set<string>();
    for (const session of sessions) {
      active.add(session.sessionId);
      const key = sessionKey(session);
      if (this.mirroredSessions.get(session.sessionId) !== key) {
        this.sendRaw({
          type: "session_register",
          sessionId: session.sessionId,
          commandCursor: this.sessionCursors.get(session.sessionId) ?? 0,
          registration: sessionRegistration(session)
        });
        this.mirroredSessions.set(session.sessionId, key);
      }
    }
    for (const sessionId of [...this.mirroredSessions.keys()]) {
      if (active.has(sessionId)) continue;
      this.sendRaw({ type: "session_unregister", sessionId });
      this.mirroredSessions.delete(sessionId);
      this.sessionCursors.delete(sessionId);
      this.unsubscribeThreadsForSession(sessionId);
    }
  }

  private syncMirroredThreads() {
    if (!this.registered) return;
    this.mirrorSessions();
    const mirroredSessionIds = new Set(this.mirroredSessions.keys());
    const activeThreadIds = new Set<string>();
    for (const thread of this.options.threads.listThreads()) {
      const sessionId = mirroredSessionIdForThread(thread);
      if (!sessionId || !mirroredSessionIds.has(sessionId)) continue;
      activeThreadIds.add(thread.threadId);
      if (!this.threadUnsubscribers.has(thread.threadId)) {
        this.sendThreadSnapshot(sessionId, thread.threadId);
        const unsubscribe = this.options.threads.subscribe(thread.threadId, 0, (event) => {
          const eventSessionId = mirroredSessionIdForThread(event.thread) ?? sessionId;
          if (!this.mirroredSessions.has(eventSessionId)) return;
          this.sendRaw({ type: "thread_event", sessionId: eventSessionId, event });
        });
        this.threadUnsubscribers.set(thread.threadId, unsubscribe);
      }
    }
    for (const [threadId, unsubscribe] of [...this.threadUnsubscribers]) {
      if (activeThreadIds.has(threadId)) continue;
      unsubscribe();
      this.threadUnsubscribers.delete(threadId);
    }
  }

  private sendThreadSnapshot(sessionId: string, threadId: string) {
    const thread = this.options.threads.getThread(threadId);
    if (!thread) return;
    this.sendRaw({ type: "thread_snapshot", sessionId, thread });
  }

  private unsubscribeThreadsForSession(sessionId: string) {
    for (const thread of this.options.threads.listThreads()) {
      if (mirroredSessionIdForThread(thread) !== sessionId) continue;
      const unsubscribe = this.threadUnsubscribers.get(thread.threadId);
      if (!unsubscribe) continue;
      unsubscribe();
      this.threadUnsubscribers.delete(thread.threadId);
    }
  }

  private clearThreadSubscriptions() {
    for (const unsubscribe of this.threadUnsubscribers.values()) unsubscribe();
    this.threadUnsubscribers.clear();
  }

  private clearSyncTimer() {
    if (!this.syncTimer) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  private requireLocalMachineId() {
    const machineId = this.options.localMachineId();
    if (!machineId) throw new Error("No local machine is online in the registered server.");
    return machineId;
  }

  private setStatus(status: ServerConnectionStatus, error?: string) {
    this.status = status;
    if (error) {
      this.lastError = error;
      this.options.updateConnection(this.connection.connectionId, { lastError: error });
    }
    this.onChange();
  }

  private sendRaw(message: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }
}

const sessionRegistration = (session: SessionSummary) => ({
  name: session.name,
  workingDirectory: session.workingDirectory,
  appServerUrl: session.appServerUrl,
  pid: session.pid,
  hostname: session.hostname
});

const sessionKey = (session: SessionSummary) => JSON.stringify(sessionRegistration(session));

const mirroredSessionIdForThread = (thread: ThreadSummary) =>
  thread.session.sessionId && thread.session.online ? thread.session.sessionId : undefined;

const machineTransportUrl = (apiBase: string, authToken?: string) => {
  const url = new URL("/api/machines/connect", apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (authToken) url.searchParams.set("codexhub_token", authToken);
  return url.toString();
};

const openWebSocket = async (url: string) => {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      ws.close();
      reject(new Error(`Timed out connecting to ${url}`));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket connection failed: ${url}`));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
  return ws;
};

const parseParentMachineMessage = (data: unknown): ParentMachineMessage | null => {
  const message = parseJsonObject(data);
  if (!message) return null;
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "registered") {
    return typeof message.machineId === "string" && message.machineId
      ? { type, machineId: message.machineId, machine: message.machine }
      : null;
  }
  if (type === "commands") {
    return typeof message.cursor === "number" && Array.isArray(message.commands)
      ? { type, cursor: message.cursor, commands: message.commands as MachineCommand[] }
      : null;
  }
  if (type === "session_registered") {
    return typeof message.sessionId === "string"
      ? { type, sessionId: message.sessionId, session: message.session }
      : null;
  }
  if (type === "session_commands") {
    return typeof message.sessionId === "string" && typeof message.cursor === "number" && Array.isArray(message.commands)
      ? { type, sessionId: message.sessionId, cursor: message.cursor, commands: message.commands as SessionCommand[] }
      : null;
  }
  if (type === "session_error") {
    return typeof message.sessionId === "string"
      ? { type, sessionId: message.sessionId, message: typeof message.message === "string" ? message.message : "session error" }
      : null;
  }
  if (type === "error") return { type, message: typeof message.message === "string" ? message.message : "server error" };
  return null;
};

const parseJsonObject = (data: unknown): Record<string, unknown> | null => {
  try {
    const parsed = typeof data === "string" ? JSON.parse(data) : JSON.parse(String(data));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}
