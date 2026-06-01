import { createHash, randomUUID } from "node:crypto";
import type { Input, ThreadOptions, Usage } from "@openai/codex-sdk";
import { asRecord, type CodexRecord } from "./codexRecord.js";
import { recordsToViews } from "./codexRecordView.js";

export type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  model?: string;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
  runtime: ThreadRuntimeSummary;
  status: "running" | "idle";
  running: boolean;
  attachCount: number;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
};

export type ThreadRuntimeSummary =
  | {
      kind: "worker";
      workerId: string;
      name?: string;
      appServerUrl?: string;
      online: boolean;
      lastSeenAt: string;
    }
  | { kind: "detached"; online: false };

export type ThreadDetail = ThreadSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

export type ThreadStreamEvent = {
  seq: number;
  threadId: string;
  kind: "thread" | "record" | "done";
  thread: ThreadSummary;
  record?: CodexRecord;
};

export type WorkerRegistration = {
  workerId?: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  pid?: number;
  hostname?: string;
};

export type WorkerSummary = {
  workerId: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  online: boolean;
  lastSeenAt: string;
  pid?: number;
  hostname?: string;
};

export type WorkerCommand = {
  seq: number;
  commandId: string;
  type: "fork_thread" | "turn" | "stop";
  workingDirectory: string;
  createdAt: string;
  threadId?: string;
  input?: Input;
  turnId?: string;
  options?: ThreadOptions;
};

export type WorkerEventInput = {
  threadId?: string;
  commandId?: string;
  heartbeat?: boolean;
  message: unknown;
};

type RuntimeWorker = WorkerSummary & {
  commands: WorkerCommand[];
  waiters: Set<WorkerWaiter>;
};

type RuntimeThread = {
  threadId: string;
  workingDirectory: string;
  workerId?: string;
  appServerTurnId?: string;
  threadOptions: ThreadOptions;
  running: boolean;
  title: string;
  updatedAt: string;
  records: CodexRecord[];
  events: ThreadStreamEvent[];
  appServerItems: Map<string, AppServerItemState>;
  subscribers: Set<(event: ThreadStreamEvent) => void>;
  attachments: Set<string>;
  lastUsage?: Usage;
  seq: number;
};

