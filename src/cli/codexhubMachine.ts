import { access, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createMachineId,
  type MachineCommand,
  type MachineDirectoryListing,
  type MachineRegistration,
  type MachineStartWorkerResult
} from "../core/machineHub.js";
import { startHeadlessCodexhubWorker, type HeadlessCodexhubWorkerHandle } from "./codexhubConnect.js";

type MachineRunnerOptions = {
  apiBase: string;
  machineId?: string;
  name?: string;
};

type MachineTransportMessage =
  | { type: "registered"; machineId: string; machine?: unknown }
  | { type: "commands"; cursor: number; commands: MachineCommand[] }
  | { type: "error"; message: string };

type ManagedWorker = {
  worker: HeadlessCodexhubWorkerHandle;
  cwd: string;
};

export const runCodexhubMachine = async (options: MachineRunnerOptions) => {
  const runner = new CodexhubMachineRunner(options);
  runner.start();
  await waitForShutdown();
  await runner.stop();
};

class CodexhubMachineRunner {
  private readonly machineId: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private registered = false;
  private loopStarted = false;
  private commandCursor = 0;
  private commandChain = Promise.resolve();
  private readonly workersByCwd = new Map<string, ManagedWorker>();

  constructor(private readonly options: MachineRunnerOptions) {
    this.machineId = options.machineId?.trim() || createMachineId(os.hostname());
  }

  start() {
    if (this.loopStarted) return;
    this.loopStarted = true;
    console.error(`codexhub machine starting: ${this.machineId}`);
    void this.runLoop();
  }

  async stop() {
    this.stopped = true;
    this.ws?.close();
    const workers = [...this.workersByCwd.values()];
    this.workersByCwd.clear();
    await Promise.allSettled(workers.map((item) => item.worker.stop()));
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
        this.registered = false;
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
    const heartbeat = setInterval(() => this.sendHeartbeat(), 10_000);
    heartbeat.unref?.();
    ws.addEventListener("message", (event) => this.handleMessage(event.data));
    ws.addEventListener("error", () => {
      if (!this.stopped) console.error("codexhub machine websocket error");
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

  private registration(): MachineRegistration {
    return {
      machineId: this.machineId,
      name: this.options.name,
      hostname: os.hostname(),
      pid: process.pid,
      platform: `${process.platform}-${process.arch}`,
      cwd: process.cwd()
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
      return;
    }
    if (message.type === "commands") {
      this.commandCursor = Math.max(this.commandCursor, message.cursor);
      this.enqueueCommands(message.commands);
      return;
    }
    console.error(`codexhub machine server error: ${message.message}`);
  }

  private enqueueCommands(commands: MachineCommand[]) {
    this.commandChain = this.commandChain.then(async () => {
      for (const command of commands) {
        try {
          const result = command.type === "start_worker"
            ? await this.startWorker(command)
            : await this.listDirectory(command);
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

  private async startWorker(command: MachineCommand): Promise<MachineStartWorkerResult> {
    if (command.type !== "start_worker") throw new Error(`Unexpected command: ${command.type}`);
    const cwd = await resolveDirectory(command.cwd);
    const existing = command.reuse !== false ? this.workersByCwd.get(cwd) : undefined;
    if (existing) {
      return {
        workerId: existing.worker.workerId,
        threadId: existing.worker.threadId,
        appServerUrl: existing.worker.appServerUrl,
        cwd,
        reused: true
      };
    }

    console.error(`codexhub machine worker starting: ${cwd}`);
    const worker = await startHeadlessCodexhubWorker({
      apiBase: this.options.apiBase,
      machineId: this.machineId,
      cwd,
      readyLabel: "codexhub machine worker ready"
    });
    this.workersByCwd.set(cwd, { worker, cwd });
    void worker.wait().then(() => {
      if (this.workersByCwd.get(cwd)?.worker.workerId === worker.workerId) this.workersByCwd.delete(cwd);
    }).catch(() => {
      if (this.workersByCwd.get(cwd)?.worker.workerId === worker.workerId) this.workersByCwd.delete(cwd);
    });
    return {
      workerId: worker.workerId,
      threadId: worker.threadId,
      appServerUrl: worker.appServerUrl,
      cwd
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

const machineTransportUrl = (apiBase: string) => {
  const url = new URL("/api/machines/connect", apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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
