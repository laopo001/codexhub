import { access, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createMachineId,
  type MachineCommand,
  type MachineDirectoryListing,
  type MachineRegistration,
  type MachineStartSessionResult,
  type MachineStopSessionResult,
  type MachineType
} from "../core/machineHub.js";
import type { SessionCommand } from "../core/threadHub.js";
import {
  startHeadlessCodexhubSession,
  type HeadlessCodexhubSessionHandle,
  type HeadlessSessionTransport,
  type HeadlessSessionTransportCallbacks
} from "./codexhubConnect.js";

export type MachineRunnerOptions = {
  apiBase: string;
  authToken?: string;
  machineId?: string;
  type?: MachineType;
  name?: string;
};

export type CodexhubMachineHandle = {
  machineId: string;
  stop: () => Promise<void>;
};

type MachineTransportMessage =
  | { type: "registered"; machineId: string; machine?: unknown }
  | { type: "commands"; cursor: number; commands: MachineCommand[] }
  | { type: "session_registered"; sessionId: string; session?: unknown }
  | { type: "session_commands"; sessionId: string; cursor: number; commands: SessionCommand[] }
  | { type: "session_error"; sessionId: string; message: string }
  | { type: "error"; message: string };

type ManagedSession = {
  session: HeadlessCodexhubSessionHandle;
  cwd: string;
  projectsByCwd: Map<string, MachineStartSessionResult>;
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
    stop: () => runner.stop()
  };
};

class CodexhubMachineRunner {
  private readonly machineId: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private registered = false;
  private loopStarted = false;
  private commandCursor = 0;
  private commandChain = Promise.resolve();
  private runtimeSession: ManagedSession | null = null;
  private readonly sessionTransports = new Map<string, MachineSessionTransport>();

  constructor(private readonly options: MachineRunnerOptions) {
    this.machineId = options.machineId?.trim() || createMachineId(os.hostname());
  }

  get id() {
    return this.machineId;
  }

  start() {
    if (this.loopStarted) return;
    this.loopStarted = true;
    console.error(`codexhub machine starting: ${this.machineId}`);
    void this.runLoop();
  }

  async stop() {
    this.stopped = true;
    await this.stopSessions();
    if (this.registered) {
      this.sendRaw({ type: "unregister" });
      await delay(50);
    }
    this.registered = false;
    this.sessionTransports.clear();
    this.ws?.close();
  }

  private async runLoop() {
    while (!this.stopped) {
      try {
        console.error(`codexhub machine connecting: ${this.options.apiBase}`);
        await this.connectOnce();
        if (!this.stopped) console.error("codexhub machine offline: websocket closed");
      } catch (error) {
        if (!this.stopped) console.error(`codexhub machine offline: ${errorText(error)}`);
      } finally {
        if (!this.stopped && this.options.type === "ssh") {
          this.stopped = true;
          await this.stopSessions();
        }
        this.registered = false;
        this.ws?.close();
        this.ws = null;
      }
      if (!this.stopped) await delay(5000);
    }
  }

