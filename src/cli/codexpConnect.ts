import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Input } from "@openai/codex-sdk";
import type { Command } from "commander";
import type { WorkerCommand } from "../core/threadHub.js";

type ConnectOptions = {
  server?: string;
  cd?: string;
  name?: string;
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

export const registerConnectCommand = (program: Command) => {
  program
    .command("connect")
    .description("Connect this folder to a codex-proxy server using the official Codex app-server/TUI")
    .option("--server <url>", "codex-proxy API URL")
    .option("-C, --cd <dir>", "Codex working directory")
    .option("--name <name>", "worker display name")
    .option("--port <port>", "local Codex app-server websocket port")
    .option("--headless", "do not launch the official Codex TUI")
    .option("-m, --model <model>", "model for remote turns")
    .option("-s, --sandbox <mode>", "sandbox mode for remote turns", "workspace-write")
    .option("-a, --approval-policy <policy>", "approval policy for remote turns", "never")
    .action(async (options: ConnectOptions) => {
      const rootOptions = program.opts<{ api: string; cwd: string }>();
      const apiBase = options.server ?? rootOptions.api;
      const cwd = path.resolve(options.cd ?? rootOptions.cwd ?? process.cwd());
      const port = options.port ? Number(options.port) : await findFreePort();
      if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${options.port}`);

      const appServerUrl = `ws://127.0.0.1:${port}`;
      const appServer = await startCodexAppServer(cwd, appServerUrl, port);
      let bridge: CodexAppServerBridge | null = null;
      let registeredWorkerId: string | null = null;
      const cleanup = cleanupOnce(async () => {
        bridge?.close();
        appServer.kill("SIGTERM");
        if (registeredWorkerId) await unregisterWorker(apiBase, registeredWorkerId);
      });
      const onSignal = (signal: NodeJS.Signals) => {
        void cleanup().finally(() => process.kill(process.pid, signal));
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      try {
        const workerId = stableWorkerId(cwd);
        const registration = await apiJson<WorkerRegisterResponse>(apiBase, "/api/workers/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workerId,
            name: options.name ?? os.hostname(),
            workingDirectory: cwd,
            appServerUrl,
            pid: process.pid,
            hostname: os.hostname()
          })
        });
        registeredWorkerId = registration.workerId;

        bridge = await CodexAppServerBridge.connect({
          apiBase,
          appServerUrl,
          workerId: registration.workerId,
          cwd,
          model: options.model,
          sandbox: options.sandbox ?? "workspace-write",
          approvalPolicy: options.approvalPolicy ?? "never"
        });

        void bridge.runCommandLoop().catch((error) => {
          console.error(`codexp connect command loop failed: ${errorText(error)}`);
          process.exitCode = 1;
        });
        void bridge.runThreadSyncLoop().catch((error) => {
          console.error(`codexp connect thread sync failed: ${errorText(error)}`);
          process.exitCode = 1;
        });

        console.error([
          `codexp worker connected: ${registration.workerId}`,
          `server: ${apiBase}`,
          `cwd: ${cwd}`,
          `app-server: ${appServerUrl}`
        ].join("\n"));

        if (options.headless) {
          await waitForShutdown();
          return;
        }

        const tui = spawn("codex", ["--remote", appServerUrl, "-C", cwd], {
          cwd,
          stdio: "inherit"
        });
        await waitForChild(tui);
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        await cleanup();
      }
    });
};

class CodexAppServerBridge {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly syncedThreads = new Map<string, SyncedThread>();
  private nextId = 1;
  private cursor = 0;
  private closed = false;

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
      this.cursor = Math.max(this.cursor, response.cursor);
      for (const command of response.commands) {
        if (this.closed) return;
        await this.handleCommand(command);
        this.cursor = Math.max(this.cursor, command.seq);
      }
      await this.heartbeat();
    }
  }

  async runThreadSyncLoop() {
    while (!this.closed) {
      await delay(1500);
      for (const [threadId, state] of [...this.syncedThreads]) {
        if (this.closed) return;
        await this.syncThread(threadId, state);
      }
    }
  }

  close() {
    this.closed = true;
    this.ws.close();
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
      const result = asRecord(await this.request("thread/fork", {
        threadId: command.threadId,
        cwd: command.workingDirectory,
        model: command.options?.model ?? this.options.model,
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
      await this.request("thread/resume", {
        threadId,
        cwd: command.workingDirectory,
        model: command.options?.model ?? this.options.model,
        approvalPolicy: this.options.approvalPolicy,
        sandbox: this.options.sandbox
      }, command);
      this.bindThread(threadId);
    }
    await this.request("turn/start", {
      threadId,
      input: toAppServerInput(command.input)
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
      const threadId = threadIdForMessage(message) ?? pending.threadId;
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
        await this.forward(threadId, undefined, { result }, { heartbeat: false });
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

  private async forward(
    threadId: string,
    commandId: string | undefined,
    message: JsonRecord,
    options: { heartbeat?: boolean } = {}
  ) {
    await apiJson(this.options.apiBase, `/api/workers/${encodeURIComponent(this.options.workerId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, commandId, message, heartbeat: options.heartbeat })
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
    await apiJson(this.options.apiBase, `/api/workers/${encodeURIComponent(this.options.workerId)}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workingDirectory: this.options.cwd,
        appServerUrl: this.options.appServerUrl,
        pid: process.pid,
        hostname: os.hostname()
      })
    }).catch(() => undefined);
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

const toAppServerInput = (input: Input) => {
  if (typeof input === "string") return [{ type: "text", text: input, text_elements: [] }];
  return input.map((item) => {
    if (item.type === "text") return { type: "text", text: item.text, text_elements: [] };
    return { type: "localImage", path: item.path };
  });
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

const stableWorkerId = (cwd: string) => {
  const hash = createHash("sha256").update(`${os.hostname()}\0${cwd}`).digest("hex").slice(0, 16);
  return `local-${hash}`;
};

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

const waitForChild = async (child: ChildProcess) => await new Promise<void>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
    resolve();
  });
});

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

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