type PendingCommand = {
  type: WorkerCommand["type"];
  threadId?: string;
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type WorkerWaiter = () => void;

type AppServerItemState = {
  text?: string;
  phase?: string | null;
};

export class ThreadHub {
  private readonly threads = new Map<string, RuntimeThread>();
  private readonly workers = new Map<string, RuntimeWorker>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly activeTurnCommands = new Map<string, string>();

  constructor(private readonly defaultThreadOptions: ThreadOptions = {}) {}

  registerWorker(registration: WorkerRegistration): { workerId: string; worker: WorkerSummary } {
    const now = new Date().toISOString();
    const workerId = registration.workerId?.trim() || randomUUID();
    const existing = this.workers.get(workerId);
    if (existing) {
      this.rejectPendingWorkerCommands(existing, new Error(`Worker reconnected: ${workerId}`));
      for (const waiter of [...existing.waiters]) waiter();
    }
    const worker: RuntimeWorker = {
      workerId,
      name: registration.name,
      workingDirectory: registration.workingDirectory,
      appServerUrl: registration.appServerUrl,
      online: true,
      lastSeenAt: now,
      pid: registration.pid,
      hostname: registration.hostname,
      commands: [],
      waiters: existing?.waiters ?? new Set()
    };
    this.workers.set(workerId, worker);
    for (const thread of this.threads.values()) {
      if (thread.workerId === workerId) this.publish(thread, "thread");
    }
    return { workerId, worker: workerSummary(worker) };
  }

  heartbeatWorker(workerId: string, registration: Partial<WorkerRegistration> = {}) {
    const worker = this.workers.get(workerId);
    if (!worker) return { ok: false };
    const now = new Date().toISOString();
    worker.name = registration.name ?? worker.name;
    worker.workingDirectory = registration.workingDirectory ?? worker.workingDirectory;
    worker.appServerUrl = registration.appServerUrl ?? worker.appServerUrl;
    worker.pid = registration.pid ?? worker.pid;
    worker.hostname = registration.hostname ?? worker.hostname;
    worker.online = true;
    worker.lastSeenAt = now;
    for (const thread of this.threads.values()) {
      if (thread.workerId === workerId) this.publish(thread, "thread");
    }
    return { ok: true, workerId };
  }

  unregisterWorker(workerId: string) {
    const worker = this.workers.get(workerId);
    if (!worker) return { ok: false };
    this.markWorkerOffline(worker, `Worker unregistered: ${workerId}`);
    return { ok: true, workerId };
  }

  markStaleWorkersOffline(timeoutMs: number, now = Date.now()) {
    let offline = 0;
    for (const worker of this.workers.values()) {
      if (!worker.online) continue;
      const lastSeenAt = Date.parse(worker.lastSeenAt);
      if (Number.isFinite(lastSeenAt) && now - lastSeenAt <= timeoutMs) continue;
      this.markWorkerOffline(worker, `Worker heartbeat timed out: ${worker.workerId}`);
      offline += 1;
    }
    return { offline };
  }

  listWorkers(): WorkerSummary[] {
    return [...this.workers.values()].map(workerSummary);
  }

  async waitWorkerCommands(workerId: string, after: number, timeoutMs = 25000) {
    const worker = this.workers.get(workerId);
    if (!worker) return { workerId, cursor: after, commands: [] };
    if (workerCommandsAfter(worker, after).length === 0) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout;
        const waiter = () => {
          clearTimeout(timer);
          worker.waiters.delete(waiter);
          resolve();
        };
        timer = setTimeout(waiter, timeoutMs);
        worker.waiters.add(waiter);
      });
    }
    const commands = workerCommandsAfter(worker, after);
    return {
      workerId,
      cursor: commands.at(-1)?.seq ?? after,
      commands
    };
  }

  applyWorkerEvent(workerId: string, input: WorkerEventInput) {
    if (input.heartbeat !== false) this.heartbeatWorker(workerId);
    const worker = this.requireWorker(workerId);
    const message = asRecord(input.message);
    if (!message) return { ok: true };

    const threadId = input.threadId ?? threadIdFromAppServerMessage(message);
    const error = asRecord(message.error);
    if (error) {
      this.rejectCommand(input.commandId, new Error(stringify(error)));
      if (threadId) this.finishWorkerTurnByThread(threadId, new Error(stringify(error)));
      return { ok: true };
    }

    const thread = threadId ? this.ensureThread(threadId, worker, message) : null;
    if (thread) this.applyAppServerMessage(thread, message);

    if (input.commandId) this.resolveCommandFromMessage(input.commandId, thread);
    return { ok: true, thread: thread ? this.summary(thread) : undefined };
  }

  listThreads(): ThreadSummary[] {
    return [...this.threads.values()].map((thread) => this.summary(thread));
  }

  getThread(threadId: string): ThreadDetail | null {
    const thread = this.threads.get(threadId);
    return thread ? this.detail(thread) : null;
  }

  restoreThread(
    workingDirectory: string,
    threadId: string,
    records: CodexRecord[],
    title = threadId,
    options: ThreadOptions = {}
  ): ThreadDetail {
    const worker = this.workerForWorkspace(workingDirectory);
    const now = new Date().toISOString();
    const thread: RuntimeThread = {
      threadId,
      workingDirectory,
      workerId: worker?.workerId,
      threadOptions: { ...this.defaultThreadOptions, ...options },
      running: false,
      title,
      updatedAt: records.at(-1)?.timestamp ?? now,
      records,
      events: [],
      appServerItems: new Map(),
      subscribers: new Set(),
      attachments: new Set(),
      lastUsage: latestUsage(records),
      seq: 0
    };
    this.threads.set(thread.threadId, thread);
    this.publish(thread, "thread");
    return this.detail(thread);
  }

  async forkThread(threadId: string, _recordId?: string): Promise<ThreadDetail> {
    const source = this.requireThread(threadId);
    const worker = this.requireThreadWorker(source);
    const commandId = randomUUID();
    const promise = this.waitForCommand<ThreadDetail>(commandId, "fork_thread", source.threadId);
    this.enqueueWorkerCommand(worker.workerId, {
      commandId,
      type: "fork_thread",
      workingDirectory: source.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: source.threadId,
      options: { ...source.threadOptions }
    });
    return promise;
  }

  async deleteThread(threadId: string) {
    const thread = this.requireThread(threadId);
    thread.running = false;
    this.threads.delete(threadId);
    this.publish(thread, "done");
    return { deleted: true, attachCount: 0 };
  }

  attach(threadId: string, clientId: string): ThreadDetail {
    const thread = this.requireThread(threadId);
    thread.attachments.add(clientId);
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    return this.detail(thread);
  }

  detach(threadId: string, clientId: string) {
    const thread = this.requireThread(threadId);
    thread.attachments.delete(clientId);
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    return { deleted: false, attachCount: thread.attachments.size };
  }

  stopTurn(threadId: string) {
    const thread = this.requireThread(threadId);
    if (!thread.running) return { stopped: false };
    const worker = this.requireThreadWorker(thread);
    this.enqueueWorkerCommand(worker.workerId, {
      commandId: randomUUID(),
      type: "stop",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
      turnId: thread.appServerTurnId
    });
    return { stopped: true };
  }

  runTurn(threadId: string, input: Input, _source: "web" | "telegram" | "task" = "web") {
    const thread = this.requireThread(threadId);
    if (thread.running) throw new Error(`Thread is already running: ${threadId}`);
    const worker = this.requireThreadWorker(thread);
    const commandId = randomUUID();
    const promise = this.waitForCommand<void>(commandId, "turn", thread.threadId, 15 * 60_000);
    this.activeTurnCommands.set(thread.threadId, commandId);

    const userText = summarizeInput(input);
    this.appendUserInputRecord(thread, input);
    if (userText && thread.title === thread.threadId) thread.title = userText.slice(0, 80);
    thread.running = true;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");

    this.enqueueWorkerCommand(worker.workerId, {
      commandId,
      type: "turn",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      input,
      threadId: thread.threadId,
      options: { ...thread.threadOptions }
    });
    return promise;
  }

  subscribe(threadId: string, after: number, callback: (event: ThreadStreamEvent) => void) {
    const thread = this.requireThread(threadId);
    for (const event of thread.events.filter((item) => item.seq > after)) callback(event);
    thread.subscribers.add(callback);
    return () => thread.subscribers.delete(callback);
  }

  private requireWorker(workerId: string) {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`Worker not found: ${workerId}`);
    return worker;
  }

  private requireThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private workerForWorkspace(workingDirectory: string) {
    return [...this.workers.values()]
      .filter((worker) => worker.online && worker.workingDirectory === workingDirectory)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0] ?? null;
  }

  private requireThreadWorker(thread: RuntimeThread) {
    const current = thread.workerId ? this.workers.get(thread.workerId) : null;
    if (current?.online) return current;
    const replacement = this.workerForWorkspace(thread.workingDirectory);
    if (replacement) {
      thread.workerId = replacement.workerId;
      this.publish(thread, "thread");
      return replacement;
    }
    throw new Error(`No online worker for thread: ${thread.threadId}`);
  }

  private enqueueWorkerCommand(workerId: string, command: Omit<WorkerCommand, "seq">) {
    const worker = this.requireWorker(workerId);
    const next: WorkerCommand = {
      ...command,
      seq: (worker.commands.at(-1)?.seq ?? 0) + 1
    };
    worker.commands.push(next);
    if (worker.commands.length > 500) worker.commands.splice(0, worker.commands.length - 500);
    for (const waiter of [...worker.waiters]) waiter();
    return next;
  }

  private waitForCommand<T>(
    commandId: string,
    type: WorkerCommand["type"],
    threadId?: string,
    timeoutMs = 30000
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        if (threadId && this.activeTurnCommands.get(threadId) === commandId) {
          this.activeTurnCommands.delete(threadId);
          const thread = this.threads.get(threadId);
          if (thread) {
            thread.running = false;
            this.publish(thread, "done");
          }
        }
        reject(new Error(`Worker command timed out: ${type}`));
      }, timeoutMs);
      this.pendingCommands.set(commandId, {
        type,
        threadId,
        resolve: resolve as (value?: unknown) => void,
        reject,
        timer
      });
    });
  }

  private resolveCommandFromMessage(commandId: string, thread: RuntimeThread | null) {
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return;
    if (pending.type === "fork_thread" && thread) {
      this.resolveCommand(commandId, this.detail(thread));
    }
  }

  private resolveCommand(commandId: string, value?: unknown) {
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(commandId);
    pending.resolve(value);
  }

  private rejectCommand(commandId: string | undefined, error: Error) {
    if (!commandId) return;
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(commandId);
    pending.reject(error);
  }

  private markWorkerOffline(worker: RuntimeWorker, message: string) {
    const wasOnline = worker.online;
    worker.online = false;
    worker.lastSeenAt = new Date().toISOString();
    this.rejectPendingWorkerCommands(worker, new Error(message));
    for (const waiter of [...worker.waiters]) waiter();
    for (const thread of this.threads.values()) {
      if (thread.workerId !== worker.workerId) continue;
      if (thread.running) {
        this.finishWorkerTurnByThread(thread.threadId, new Error(message));
      } else if (wasOnline) {
        this.publish(thread, "thread");
      }
    }
  }

  private rejectPendingWorkerCommands(worker: RuntimeWorker, error: Error) {
    for (const command of worker.commands) this.rejectCommand(command.commandId, error);
  }

  private ensureThread(threadId: string, worker: RuntimeWorker, message: Record<string, unknown>) {
    const existing = this.threads.get(threadId);
    if (existing) {
      if (!existing.workerId) existing.workerId = worker.workerId;
      return existing;
    }

    const appThread = appServerThreadFromMessage(message);
    const now = new Date().toISOString();
    const workingDirectory = typeof appThread?.cwd === "string" ? appThread.cwd : worker.workingDirectory;
    const title = typeof appThread?.preview === "string" && appThread.preview.trim()
      ? appThread.preview.slice(0, 80)
      : threadId;
    const thread: RuntimeThread = {
      threadId,
      workingDirectory,
      workerId: worker.workerId,
      threadOptions: { ...this.defaultThreadOptions },
      running: false,
      title,
      updatedAt: now,
      records: [],
      events: [],
      appServerItems: new Map(),
      subscribers: new Set(),
      attachments: new Set(),
      seq: 0
    };
    this.threads.set(thread.threadId, thread);
    this.publish(thread, "thread");
    return thread;
  }

  private applyAppServerMessage(thread: RuntimeThread, message: unknown) {
    const record = asRecord(message);
    if (!record) return;

    const result = asRecord(record.result);
    const resultThread = asRecord(result?.thread);
    const resultTurn = asRecord(result?.turn);
    if (resultThread) {
      this.applyAppServerThread(thread, resultThread);
      this.applyAppServerThreadTurns(thread, resultThread);
    }
    if (resultTurn) this.applyAppServerTurn(thread, resultTurn);

    const method = typeof record.method === "string" ? record.method : "";
    const params = asRecord(record.params);
    if (!method || !params) return;

    if (method === "thread/started") {
      const appThread = asRecord(params.thread);
      if (appThread) this.applyAppServerThread(thread, appThread);
      return;
    }

    if (method === "thread/status/changed") {
      const status = asRecord(params.status);
      if (status?.type === "active" && !thread.running) {
        thread.running = true;
        this.publish(thread, "thread");
      }
      if (status?.type === "idle" && thread.running) this.finishWorkerTurn(thread);
      return;
    }

    if (method === "turn/started") {
      const turn = asRecord(params.turn);
      if (turn) this.applyAppServerTurn(thread, turn);
      thread.running = true;
      this.publish(thread, "thread");
      return;
    }

    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (turn) this.applyAppServerTurn(thread, turn);
      this.finishWorkerTurn(thread);
      return;
    }

    if (method === "error") {
      const error = asRecord(params.error);
      this.appendRuntimeRecord(thread, "error", {
        type: "app_server_error",
        message: typeof error?.message === "string" ? error.message : stringify(params)
      });
      this.finishWorkerTurn(thread);
      return;
    }

    if (method === "item/agentMessage/delta") {
      this.applyAgentMessageDelta(thread, params);
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = asRecord(params.item);
      if (item) this.applyAppServerItem(thread, item, method === "item/completed", params);
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      this.upsertRecord(thread, tokenUsageRecord(params));
    }
  }

  private applyAppServerThread(thread: RuntimeThread, appThread: Record<string, unknown>) {
    let changed = false;
    if (typeof appThread.cwd === "string" && thread.workingDirectory !== appThread.cwd) {
      thread.workingDirectory = appThread.cwd;
      changed = true;
    }
    if (typeof appThread.preview === "string" && appThread.preview.trim()) {
      const title = appThread.preview.slice(0, 80);
      if (thread.title !== title) {
        thread.title = title;
        changed = true;
      }
    }
    const status = asRecord(appThread.status);
    if (status?.type === "active" && !thread.running) {
      thread.running = true;
      changed = true;
    }
    if (status?.type === "idle" && thread.running) {
      thread.running = false;
      thread.appServerTurnId = undefined;
      changed = true;
    }
    if (!changed) return;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
  }

  private applyAppServerThreadTurns(thread: RuntimeThread, appThread: Record<string, unknown>) {
    if (!Array.isArray(appThread.turns)) return;
    const threadId = typeof appThread.id === "string" ? appThread.id : thread.threadId;
    for (const turnValue of appThread.turns) {
      const turn = asRecord(turnValue);
      if (!turn) continue;
      this.applyAppServerTurn(thread, turn);
      const params = appServerTurnParams(threadId, turn);
      const items = Array.isArray(turn.items) ? turn.items : [];
      for (const itemValue of items) {
        const item = asRecord(itemValue);
        if (item) this.applyAppServerItem(thread, item, true, params);
      }
    }
  }

  private applyAppServerTurn(thread: RuntimeThread, turn: Record<string, unknown>) {
    if (typeof turn.id === "string" && typeof turn.completedAt !== "number") thread.appServerTurnId = turn.id;
  }

  private applyAgentMessageDelta(thread: RuntimeThread, params: Record<string, unknown>) {
    if (typeof params.itemId !== "string") return;
    const state = thread.appServerItems.get(params.itemId) ?? {};
    state.text = `${state.text ?? ""}${typeof params.delta === "string" ? params.delta : ""}`;
    thread.appServerItems.set(params.itemId, state);
    this.upsertRecord(thread, appServerAgentMessageRecord(params.itemId, state, params));
  }

  private applyAppServerItem(
    thread: RuntimeThread,
    item: Record<string, unknown>,
    completed: boolean,
    params: Record<string, unknown>
  ) {
    const itemId = typeof item.id === "string" ? item.id : randomUUID();
    switch (item.type) {
      case "userMessage":
        this.applyAppServerUserMessage(thread, itemId, item, params);
        return;
      case "agentMessage": {
        const state = thread.appServerItems.get(itemId) ?? {};
        state.text = typeof item.text === "string" ? item.text : state.text ?? "";
        state.phase = typeof item.phase === "string" ? item.phase : state.phase ?? "assistant";
        thread.appServerItems.set(itemId, state);
        this.upsertRecord(thread, appServerAgentMessageRecord(itemId, state, params));
        return;
      }
      case "reasoning":
      case "plan":
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "webSearch":
      case "imageGeneration":
        this.upsertRecord(thread, appServerItemRecord(itemId, item, params, completed));
        return;
      default:
        return;
    }
  }

  private applyAppServerUserMessage(
    thread: RuntimeThread,
    itemId: string,
    item: Record<string, unknown>,
    params: Record<string, unknown>
  ) {
    const record = appServerUserRecord(itemId, item, params);
    const payload = asRecord(record.payload);
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (message && thread.title === thread.threadId) thread.title = message.slice(0, 80);
    this.upsertRecord(thread, record);
  }

  private appendRuntimeRecord(thread: RuntimeThread, type: string, payload: unknown) {
    const record: CodexRecord = {
      id: `proxy:${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type,
      payload,
      sourceThreadId: thread.threadId
    };
    thread.records.push(record);
    thread.updatedAt = record.timestamp ?? thread.updatedAt;
    this.publish(thread, "record", record);
  }

  private appendUserInputRecord(thread: RuntimeThread, input: Input) {
    const record: CodexRecord = {
      id: `proxy:user:${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "user_message",
        message: summarizeInput(input),
        images: [],
        local_images: imagePaths(input),
        text_elements: []
      },
      sourceThreadId: thread.threadId
    };
    thread.records.push(record);
    thread.updatedAt = record.timestamp ?? thread.updatedAt;
    this.publish(thread, "record", record);
  }

  private removeOptimisticUserRecord(thread: RuntimeThread, incoming: CodexRecord) {
    const incomingPayload = asRecord(incoming.payload);
    if (incoming.type !== "event_msg" || incomingPayload?.type !== "user_message") return;
    const index = thread.records.findIndex((record) => {
      if (!record.id.startsWith("proxy:user:")) return false;
      const payload = asRecord(record.payload);
      return payload?.type === "user_message"
        && payload.message === incomingPayload.message
        && JSON.stringify(payload.local_images ?? []) === JSON.stringify(incomingPayload.local_images ?? []);
    });
    if (index !== -1) thread.records.splice(index, 1);
  }

  private upsertRecord(thread: RuntimeThread, record: CodexRecord) {
    const existingIndex = thread.records.findIndex((item) => item.id === record.id);
    if (existingIndex === -1) {
      this.removeOptimisticUserRecord(thread, record);
      thread.records.push(record);
    } else {
      if (recordsEqual(thread.records[existingIndex], record)) return;
      thread.records[existingIndex] = record;
    }
    thread.updatedAt = record.timestamp ?? new Date().toISOString();
    thread.lastUsage = latestUsage(thread.records);
    this.publish(thread, "record", record);
  }

  private finishWorkerTurnByThread(threadId: string, error?: Error) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    if (error) this.appendRuntimeRecord(thread, "error", { type: "error", message: error.message });
    this.finishWorkerTurn(thread, error);
  }

  private finishWorkerTurn(thread: RuntimeThread, error?: Error) {
    const commandId = this.activeTurnCommands.get(thread.threadId);
    if (commandId) {
      this.activeTurnCommands.delete(thread.threadId);
      if (error) this.rejectCommand(commandId, error);
      else this.resolveCommand(commandId);
    }
    const wasRunning = thread.running;
    thread.running = false;
    thread.appServerTurnId = undefined;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, wasRunning ? "done" : "thread");
  }

  private publish(
    thread: RuntimeThread,
    kind: ThreadStreamEvent["kind"],
    record?: CodexRecord
  ) {
    const streamEvent: ThreadStreamEvent = {
      seq: ++thread.seq,
      threadId: thread.threadId,
      kind,
      thread: this.summary(thread),
      record
    };
    thread.events.push(streamEvent);
    if (thread.events.length > 1000) thread.events.splice(0, thread.events.length - 1000);
    for (const subscriber of thread.subscribers) subscriber(streamEvent);
  }

  private summary(thread: RuntimeThread): ThreadSummary {
    return {
      threadId: thread.threadId,
      workingDirectory: thread.workingDirectory,
      model: thread.threadOptions.model,
      modelReasoningEffort: thread.threadOptions.modelReasoningEffort,
      runtime: this.runtimeSummary(thread),
      status: thread.running ? "running" : "idle",
      running: thread.running,
      attachCount: thread.attachments.size,
      title: thread.title,
      updatedAt: thread.updatedAt,
      messageCount: recordsToViews(thread.records).length,
      lastUsage: thread.lastUsage
    };
  }

  private detail(thread: RuntimeThread): ThreadDetail {
    return {
      ...this.summary(thread),
      records: thread.records,
      lastSeq: thread.seq
    };
  }

  private runtimeSummary(thread: RuntimeThread): ThreadRuntimeSummary {
    const worker = thread.workerId ? this.workers.get(thread.workerId) : null;
    return worker ? workerSummary(worker) : { kind: "detached", online: false };
  }
}

