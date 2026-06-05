import { randomUUID } from "node:crypto";
import type { ThreadOptions, Usage } from "@openai/codex-sdk";
import { asRecord, type CodexRecord } from "./codexRecord.js";
import { recordsToViews } from "./codexRecordView.js";
import type { CodexUsageSnapshot } from "./codexUsage.js";
import type { ProxyInput } from "./proxyInput.js";

export type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  model?: string;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
  runtime: ThreadRuntimeSummary;
  status: "running" | "idle";
  running: boolean;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
  codexUsage?: CodexUsageSnapshot;
};

export type ThreadRuntimeSummary = {
  workerId?: string;
  name?: string;
  appServerUrl?: string;
  online: boolean;
  runnable: boolean;
  lastSeenAt?: string;
};

export type ThreadRunOptions = {
  model?: string | null;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"] | null;
};

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
  currentThreadId?: string;
  codexUsage?: CodexUsageSnapshot;
  threadCodexUsage?: Record<string, CodexUsageSnapshot>;
  transportId?: string;
};

export type WorkerOfflineReason = "heartbeat_timeout" | "transport_disconnected" | "unregistered";

export type WorkerSummary = {
  workerId: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  online: boolean;
  status: "online" | "offline";
  lastSeenAt: string;
  offlineSinceAt?: string;
  offlineReason?: WorkerOfflineReason;
  pid?: number;
  hostname?: string;
  currentThreadId?: string;
  currentThread?: ThreadSummary;
  threads: ThreadSummary[];
  codexUsage?: CodexUsageSnapshot;
};

export type WorkerStreamEvent = {
  seq: number;
  kind: "workers";
  workers: WorkerSummary[];
};

export type WorkerCommand = {
  seq: number;
  commandId: string;
  type: "fork_thread" | "rollback_thread" | "turn" | "stop";
  workingDirectory: string;
  createdAt: string;
  threadId?: string;
  input?: ProxyInput;
  turnId?: string;
  numTurns?: number;
  keepTurns?: number;
  options?: ThreadRunOptions;
};

export type WorkerEventInput =
  | {
      type: "thread_event";
      threadId: string;
      commandId?: string;
      heartbeat?: boolean;
      message: unknown;
    }
  | {
      type: "worker_current_changed";
      currentThreadId: string;
      heartbeat?: boolean;
    }
  | {
      type: "thread_execution_changed";
      threadId: string;
      running: boolean;
      turnId?: string;
      heartbeat?: boolean;
    }
  | {
      type: "runtime_settings_changed";
      threadId: string;
      model?: string | null;
      modelReasoningEffort?: ThreadOptions["modelReasoningEffort"] | null;
      heartbeat?: boolean;
    };

export type WorkerRecordsInput = {
  threadId: string;
  records: CodexRecord[];
  heartbeat?: boolean;
};