  private async connectOnce() {
    const ws = await openWebSocket(machineTransportUrl(this.options.apiBase, this.options.authToken));
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
      closed.resolve();
    }, { once: true });
    this.sendRaw({
      type: "register",
      commandCursor: this.commandCursor,
      registration: this.registration()
    });
    await closed.promise;
  }

  private registration(): MachineRegistration {
    return {
      machineId: this.machineId,
      type: this.options.type ?? "registered",
      name: this.options.name,
      hostname: os.hostname(),
      pid: process.pid,
      platform: `${process.platform}-${process.arch}`,
      cwd: process.cwd(),
      capabilities: { projectLauncher: true }
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
    if (message.type === "registered") {
      this.registered = true;
      console.error(`codexhub machine connected: ${message.machineId}`);
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
    console.error(`codexhub machine server error: ${message.message}`);
  }

  private enqueueCommands(commands: MachineCommand[]) {
    this.commandChain = this.commandChain.then(async () => {
      for (const command of commands) {
        try {
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
    if (command.type === "stop_session") return await this.stopSession(command);
    throw new Error(`Unexpected command: ${(command as { type?: string }).type ?? "unknown"}`);
  }

  private async startSession(command: MachineCommand): Promise<MachineStartSessionResult> {
    if (command.type !== "start_session") throw new Error(`Unexpected command: ${command.type}`);
    const cwd = await resolveDirectory(command.cwd);
    const existing = command.reuse !== false ? this.runtimeSession?.projectsByCwd.get(cwd) : undefined;
    if (existing) {
      return {
        ...existing,
        cwd,
        reused: true
      };
    }

    const runtime = await this.ensureRuntimeSession(cwd);
    const threadId = runtime.projectsByCwd.size === 0 && runtime.cwd === cwd
      ? runtime.session.threadId
      : await runtime.session.startThread(cwd);
    const result = {
      sessionId: runtime.session.sessionId,
      threadId,
      appServerUrl: runtime.session.appServerUrl,
      cwd
    };
    runtime.projectsByCwd.set(cwd, result);
    return result;
  }

  private async ensureRuntimeSession(cwd: string): Promise<ManagedSession> {
    if (this.runtimeSession) return this.runtimeSession;
    console.error(`codexhub machine app-server starting: ${cwd}`);
    const session = await startHeadlessCodexhubSession({
      apiBase: this.options.apiBase,
      machineId: this.machineId,
      cwd,
      readyLabel: "codexhub machine app-server ready",
      transportFactory: (context, callbacks) => {
        const transport = new MachineSessionTransport({
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

  private sendRaw(message: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private async stopSessions() {
    const runtime = this.runtimeSession;
    this.runtimeSession = null;
    if (runtime) await runtime.session.stop();
  }
}

type MachineSessionTransportMessage =
  | Extract<MachineTransportMessage, { type: "session_registered" | "session_commands" | "session_error" }>;

class MachineSessionTransport implements HeadlessSessionTransport {
  private registered = false;
  private stopped = false;
  private commandCursor = 0;
  private pendingOutgoing: unknown[] = [];
  private commandChain = Promise.resolve();

  constructor(private readonly options: {
    sessionId: string;
    send: (message: unknown) => void;
    callbacks: HeadlessSessionTransportCallbacks;
    onStop: () => void;
  }) {}

  start() {
    if (this.stopped) return;
    this.register();
  }

  reconnect() {
    if (this.stopped) return;
    this.registered = false;
    this.register();
  }

  markDisconnected() {
    if (this.stopped || !this.registered) return;
    this.registered = false;
    this.options.callbacks.onState("offline", `codexhub machine session offline: ${this.options.sessionId}`);
  }

  stop(options: { unregister?: boolean } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    if (options.unregister && this.registered) {
      this.options.send({ type: "session_unregister", sessionId: this.options.sessionId });
    }
    this.registered = false;
    this.pendingOutgoing = [];
    this.options.onStop();
  }

  sendEvent(event: Parameters<HeadlessSessionTransport["sendEvent"]>[0]) {
    this.sendOrQueue({ type: "session_event", sessionId: this.options.sessionId, event });
  }

  sendRecords(records: Parameters<HeadlessSessionTransport["sendRecords"]>[0]) {
    this.sendOrQueue({ type: "session_records", sessionId: this.options.sessionId, records });
  }

  sendHeartbeat(registration: Parameters<HeadlessSessionTransport["sendHeartbeat"]>[0]) {
    this.sendOrQueue({
      type: "session_heartbeat",
      sessionId: this.options.sessionId,
      registration
    }, { queue: false });
  }

  handleServerMessage(message: MachineSessionTransportMessage) {
    if (this.stopped) return;
    if (message.type === "session_registered") {
      this.registered = true;
      this.options.callbacks.onState("online", `codexhub machine session connected: ${message.sessionId}`);
      this.flushPending();
      return;
    }
    if (message.type === "session_commands") {
      this.commandCursor = Math.max(this.commandCursor, message.cursor);
      this.enqueueCommands(message.commands);
      return;
    }
    console.error(`codexhub machine session error: ${message.message}`);
  }

  private register() {
    this.options.callbacks.onState("connecting", `codexhub machine session connecting: ${this.options.sessionId}`);
    this.options.send({
      type: "session_register",
      sessionId: this.options.sessionId,
      commandCursor: this.commandCursor,
      registration: this.options.callbacks.registration()
    });
  }

  private enqueueCommands(commands: SessionCommand[]) {
    this.commandChain = this.commandChain.then(async () => {
      for (const command of commands) {
        try {
          const result = await this.options.callbacks.handleCommand(command);
          if (result !== undefined) {
            this.sendOrQueue({
              type: "session_command_result",
              sessionId: this.options.sessionId,
              commandId: command.commandId,
              result
            });
          }
        } catch (error) {
          this.sendOrQueue({
            type: "session_command_error",
            sessionId: this.options.sessionId,
            commandId: command.commandId,
            message: errorText(error)
          });
        } finally {
          this.commandCursor = Math.max(this.commandCursor, command.seq);
        }
      }
    }).catch((error) => {
      console.error(`codexhub machine session command queue failed: ${errorText(error)}`);
    });
  }

  private flushPending() {
    for (const message of this.pendingOutgoing.splice(0)) this.options.send(message);
  }

  private sendOrQueue(message: unknown, options: { queue?: boolean } = {}) {
    if (this.registered) {
      this.options.send(message);
      return;
    }
    if (options.queue === false) return;
    this.pendingOutgoing.push(message);
    if (this.pendingOutgoing.length > 1000) this.pendingOutgoing.splice(0, this.pendingOutgoing.length - 1000);
  }
}

const resolveDirectory = async (input: string) => {
  const cwd = path.resolve(expandHome(input.trim()));
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  await access(cwd);
  return cwd;
};

const expandHome = (input: string) => {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
};

const machineTransportUrl = (apiBase: string, authToken?: string) => {
  const url = new URL("/api/machines/connect", apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (authToken?.trim()) url.searchParams.set("codexhub_token", authToken.trim());
  return url.toString();
};

const openWebSocket = async (url: string) => {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`WebSocket failed: ${url}`)), { once: true });
  });
  return ws;
};

const parseMachineTransportMessage = (data: unknown): MachineTransportMessage | null => {
  const message = parseJsonRecord(data);
  if (!message) return null;
  const type = typeof message.type === "string" ? message.type : "";
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
      ? { type: "session_commands", sessionId, cursor, commands: message.commands as SessionCommand[] }
      : null;
  }
  if (type === "session_error") {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const messageText = typeof message.message === "string" ? message.message : "machine session server error";
    return sessionId ? { type: "session_error", sessionId, message: messageText } : null;
  }
  if (type === "error") {
    return { type: "error", message: typeof message.message === "string" ? message.message : "machine transport server error" };
  }
  return null;
};

type JsonRecord = Record<string, unknown>;

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