const workerSummary = (worker: RuntimeWorker): WorkerSummary & { kind: "worker" } => ({
  kind: "worker",
  workerId: worker.workerId,
  name: worker.name,
  workingDirectory: worker.workingDirectory,
  appServerUrl: worker.appServerUrl,
  online: worker.online,
  lastSeenAt: worker.lastSeenAt,
  pid: worker.pid,
  hostname: worker.hostname
});

const workerCommandsAfter = (worker: RuntimeWorker, after: number) =>
  worker.commands.filter((command) => command.seq > after);

const latestUsage = (records: CodexRecord[]) => {
  const views = recordsToViews(records);
  for (let i = views.length - 1; i >= 0; i -= 1) {
    if (views[i].usage) return views[i].usage;
  }
  return undefined;
};

const recordsEqual = (left: CodexRecord, right: CodexRecord) =>
  JSON.stringify(left) === JSON.stringify(right);

const threadIdFromAppServerMessage = (message: Record<string, unknown>) => {
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

const appServerThreadFromMessage = (message: Record<string, unknown>) => {
  const params = asRecord(message.params);
  const result = asRecord(message.result);
  return asRecord(result?.thread) ?? asRecord(params?.thread);
};

const appServerUserRecord = (
  itemId: string,
  item: Record<string, unknown>,
  params: Record<string, unknown>
): CodexRecord => {
  const content = Array.isArray(item.content) ? item.content : [];
  const message = userInputText(content);
  const localImages = userInputLocalImages(content);
  return {
    id: appServerRecordId("user", itemId, params, shortHash(`${message}\0${JSON.stringify(localImages)}`)),
    timestamp: timestampFromParams(params, "startedAtMs") ?? new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "user_message",
      message,
      images: [],
      local_images: localImages,
      text_elements: []
    },
    sourceThreadId: threadIdFromParams(params)
  };
};