type RuntimeWorker = WorkerSummary & {
  transportId?: string;
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
  subscribers: Set<(event: ThreadStreamEvent) => void>;
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

export class ThreadHub {
  private readonly threads = new Map<string, RuntimeThread>();
  private readonly workers = new Map<string, RuntimeWorker>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly activeTurnCommands = new Map<string, string>();
  private readonly codexUsageByThread = new Map<string, CodexUsageSnapshot>();
  private readonly workerEvents: WorkerStreamEvent[] = [];
  private readonly workerSubscribers = new Set<(event: WorkerStreamEvent) => void>();
  private lastWorkerSnapshotKey = "";
  private workerSeq = 0;

  constructor(private readonly defaultThreadOptions: ThreadOptions = {}) {}

  registerWorker(registration: WorkerRegistration): { workerId: string; worker: WorkerSummary } {
    const now = new Date().toISOString();
    const workerId = registration.workerId?.trim() || randomUUID();
    const existing = this.workers.get(workerId);
    if (existing) {
      for (const waiter of [...existing.waiters]) waiter();
    }
    const worker: RuntimeWorker = {
      workerId,
      name: registration.name,
      workingDirectory: registration.workingDirectory,
      appServerUrl: registration.appServerUrl,
      online: true,
      status: "online",
      lastSeenAt: now,
      pid: registration.pid,
      hostname: registration.hostname,
      currentThreadId: registration.currentThreadId,
      codexUsage: registration.codexUsage,
      threads: [],
      transportId: registration.transportId,
      commands: existing?.commands ?? [],
      waiters: existing?.waiters ?? new Set()
    };
    this.applyThreadCodexUsage(registration.threadCodexUsage);
    this.workers.set(workerId, worker);
    if (registration.currentThreadId) {
      this.ensureThread(registration.currentThreadId, worker, {
        params: { threadId: registration.currentThreadId, cwd: worker.workingDirectory }
      });
    }
    for (const thread of this.threads.values()) {
      if (thread.workerId === workerId) {
        thread.workerId = workerId;
        this.publish(thread, "thread");
      }
    }
    this.publishWorkers();
    return { workerId, worker: this.workerSummary(worker) };
  }

  heartbeatWorker(workerId: string, registration: Partial<WorkerRegistration> = {}) {
    const worker = this.workers.get(workerId);
    if (!worker) return { ok: false };
    const previousState = this.workerVisibleState(worker);
    const now = new Date().toISOString();
    worker.name = registration.name ?? worker.name;
    worker.workingDirectory = registration.workingDirectory ?? worker.workingDirectory;
    worker.appServerUrl = registration.appServerUrl ?? worker.appServerUrl;
    worker.pid = registration.pid ?? worker.pid;
    worker.hostname = registration.hostname ?? worker.hostname;
    worker.codexUsage = registration.codexUsage ?? worker.codexUsage;
    const changedUsageThreadIds = this.applyThreadCodexUsage(registration.threadCodexUsage);
    worker.online = true;
    worker.status = "online";
    worker.lastSeenAt = now;
    delete worker.offlineSinceAt;
    delete worker.offlineReason;
    if (previousState !== this.workerVisibleState(worker) || changedUsageThreadIds.length) {
      for (const thread of this.threads.values()) {
        if (thread.workerId === workerId || changedUsageThreadIds.includes(thread.threadId)) this.publish(thread, "thread");
      }
      this.publishWorkers();
    }
    return { ok: true, workerId };
  }

  unregisterWorker(workerId: string, transportId?: string) {
    const worker = this.workers.get(workerId);
    if (!worker) return { ok: false };
    if (transportId && worker.transportId && worker.transportId !== transportId) return { ok: true, workerId };
    this.removeWorker(worker, `Worker unregistered: ${workerId}`, "unregistered");
    return { ok: true, workerId };
  }

  disconnectWorker(workerId: string, transportId?: string) {
    const worker = this.workers.get(workerId);
    if (!worker) return { ok: false };
    if (transportId && worker.transportId && worker.transportId !== transportId) return { ok: true, workerId };
    this.markWorkerOffline(worker, `Worker transport disconnected: ${workerId}`, "transport_disconnected");
    return { ok: true, workerId };
  }

  failWorkerCommand(workerId: string, commandId: string, message: string) {
    const worker = this.workers.get(workerId);
    if (!worker) return { ok: false };
    const pending = this.pendingCommands.get(commandId);
    const error = new Error(message || `Worker command failed: ${commandId}`);
    if (pending?.threadId && this.activeTurnCommands.get(pending.threadId) === commandId) {
      this.finishWorkerTurnByThread(pending.threadId, error);
    } else {
      this.rejectCommand(commandId, error);
    }
    return { ok: true, workerId, commandId };
  }

  markStaleWorkersOffline(timeoutMs: number, now = Date.now(), offlineRetentionMs = Number.POSITIVE_INFINITY) {
    let offline = 0;
    let removed = 0;
    for (const worker of this.workers.values()) {
      if (worker.online) {
        const lastSeenAt = Date.parse(worker.lastSeenAt);
        if (Number.isFinite(lastSeenAt) && now - lastSeenAt <= timeoutMs) continue;
        this.markWorkerOffline(worker, `Worker heartbeat timed out: ${worker.workerId}`, "heartbeat_timeout", now);
        offline += 1;
        continue;
      }

      const offlineSinceAt = Date.parse(worker.offlineSinceAt ?? worker.lastSeenAt);
      if (!Number.isFinite(offlineSinceAt) || now - offlineSinceAt < offlineRetentionMs) continue;
      this.removeWorker(worker, `Worker offline retention expired: ${worker.workerId}`, worker.offlineReason ?? "heartbeat_timeout", now);
      removed += 1;
    }
    return { offline, removed };
  }

  listWorkers(options: { includeOffline?: boolean } = {}): WorkerSummary[] {
    return [...this.workers.values()]
      .filter((worker) => options.includeOffline || worker.online || Boolean(worker.offlineSinceAt))
      .map((worker) => this.workerSummary(worker));
  }

  subscribeWorkers(after: number, callback: (event: WorkerStreamEvent) => void) {
    const events = after > 0 ? this.workerEvents.filter((item) => item.seq > after) : [];
    if (events.length) {
      for (const event of events) callback(event);
    } else {
      callback(this.workerSnapshotEvent());
    }
    this.workerSubscribers.add(callback);
    return () => this.workerSubscribers.delete(callback);
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
    if (input.type === "worker_current_changed") {
      const thread = this.ensureThread(input.currentThreadId, worker, {
        params: { threadId: input.currentThreadId, cwd: worker.workingDirectory }
      }, false);
      if (this.markWorkerCurrentThread(worker, thread)) this.publishWorkers();
      return { ok: true, thread: this.summary(thread) };
    }

    if (input.type === "thread_execution_changed") {
      const thread = this.ensureThread(input.threadId, worker, {
        params: { threadId: input.threadId, cwd: worker.workingDirectory }
      }, false);
      this.applyThreadExecutionState(thread, input.running, input.turnId);
      return { ok: true, thread: this.summary(thread) };
    }

    if (input.type === "runtime_settings_changed") {
      const thread = this.ensureThread(input.threadId, worker, {
        params: { threadId: input.threadId, cwd: worker.workingDirectory }
      }, false);
      this.applyRuntimeSettings(thread, input.model, input.modelReasoningEffort);
      return { ok: true, thread: this.summary(thread) };
    }

    const message = asRecord(input.message);
    if (!message) return { ok: true };

    const threadId = this.threadIdForWorkerEvent(input, message);
    const error = asRecord(message.error);
    if (error) {
      this.rejectCommand(input.commandId, new Error(stringify(error)));
      if (threadId) this.finishWorkerTurnByThread(threadId, new Error(stringify(error)));
      return { ok: true };
    }

    const thread = threadId ? this.ensureThread(threadId, worker, message, false) : null;
    const pending = input.commandId ? this.pendingCommands.get(input.commandId) : undefined;
    if (thread && pending?.type === "rollback_thread" && asRecord(asRecord(message.result)?.thread)) {
      this.resetThreadRecords(thread);
    }
    if (thread) this.applyAppServerMessage(thread, message);

    if (input.commandId) this.resolveCommandFromMessage(input.commandId, thread);
    return { ok: true, thread: thread ? this.summary(thread) : undefined };
  }

  applyWorkerRecords(workerId: string, input: WorkerRecordsInput) {
    if (input.heartbeat !== false) this.heartbeatWorker(workerId);
    const worker = this.requireWorker(workerId);
    const thread = this.ensureThread(
      input.threadId,
      worker,
      { params: { threadId: input.threadId } },
      false
    );
    for (const record of input.records) {
      if (record.sourceThreadId && record.sourceThreadId !== input.threadId) continue;
      this.upsertRecord(thread, {
        ...record,
        sourceThreadId: record.sourceThreadId ?? input.threadId
      });
    }
    return { ok: true, thread: this.summary(thread), records: input.records.length };
  }

  listThreads(): ThreadSummary[] {
    return [...this.threads.values()].map((thread) => this.summary(thread));
  }

  getThread(threadId: string): ThreadDetail | null {
    const thread = this.threads.get(threadId);
    return thread ? this.detail(thread) : null;
  }

  getCodexUsage(threadId?: string): CodexUsageSnapshot {
    if (threadId) {
      const threadUsage = this.codexUsageByThread.get(threadId);
      if (threadUsage) return threadUsage;

      const thread = this.threads.get(threadId);
      const workerUsage = thread?.workerId ? this.workers.get(thread.workerId)?.codexUsage : undefined;
      return workerUsage ?? emptyCodexUsage("thread");
    }

    const worker = [...this.workers.values()]
      .filter((item) => item.online && item.codexUsage)
      .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))[0];
    return worker?.codexUsage ?? emptyCodexUsage("latest");
  }

  async forkThread(threadId: string, recordId?: string): Promise<ThreadDetail> {
    const source = this.requireThread(threadId);
    const worker = this.requireThreadWorker(source);
    const rollbackPlan = recordId ? rollbackPlanAfterRecord(source, recordId) : { rollbackTurns: 0, keepTurns: 0 };
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
    const forkedThread = await promise;
    if (rollbackPlan.rollbackTurns <= 0) return forkedThread;
    return await this.rollbackThread(forkedThread.threadId, rollbackPlan.rollbackTurns, rollbackPlan.keepTurns);
  }

  async rollbackThreadAfterRecord(threadId: string, recordId: string): Promise<ThreadDetail> {
    const thread = this.requireThread(threadId);
    const rollbackPlan = rollbackPlanAfterRecord(thread, recordId);
    if (rollbackPlan.rollbackTurns <= 0) return this.detail(thread);
    return await this.rollbackThread(thread.threadId, rollbackPlan.rollbackTurns, rollbackPlan.keepTurns);
  }

  private async rollbackThread(threadId: string, numTurns: number, keepTurns?: number): Promise<ThreadDetail> {
    const thread = this.requireThread(threadId);
    const worker = this.requireThreadWorker(thread);
    const commandId = randomUUID();
    const promise = this.waitForCommand<ThreadDetail>(commandId, "rollback_thread", thread.threadId);
    this.enqueueWorkerCommand(worker.workerId, {
      commandId,
      type: "rollback_thread",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
      numTurns,
      keepTurns
    });
    return promise;
  }

  async deleteThread(threadId: string) {
    const thread = this.requireThread(threadId);
    thread.running = false;
    this.threads.delete(threadId);
    for (const worker of this.workers.values()) {
      if (worker.currentThreadId === threadId) delete worker.currentThreadId;
    }
    this.publish(thread, "done");
    return { deleted: true };
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

  runLocalCommand(threadId: string, input: ProxyInput, _source: "web" | "telegram" | "task" = "web") {
    const command = parseLocalSlashCommand(input);
    if (!command) return { handled: false };

    const thread = this.requireThread(threadId);
    const worker = thread.workerId ? this.workers.get(thread.workerId) : null;
    this.appendUserInputRecord(thread, input);
    this.appendRuntimeRecord(thread, "event_msg", {
      type: "agent_message",
      message: this.localCommandMessage(thread, command),
      phase: "final_answer"
    });
    return { handled: true, command };
  }

  runTurn(threadId: string, input: ProxyInput, _source: "web" | "telegram" | "task" = "web", options?: ThreadRunOptions) {
    const thread = this.requireThread(threadId);
    if (thread.running) throw new Error(`Thread is already running: ${threadId}`);
    const worker = this.requireThreadWorker(thread);
    const commandOptions = options ? { ...options } : { ...thread.threadOptions };
    if (options) thread.threadOptions = applyThreadRunOptions(thread.threadOptions, options);
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
      options: commandOptions
    });
    return promise;
  }

  runWorkerTurn(workerId: string, input: ProxyInput, source: "web" | "telegram" | "task" = "web", options?: ThreadRunOptions) {
    const worker = this.requireWorker(workerId);
    if (!worker.online) throw new Error(`Worker is offline: ${workerId}`);
    if (!worker.currentThreadId) throw new Error(`Worker has no current thread: ${workerId}`);
    const thread = this.ensureThread(worker.currentThreadId, worker, {
      params: { threadId: worker.currentThreadId, cwd: worker.workingDirectory }
    });
    const promise = this.runTurn(thread.threadId, input, source, options);
    return { thread: this.summary(thread), promise };
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

  private threadIdForWorkerEvent(input: Extract<WorkerEventInput, { type: "thread_event" }>, message: Record<string, unknown>) {
    const pending = input.commandId ? this.pendingCommands.get(input.commandId) : undefined;
    if (pending?.type === "fork_thread") {
      return resultThreadIdFromAppServerMessage(message)
        ?? input.threadId
        ?? threadIdFromAppServerMessage(message);
    }
    return input.threadId ?? threadIdFromAppServerMessage(message);
  }

  private markWorkerCurrentThread(worker: RuntimeWorker, thread: RuntimeThread) {
    const changed = worker.currentThreadId !== thread.threadId;
    worker.currentThreadId = thread.threadId;
    return changed;
  }

  private requireThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private onlineWorkersForWorkspace(workingDirectory: string) {
    return [...this.workers.values()]
      .filter((worker) => worker.online && worker.workingDirectory === workingDirectory)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  private uniqueOnlineWorkerForWorkspace(workingDirectory: string) {
    const workers = this.onlineWorkersForWorkspace(workingDirectory);
    return workers.length === 1 ? workers[0] : null;
  }

  private requireThreadWorker(thread: RuntimeThread) {
    const current = thread.workerId ? this.workers.get(thread.workerId) : null;
    if (current?.online) return current;
    const workers = this.onlineWorkersForWorkspace(thread.workingDirectory);
    const replacement = workers.length === 1 ? workers[0] : null;
    if (replacement) {
      thread.workerId = replacement.workerId;
      this.publish(thread, "thread");
      return replacement;
    }
    if (workers.length > 1) {
      throw new Error(`Multiple online workers for workspace. Resume this thread in one codexhub instance before sending: ${thread.threadId}`);
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
    if ((pending.type === "fork_thread" || pending.type === "rollback_thread") && thread) {
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

  private markWorkerOffline(
    worker: RuntimeWorker,
    message: string,
    reason: WorkerOfflineReason,
    now = Date.now()
  ) {
    const wasOnline = worker.online;
    const offlineSinceAt = new Date(now).toISOString();
    worker.online = false;
    worker.status = "offline";
    worker.offlineSinceAt = worker.offlineSinceAt ?? offlineSinceAt;
    worker.offlineReason = reason;
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
    if (wasOnline) this.publishWorkers();
  }

  private removeWorker(
    worker: RuntimeWorker,
    message: string,
    reason: WorkerOfflineReason,
    now = Date.now()
  ) {
    const error = new Error(message);
    const offlineSinceAt = new Date(now).toISOString();
    worker.online = false;
    worker.status = "offline";
    worker.offlineSinceAt = worker.offlineSinceAt ?? offlineSinceAt;
    worker.offlineReason = reason;
    this.rejectPendingWorkerCommands(worker, error);
    for (const waiter of [...worker.waiters]) waiter();
    this.workers.delete(worker.workerId);
    for (const thread of this.threads.values()) {
      if (thread.workerId !== worker.workerId) continue;
      if (thread.running) {
        this.finishWorkerTurnByThread(thread.threadId, error);
      } else {
        this.publish(thread, "thread");
      }
    }
    this.publishWorkers();
  }

  private rejectPendingWorkerCommands(worker: RuntimeWorker, error: Error) {
    for (const command of worker.commands) this.rejectCommand(command.commandId, error);
  }

  private ensureThread(threadId: string, worker: RuntimeWorker, message: Record<string, unknown>, markCurrent = true) {
    const existing = this.threads.get(threadId);
    if (existing) {
      if (existing.workerId !== worker.workerId) {
        existing.workerId = worker.workerId;
        this.publish(existing, "thread");
      }
      if (markCurrent) this.markWorkerCurrentThread(worker, existing);
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
      subscribers: new Set(),
      seq: 0
    };
    this.threads.set(thread.threadId, thread);
    if (markCurrent) this.markWorkerCurrentThread(worker, thread);
    this.publish(thread, "thread");
    return thread;
  }

  private applyAppServerMessage(thread: RuntimeThread, message: unknown) {
    const record = asRecord(message);
    if (!record) return;

    const result = asRecord(record.result);
    const resultThread = asRecord(result?.thread);
    if (resultThread) {
      this.applyAppServerThread(thread, resultThread);
    }

    const method = typeof record.method === "string" ? record.method : "";
    const params = asRecord(record.params);
    if (!method || !params) return;

    if (method === "thread/started") {
      const appThread = asRecord(params.thread);
      if (appThread) this.applyAppServerThread(thread, appThread);
      return;
    }

    if (method === "thread/status/changed") {
      return;
    }

    if (method === "thread/settings/updated") {
      return;
    }

    if (method === "turn/started") {
      return;
    }

    if (method === "turn/completed") {
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

    if (method === "item/agentMessage/delta") return;

    if (method === "item/started" || method === "item/completed") return;

    if (method === "thread/tokenUsage/updated") return;
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
    if (!changed) return;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
  }

  private applyRuntimeSettings(
    thread: RuntimeThread,
    model: string | null | undefined,
    modelReasoningEffort: ThreadOptions["modelReasoningEffort"] | null | undefined
  ) {
    let changed = false;
    const nextModel = typeof model === "string" && model ? model : undefined;
    if (thread.threadOptions.model !== nextModel) {
      thread.threadOptions = { ...thread.threadOptions, model: nextModel };
      if (!nextModel) delete thread.threadOptions.model;
      changed = true;
    }
    const nextEffort = isThreadReasoningEffort(modelReasoningEffort) ? modelReasoningEffort : undefined;
    if (thread.threadOptions.modelReasoningEffort !== nextEffort) {
      thread.threadOptions = { ...thread.threadOptions, modelReasoningEffort: nextEffort };
      if (!nextEffort) delete thread.threadOptions.modelReasoningEffort;
      changed = true;
    }
    if (!changed) return;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
  }

  private applyThreadExecutionState(thread: RuntimeThread, running: boolean, turnId?: string) {
    let changed = false;
    if (thread.running !== running) {
      thread.running = running;
      changed = true;
    }
    const nextTurnId = running ? turnId : undefined;
    if (thread.appServerTurnId !== nextTurnId) {
      thread.appServerTurnId = nextTurnId;
      changed = true;
    }
    if (!changed) return;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, running ? "thread" : "done");
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

  private appendUserInputRecord(thread: RuntimeThread, input: ProxyInput) {
    const record: CodexRecord = {
      id: `proxy:user:${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "user_message",
        message: summarizeInput(input),
        images: imageUrls(input),
        text_elements: []
      },
      sourceThreadId: thread.threadId
    };
    thread.records.push(record);
    thread.updatedAt = record.timestamp ?? thread.updatedAt;
    this.publish(thread, "record", record);
  }

  private resetThreadRecords(thread: RuntimeThread) {
    thread.records = [];
    thread.lastUsage = undefined;
  }

  private applyThreadCodexUsage(usages?: Record<string, CodexUsageSnapshot>) {
    const changedThreadIds: string[] = [];
    if (!usages) return changedThreadIds;
    for (const [threadId, usage] of Object.entries(usages)) {
      if (!threadId || !usage) continue;
      const previous = this.codexUsageByThread.get(threadId);
      if (previous && JSON.stringify(previous) === JSON.stringify(usage)) continue;
      this.codexUsageByThread.set(threadId, usage);
      changedThreadIds.push(threadId);
    }
    return changedThreadIds;
  }

  private removeOptimisticUserRecord(thread: RuntimeThread, incoming: CodexRecord) {
    const incomingPayload = asRecord(incoming.payload);
    if (incoming.type !== "event_msg" || incomingPayload?.type !== "user_message") return;
    const index = thread.records.findIndex((record) => {
      if (!record.id.startsWith("proxy:user:")) return false;
      const payload = asRecord(record.payload);
      return payload?.type === "user_message"
        && payload.message === incomingPayload.message
        && JSON.stringify(payload.images ?? []) === JSON.stringify(incomingPayload.images ?? []);
    });
    if (index !== -1) thread.records.splice(index, 1);
  }

  private removeMatchingAppServerTranscriptRecord(thread: RuntimeThread, incoming: CodexRecord) {
    if (!incoming.line || incoming.type !== "event_msg") return;
    const incomingPayload = asRecord(incoming.payload);
    if (!incomingPayload) return;
    const incomingType = incomingPayload?.type;
    if (incomingType !== "user_message" && incomingType !== "agent_message") return;
    const incomingTurnId = turnIdFromAppRecordId(thread.threadId, incoming.id);
    const index = thread.records.findIndex((record) => {
      if (!record.id.startsWith("app:") || record.line) return false;
      const recordTurnId = turnIdFromAppRecordId(thread.threadId, record.id);
      if (incomingTurnId || recordTurnId) return incomingTurnId === recordTurnId && recordTurnId !== null;
      const payload = asRecord(record.payload);
      if (payload?.type !== incomingType) return false;
      if (payload.message !== incomingPayload.message) return false;
      if (incomingType === "agent_message" && payload.phase !== incomingPayload.phase) return false;
      if (incomingType === "user_message") {
        return JSON.stringify(payload.images ?? []) === JSON.stringify(incomingPayload.images ?? []);
      }
      return true;
    });
    if (index !== -1) thread.records.splice(index, 1);
  }

  private hasMatchingJsonlTranscriptRecord(thread: RuntimeThread, incoming: CodexRecord) {
    if (incoming.line) return false;
    if (!incoming.id.startsWith("app:") || incoming.type !== "event_msg") return false;
    const incomingPayload = asRecord(incoming.payload);
    if (!incomingPayload) return false;
    const incomingType = incomingPayload?.type;
    if (incomingType !== "user_message" && incomingType !== "agent_message") return false;
    const incomingTurnId = turnIdFromAppRecordId(thread.threadId, incoming.id);
    return thread.records.some((record) => {
      if (!record.line || record.type !== "event_msg") return false;
      const recordTurnId = turnIdFromAppRecordId(thread.threadId, record.id);
      if (incomingTurnId || recordTurnId) return incomingTurnId === recordTurnId && recordTurnId !== null;
      const payload = asRecord(record.payload);
      if (payload?.type !== incomingType || payload.message !== incomingPayload.message) return false;
      if (incomingType === "agent_message") return payload.phase === incomingPayload.phase;
      return JSON.stringify(payload.images ?? []) === JSON.stringify(incomingPayload.images ?? []);
    });
  }

  private upsertRecord(thread: RuntimeThread, record: CodexRecord) {
    if (this.hasMatchingJsonlTranscriptRecord(thread, record)) return;
    const existingIndex = thread.records.findIndex((item) => item.id === record.id);
    if (existingIndex === -1) {
      this.removeOptimisticUserRecord(thread, record);
      this.removeMatchingAppServerTranscriptRecord(thread, record);
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
    this.publishWorkers();
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
      title: thread.title,
      updatedAt: thread.updatedAt,
      messageCount: recordsToViews(thread.records).length,
      lastUsage: thread.lastUsage,
      codexUsage: this.threadCodexUsage(thread)
    };
  }

  private detail(thread: RuntimeThread): ThreadDetail {
    return {
      ...this.summary(thread),
      records: thread.records,
      lastSeq: thread.seq
    };
  }

  private workerSummary(worker: RuntimeWorker): WorkerSummary {
    const currentThread = worker.currentThreadId ? this.threads.get(worker.currentThreadId) : undefined;
    const threads = this.workerThreads(worker);
    return {
      workerId: worker.workerId,
      name: worker.name,
      workingDirectory: worker.workingDirectory,
      appServerUrl: worker.appServerUrl,
      online: worker.online,
      status: worker.online ? "online" : "offline",
      lastSeenAt: worker.lastSeenAt,
      offlineSinceAt: worker.offlineSinceAt,
      offlineReason: worker.offlineReason,
      pid: worker.pid,
      hostname: worker.hostname,
      currentThreadId: currentThread?.threadId ?? worker.currentThreadId,
      currentThread: currentThread ? this.summary(currentThread) : undefined,
      threads,
      codexUsage: worker.codexUsage
    };
  }

  private workerThreads(worker: RuntimeWorker): ThreadSummary[] {
    const summaries = [...this.threads.values()]
      .filter((thread) => thread.workerId === worker.workerId)
      .map((thread) => this.summary(thread));
    return summaries.sort((left, right) => {
      if (left.threadId === worker.currentThreadId) return -1;
      if (right.threadId === worker.currentThreadId) return 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  private threadCodexUsage(thread: RuntimeThread) {
    return this.codexUsageByThread.get(thread.threadId)
      ?? (thread.workerId ? this.workers.get(thread.workerId)?.codexUsage : undefined);
  }

  private workerVisibleState(worker: RuntimeWorker) {
    return JSON.stringify({
      workerId: worker.workerId,
      name: worker.name,
      workingDirectory: worker.workingDirectory,
      appServerUrl: worker.appServerUrl,
      online: worker.online,
      status: worker.online ? "online" : "offline",
      offlineSinceAt: worker.offlineSinceAt,
      offlineReason: worker.offlineReason,
      pid: worker.pid,
      hostname: worker.hostname,
      currentThreadId: worker.currentThreadId,
      codexUsage: worker.codexUsage
    });
  }

  private workerSnapshotEvent(): WorkerStreamEvent {
    return {
      seq: this.workerSeq,
      kind: "workers",
      workers: this.listWorkers()
    };
  }

  private publishWorkers() {
    const workers = this.listWorkers();
    const snapshotKey = workerSnapshotKey(workers);
    if (snapshotKey === this.lastWorkerSnapshotKey) return;
    this.lastWorkerSnapshotKey = snapshotKey;
    const event: WorkerStreamEvent = {
      seq: ++this.workerSeq,
      kind: "workers",
      workers
    };
    this.workerEvents.push(event);
    if (this.workerEvents.length > 1000) this.workerEvents.splice(0, this.workerEvents.length - 1000);
    for (const subscriber of this.workerSubscribers) subscriber(event);
  }

  private runtimeSummary(thread: RuntimeThread): ThreadRuntimeSummary {
    const worker = thread.workerId ? this.workers.get(thread.workerId) : null;
    if (worker?.online) return workerRuntimeSummary(worker);
    const replacement = this.uniqueOnlineWorkerForWorkspace(thread.workingDirectory);
    if (replacement) return workerRuntimeSummary(replacement);
    if (worker) return workerRuntimeSummary(worker);
    return { online: false, runnable: false };
  }

  private localCommandMessage(thread: RuntimeThread, command: string) {
    if (command === "status") return threadStatusMessage(thread, this.runtimeSummary(thread));
    if (command === "help") return slashHelpMessage();
    if (command === "model") return modelCommandMessage(thread);
    return [
      `Unsupported slash command: /${command}`,
      "",
      "Official Codex TUI slash commands are local UI commands. The app-server protocol accepts turn requests and setting overrides, but it does not expose a key event for submitting the TUI composer.",
      slashHelpMessage()
    ].join("\n");
  }
}

const workerRuntimeSummary = (worker: RuntimeWorker): ThreadRuntimeSummary => ({
  workerId: worker.workerId,
  name: worker.name,
  appServerUrl: worker.appServerUrl,
  online: worker.online,
  runnable: worker.online,
  lastSeenAt: worker.lastSeenAt
});

const workerSnapshotKey = (workers: WorkerSummary[]) => JSON.stringify(workers.map((worker) => ({
  ...worker,
  lastSeenAt: undefined,
  currentThread: worker.currentThread ? threadSummarySnapshotKey(worker.currentThread) : undefined,
  threads: worker.threads.map(threadSummarySnapshotKey)
})));

const threadSummarySnapshotKey = (thread: ThreadSummary) => ({
  ...thread,
  runtime: {
    ...thread.runtime,
    lastSeenAt: undefined
  }
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

const resultThreadIdFromAppServerMessage = (message: Record<string, unknown>) => {
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  return typeof resultThread?.id === "string" ? resultThread.id : undefined;
};

const appServerThreadFromMessage = (message: Record<string, unknown>) => {
  const params = asRecord(message.params);
  const result = asRecord(message.result);
  return asRecord(result?.thread) ?? asRecord(params?.thread);
};

const rollbackPlanAfterRecord = (thread: RuntimeThread, recordId: string) => {
  const targetTurnId = turnIdFromAppRecordId(thread.threadId, recordId);
  if (!targetTurnId) throw new Error(`Cannot fork from record without app-server turn id: ${recordId}`);
  const turnIds = appServerTurnIds(thread);
  const targetIndex = turnIds.indexOf(targetTurnId);
  if (targetIndex === -1) throw new Error(`Cannot find fork target turn for record: ${recordId}`);
  return {
    rollbackTurns: turnIds.length - targetIndex - 1,
    keepTurns: targetIndex + 1
  };
};

const appServerTurnIds = (thread: RuntimeThread) => {
  const turnIds: string[] = [];
  for (const record of thread.records) {
    const turnId = turnIdFromAppRecordId(thread.threadId, record.id);
    if (turnId && !turnIds.includes(turnId)) turnIds.push(turnId);
  }
  return turnIds;
};

const turnIdFromAppRecordId = (threadId: string, recordId: string) => {
  const prefix = `app:${threadId}:`;
  if (!recordId.startsWith(prefix)) return null;
  const rest = recordId.slice(prefix.length);
  const [turnId, kind] = rest.split(":");
  if (!turnId || !kind) return null;
  return kind === "user" || kind === "agent" || kind === "usage" ? turnId : null;
};

const summarizeInput = (input: ProxyInput) => {
  if (typeof input === "string") return input;
  return input
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
};

const imageUrls = (input: ProxyInput) => {
  if (typeof input === "string") return [];
  return input
    .filter((item) => item.type === "image")
    .map((item) => item.url);
};

const parseLocalSlashCommand = (input: ProxyInput) => {
  if (typeof input !== "string") return null;
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s|$)/.exec(input.trim());
  return match?.[1].toLowerCase() ?? null;
};

const threadStatusMessage = (thread: RuntimeThread, runtime: ThreadRuntimeSummary) => [
  "Codex Hub status",
  `thread: ${thread.threadId}`,
  `folder: ${thread.workingDirectory}`,
  `state: ${thread.running ? "running" : "idle"}`,
  `runtime: ${formatRuntime(runtime)}`,
  `model: ${formatModel(thread.threadOptions)}`,
  `reasoning: ${thread.threadOptions.modelReasoningEffort ?? "auto"}`,
  `records: ${thread.records.length}`,
  `updated: ${thread.updatedAt}`,
  `usage: ${formatUsage(thread.lastUsage)}`
].join("\n");

const modelCommandMessage = (thread: RuntimeThread) => [
  "Model control",
  `current model: ${formatModel(thread.threadOptions)}`,
  `current reasoning: ${thread.threadOptions.modelReasoningEffort ?? "auto"}`,
  "",
  "In Web, use the Runtime selector. The selected model and reasoning are sent with the next Web turn.",
  "In the official TUI, run /model locally; codexhub cannot press Enter inside the TUI composer through app-server."
].join("\n");

const slashHelpMessage = () => [
  "Supported codexhub slash commands:",
  "/status - show this thread runtime status",
  "/model - explain model control for Web and TUI",
  "/help - show supported proxy commands"
].join("\n");

const formatModel = (options: ThreadOptions) => options.model ?? "auto";

const formatRuntime = (runtime: ThreadRuntimeSummary) => {
  const state = runtime.runnable ? "runnable" : runtime.online ? "online" : "offline";
  const worker = runtime.workerId ? ` worker:${runtime.name ?? runtime.workerId.slice(0, 8)}` : "";
  return `${state}${worker}`;
};

const formatUsage = (usage: Usage | undefined) => {
  const record = asRecord(usage);
  if (!record) return "n/a";
  const total = numberValue(record.total_tokens) ?? numberValue(record.totalTokens);
  const input = numberValue(record.input_tokens) ?? numberValue(record.inputTokens);
  const output = numberValue(record.output_tokens) ?? numberValue(record.outputTokens);
  if (total == null && input == null && output == null) return "n/a";
  return [
    total == null ? null : `total=${total}`,
    input == null ? null : `input=${input}`,
    output == null ? null : `output=${output}`
  ].filter(Boolean).join(", ");
};

const numberValue = (value: unknown) => typeof value === "number" ? value : undefined;

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const applyThreadRunOptions = (current: ThreadOptions, options: ThreadRunOptions) => {
  const next = { ...current };
  if (hasOwn(options, "model")) {
    if (options.model) next.model = options.model;
    else delete next.model;
  }
  if (hasOwn(options, "modelReasoningEffort")) {
    if (options.modelReasoningEffort) next.modelReasoningEffort = options.modelReasoningEffort;
    else delete next.modelReasoningEffort;
  }
  return next;
};

const isThreadReasoningEffort = (value: unknown): value is ThreadOptions["modelReasoningEffort"] =>
  value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";

const emptyCodexUsage = (source: CodexUsageSnapshot["source"]): CodexUsageSnapshot => ({
  rateLimits: null,
  tokenUsage: null,
  sourceFile: null,
  observedAt: null,
  source
});

const stringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