const appServerAgentMessageRecord = (
  itemId: string,
  state: AppServerItemState,
  params: Record<string, unknown>
): CodexRecord => ({
  id: appServerRecordId("agent", itemId, params),
  timestamp: timestampFromParams(params, "completedAtMs")
    ?? timestampFromParams(params, "startedAtMs")
    ?? new Date().toISOString(),
  type: "event_msg",
  payload: {
    type: "agent_message",
    message: state.text ?? "",
    phase: state.phase ?? "final_answer"
  },
  sourceThreadId: threadIdFromParams(params)
});

const appServerItemRecord = (
  itemId: string,
  item: Record<string, unknown>,
  params: Record<string, unknown>,
  completed: boolean
): CodexRecord => ({
  id: `app:${threadIdFromParams(params)}:${itemId}`,
  timestamp: timestampFromParams(params, completed ? "completedAtMs" : "startedAtMs") ?? new Date().toISOString(),
  type: appServerItemRecordType(item),
  payload: appServerItemPayload(item),
  sourceThreadId: threadIdFromParams(params)
});

const appServerItemRecordType = (item: Record<string, unknown>) =>
  item.type === "imageGeneration" ? "event_msg" : "response_item";

const appServerItemPayload = (item: Record<string, unknown>) => {
  switch (item.type) {
    case "reasoning":
      return {
        type: "reasoning",
        summary: Array.isArray(item.summary) ? item.summary : [],
        content: Array.isArray(item.content) ? item.content.join("\n") : ""
      };
    case "plan":
      return {
        type: "reasoning",
        summary: typeof item.text === "string" ? [item.text] : [],
        content: ""
      };
    case "commandExecution":
      return {
        type: "local_shell_call",
        call_id: typeof item.id === "string" ? item.id : null,
        status: item.status === "completed" ? "completed" : "in_progress",
        action: {
          type: "exec",
          command: ["bash", "-lc", typeof item.command === "string" ? item.command : ""],
          timeout_ms: null,
          working_directory: typeof item.cwd === "string" ? item.cwd : null,
          env: null,
          user: null
        },
        aggregated_output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : ""
      };
    case "fileChange":
      return {
        type: "file_change",
        status: typeof item.status === "string" ? item.status : "completed",
        changes: Array.isArray(item.changes) ? item.changes : []
      };
    case "mcpToolCall":
      return {
        type: "mcp_tool_call",
        server: typeof item.server === "string" ? item.server : "",
        tool: typeof item.tool === "string" ? item.tool : "",
        status: typeof item.status === "string" ? item.status : "",
        arguments: item.arguments,
        result: item.result,
        error: item.error
      };
    case "webSearch":
      return {
        type: "web_search_call",
        query: typeof item.query === "string" ? item.query : "",
        action: item.action
      };
    case "imageGeneration":
      return {
        type: "image_generation_end",
        saved_path: typeof item.savedPath === "string" ? item.savedPath : undefined,
        revised_prompt: typeof item.revisedPrompt === "string" ? item.revisedPrompt : undefined
      };
    default:
      return {
        type: "app_server_item",
        item
      };
  }
};

const tokenUsageRecord = (params: Record<string, unknown>): CodexRecord => {
  const usage = asRecord(params.tokenUsage);
  const last = asRecord(usage?.last);
  return {
    id: `app:${threadIdFromParams(params)}:${typeof params.turnId === "string" ? params.turnId : "turn"}:usage`,
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: numberField(last, "inputTokens"),
          cached_input_tokens: numberField(last, "cachedInputTokens"),
          output_tokens: numberField(last, "outputTokens"),
          reasoning_output_tokens: numberField(last, "reasoningOutputTokens"),
          total_tokens: numberField(last, "totalTokens")
        }
      }
    },
    sourceThreadId: threadIdFromParams(params)
  };
};

const appServerRecordId = (
  kind: string,
  itemId: string,
  params: Record<string, unknown>,
  suffix?: string
) => {
  const threadId = threadIdFromParams(params);
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  const base = turnId
    ? `app:${threadId}:${turnId}:${kind}`
    : `app:${threadId}:${itemId}`;
  return suffix ? `${base}:${suffix}` : base;
};

const appServerTurnParams = (threadId: string | undefined, turn: Record<string, unknown>): Record<string, unknown> => ({
  threadId,
  turnId: typeof turn.id === "string" ? turn.id : undefined,
  startedAtMs: typeof turn.startedAt === "number" ? turn.startedAt * 1000 : undefined,
  completedAtMs: typeof turn.completedAt === "number" ? turn.completedAt * 1000 : undefined
});

const threadIdFromParams = (params: Record<string, unknown>) =>
  typeof params.threadId === "string" ? params.threadId : undefined;

const timestampFromParams = (params: Record<string, unknown>, key: string) =>
  typeof params[key] === "number" ? new Date(params[key] as number).toISOString() : undefined;

const userInputText = (content: unknown[]) => content
  .map((item) => {
    const record = asRecord(item);
    return record?.type === "text" && typeof record.text === "string" ? record.text : null;
  })
  .filter((text): text is string => Boolean(text?.trim()))
  .join("\n");

const userInputLocalImages = (content: unknown[]) => content
  .map((item) => {
    const record = asRecord(item);
    return record?.type === "localImage" && typeof record.path === "string" ? record.path : null;
  })
  .filter((text): text is string => Boolean(text?.trim()));

const summarizeInput = (input: Input) => {
  if (typeof input === "string") return input;
  return input
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
};

const imagePaths = (input: Input) => {
  if (typeof input === "string") return [];
  return input
    .filter((item) => item.type === "local_image")
    .map((item) => item.path);
};

const numberField = (record: Record<string, unknown> | null, key: string) =>
  typeof record?.[key] === "number" ? record[key] : 0;

const shortHash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const stringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
