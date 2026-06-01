import { randomUUID } from "node:crypto";
import type { CodexOptions, Input, ThreadOptions, Usage } from "@openai/codex-sdk";
import { CodexProxy } from "./codexProxy.js";
import { asRecord, codexRecordFromSession, type CodexRecord } from "./codexRecord.js";
import { recordsToViews } from "./codexRecordView.js";
import { readCodexSessionSnapshot } from "./codexSession.js";
import { readSavedInstances, writeSavedInstances, type SavedInstance } from "./instanceStore.js";
import type { ProxyEvent } from "./events.js";

export type InstanceSummary = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  model?: string;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
  runtime: InstanceRuntimeSummary;
  status: "running" | "idle" | "empty";
  running: boolean;
  attachCount: number;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
  savedAt?: string;
};

export type InstanceRuntimeSummary =
  | { kind: "server" }
  | {
      kind: "worker";
      workerId: string;
      name?: string;
      appServerUrl?: string;
      online: boolean;
      lastSeenAt: string;
    };

export type InstanceDetail = InstanceSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

export type InstanceStreamEvent = {
  seq: number;
  instanceId: string;
  kind: "instance" | "record" | "event" | "done";
  instance: InstanceSummary;
  record?: CodexRecord;
  event?: ProxyEvent;
};

export type WorkerRegistration = {
  workerId?: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  pid?: number;
  hostname?: string;
};

export type WorkerCommand = {
  seq: number;
  commandId: string;
  type: "turn" | "stop";
  instanceId: string;
  workingDirectory: string;
  createdAt: string;
  input?: Input;
  threadId?: string;
  turnId?: string;
  options?: ThreadOptions;
};

export type WorkerEventInput = {
  instanceId: string;
  commandId?: string;
  heartbeat?: boolean;
  message: unknown;
};

type RuntimeInstance = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  appServerTurnId?: string;
  threadOptions: ThreadOptions;
  forkContext?: string;
  runtime: InstanceRuntimeSummary;
  running: boolean;
  title: string;
  updatedAt: string;
  records: CodexRecord[];
  events: InstanceStreamEvent[];
  appServerItems: Map<string, AppServerItemState>;
  subscribers: Set<(event: InstanceStreamEvent) => void>;
  attachments: Set<string>;
  abortController?: AbortController;
  lastUsage?: Usage;
  savedAt?: string;
  seq: number;
};

type WorkerWaiter = () => void;

type AppServerItemState = {
  text?: string;
  phase?: string | null;
};

export class InstanceHub {
  private readonly proxy: CodexProxy;
  private readonly instances = new Map<string, RuntimeInstance>();
  private readonly workerCommands = new Map<string, WorkerCommand[]>();
  private readonly workerWaiters = new Map<string, Set<WorkerWaiter>>();

  constructor(codexOptions: CodexOptions = {}, defaultThreadOptions: ThreadOptions = {}) {
    this.proxy = new CodexProxy(codexOptions, defaultThreadOptions);
  }

  async restoreSavedInstances(): Promise<InstanceSummary[]> {
    const savedInstances = await readSavedInstances();
    for (const saved of savedInstances) {
      if (this.instances.has(saved.instanceId)) {
        const existing = this.instances.get(saved.instanceId)!;
        existing.savedAt = saved.savedAt;
        continue;
      }
      const instance = await this.runtimeFromSaved(saved);
      this.instances.set(instance.instanceId, instance);
      this.publish(instance, "instance");
    }
    return this.listInstances();
  }

  async saveInstances() {
    const savedAt = new Date().toISOString();
    const snapshots = [...this.instances.values()].filter((instance) => instance.runtime.kind === "server").map((instance): SavedInstance => {
      instance.savedAt = savedAt;
      return {
        instanceId: instance.instanceId,
        workingDirectory: instance.workingDirectory,
        threadId: instance.threadId,
        title: instance.title,
        threadOptions: { ...instance.threadOptions },
        updatedAt: instance.updatedAt,
        savedAt
      };
    });
    const result = await writeSavedInstances(snapshots);
    for (const instance of this.instances.values()) this.publish(instance, "instance");
    return {
      path: result.path,
      instances: this.listInstances()
    };
  }

  createInstance(workingDirectory: string, options: ThreadOptions = {}): InstanceDetail {
    const now = new Date().toISOString();
    const instance: RuntimeInstance = {
      instanceId: randomUUID(),
      workingDirectory,
      threadOptions: options,
      runtime: { kind: "server" },
      running: false,
      title: "New thread",
      updatedAt: now,
      records: [],
      events: [],
      appServerItems: new Map(),
      subscribers: new Set(),
      attachments: new Set(),
      seq: 0
    };
    this.instances.set(instance.instanceId, instance);
    this.publish(instance, "instance");
    return this.detail(instance);
  }

  restoreInstance(
    workingDirectory: string,
    threadId: string,
    records: CodexRecord[],
    title = "Restored thread",
    options: ThreadOptions = {}
  ): InstanceDetail {
    const now = new Date().toISOString();
    const instance: RuntimeInstance = {
      instanceId: randomUUID(),
      workingDirectory,
      threadId,
      threadOptions: options,
      runtime: { kind: "server" },
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
    this.instances.set(instance.instanceId, instance);
    this.publish(instance, "instance");
    return this.detail(instance);
  }

  forkInstance(instanceId: string, recordId: string): InstanceDetail {
    const source = this.requireInstance(instanceId);
    const targetIndex = source.records.findIndex((record) => record.id === recordId);
    if (targetIndex === -1) throw new Error(`Record not found: ${recordId}`);

    const now = new Date().toISOString();
    const records = source.records.slice(0, targetIndex + 1).map((record) => ({
      ...record,
      id: `fork:${randomUUID()}:${record.id}`,
      sourceThreadId: record.sourceThreadId ?? source.threadId
    }));
    const instance: RuntimeInstance = {
      instanceId: randomUUID(),
      workingDirectory: source.workingDirectory,
      threadOptions: { ...source.threadOptions },
      forkContext: forkContextFromRecords(records),
      runtime: { kind: "server" },
      running: false,
      title: `Fork: ${source.title}`,
      updatedAt: now,
      records,
      events: [],
      appServerItems: new Map(),
      subscribers: new Set(),
      attachments: new Set(),
      lastUsage: latestUsage(records),
      seq: 0
    };
    this.instances.set(instance.instanceId, instance);
    this.publish(instance, "instance");
    return this.detail(instance);
  }

  registerWorker(registration: WorkerRegistration): { workerId: string; instance: InstanceDetail } {
    const now = new Date().toISOString();
    const workerId = registration.workerId?.trim() || randomUUID();
    const existing = this.workerInstance(workerId);
    this.workerCommands.set(workerId, this.workerCommands.get(workerId) ?? []);

    if (existing) {
      existing.workingDirectory = registration.workingDirectory;
      existing.runtime = workerRuntime(workerId, registration, now);
      existing.updatedAt = now;
      this.publish(existing, "instance");
      return { workerId, instance: this.detail(existing) };
    }

    const instance: RuntimeInstance = {
      instanceId: randomUUID(),
      workingDirectory: registration.workingDirectory,
      threadOptions: {},
      runtime: workerRuntime(workerId, registration, now),
      running: false,
      title: registration.name ? `Worker: ${registration.name}` : "Worker thread",
      updatedAt: now,
      records: [],
      events: [],
      appServerItems: new Map(),
      subscribers: new Set(),
      attachments: new Set(),
      seq: 0
    };
    this.instances.set(instance.instanceId, instance);
    this.publish(instance, "instance");
    return { workerId, instance: this.detail(instance) };
  }

  heartbeatWorker(workerId: string, registration: Partial<WorkerRegistration> = {}) {
    const instance = this.workerInstance(workerId);
    if (!instance || instance.runtime.kind !== "worker") return { ok: false };
    const now = new Date().toISOString();
    instance.runtime = {
      ...instance.runtime,
      name: registration.name ?? instance.runtime.name,
      appServerUrl: registration.appServerUrl ?? instance.runtime.appServerUrl,
      online: true,
      lastSeenAt: now
    };
    instance.updatedAt = now;
    this.publish(instance, "instance");
    return { ok: true, instanceId: instance.instanceId };
  }

  async waitWorkerCommands(workerId: string, after: number, timeoutMs = 25000) {
    if (this.workerCommandsAfter(workerId, after).length === 0) {
      await new Promise<void>((resolve) => {
        const waiters = this.workerWaiters.get(workerId) ?? new Set<WorkerWaiter>();
        let timer: NodeJS.Timeout;
        const waiter = () => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve();
        };
        timer = setTimeout(waiter, timeoutMs);
        waiters.add(waiter);
        this.workerWaiters.set(workerId, waiters);
      });
    }
    const commands = this.workerCommandsAfter(workerId, after);
    return {
      workerId,
      cursor: commands.at(-1)?.seq ?? after,
      commands
    };
  }

  applyWorkerEvent(workerId: string, input: WorkerEventInput) {
    if (input.heartbeat !== false) this.heartbeatWorker(workerId);
    const instance = this.requireInstance(input.instanceId);
    if (instance.runtime.kind !== "worker" || instance.runtime.workerId !== workerId) {
      throw new Error(`Instance ${input.instanceId} is not attached to worker ${workerId}`);
    }
    this.applyAppServerMessage(instance, input.message);
    return { ok: true, instance: this.summary(instance) };
  }

  listInstances(): InstanceSummary[] {
    return [...this.instances.values()].map((instance) => this.summary(instance));
  }

  getInstance(instanceId: string): InstanceDetail | null {
    const instance = this.instances.get(instanceId);
    return instance ? this.detail(instance) : null;
  }

  attach(instanceId: string, clientId: string): InstanceDetail {
    const instance = this.requireInstance(instanceId);
    instance.attachments.add(clientId);
    instance.updatedAt = new Date().toISOString();
    this.publish(instance, "instance");
    return this.detail(instance);
  }

  detach(instanceId: string, clientId: string) {
    const instance = this.requireInstance(instanceId);
    instance.attachments.delete(clientId);
    instance.updatedAt = new Date().toISOString();
    if (instance.attachments.size === 0) {
      instance.abortController?.abort();
      instance.running = false;
      if (instance.threadId) this.proxy.releaseThread(instance.threadId, { workingDirectory: instance.workingDirectory });
    }
    this.publish(instance, "instance");
    return { deleted: false, attachCount: instance.attachments.size };
  }

  async deleteInstance(instanceId: string) {
    const instance = this.requireInstance(instanceId);
    instance.abortController?.abort();
    instance.running = false;
    if (instance.threadId) this.proxy.releaseThread(instance.threadId, { workingDirectory: instance.workingDirectory });
    this.instances.delete(instanceId);
    const saved = (await readSavedInstances()).filter((item) => item.instanceId !== instanceId);
    const result = await writeSavedInstances(saved);
    this.publish(instance, "done");
    return { deleted: true, attachCount: 0, path: result.path };
  }

  stopTurn(instanceId: string) {
    const instance = this.requireInstance(instanceId);
    if (instance.runtime.kind === "worker") {
      if (!instance.running) return { stopped: false };
      this.enqueueWorkerCommand(instance.runtime.workerId, {
        commandId: randomUUID(),
        type: "stop",
        instanceId: instance.instanceId,
        workingDirectory: instance.workingDirectory,
        createdAt: new Date().toISOString(),
        threadId: instance.threadId,
        turnId: instance.appServerTurnId
      });
      return { stopped: true };
    }
    if (!instance.running || !instance.abortController) return { stopped: false };
    instance.abortController.abort();
    return { stopped: true };
  }

  async runTurn(instanceId: string, input: Input, _source: "web" | "telegram" | "task" = "web") {
    const instance = this.requireInstance(instanceId);
    if (instance.running) throw new Error(`Instance is already running: ${instanceId}`);
    if (instance.runtime.kind === "worker") {
      this.enqueueWorkerTurn(instance, input);
      return;
    }

    const userText = summarizeInput(input);
    this.appendUserInputRecord(instance, input);
    if (!instance.threadId) instance.title = userText.slice(0, 80) || instance.title;

    instance.running = true;
    instance.abortController = new AbortController();
    this.publish(instance, "instance");

    const codexInput = prepareForkedInput(input, instance.forkContext);
    instance.forkContext = undefined;

    try {
      for await (const event of this.proxy.runStream({
        input: codexInput,
        threadId: instance.threadId,
        workingDirectory: instance.workingDirectory,
        skipGitRepoCheck: true,
        options: instance.threadOptions,
        signal: instance.abortController.signal
      })) {
        if (event.type === "thread") instance.threadId = event.threadId;
        if (event.type === "final" && event.usage) instance.lastUsage = event.usage;
        this.publish(instance, "event", event);
        await this.syncRecords(instance);
      }
    } catch (error) {
      if (!instance.abortController.signal.aborted) {
        this.appendRuntimeRecord(instance, "error", {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      await this.syncRecords(instance);
      instance.running = false;
      instance.abortController = undefined;
      this.publish(instance, "done");
    }
  }

  subscribe(instanceId: string, after: number, callback: (event: InstanceStreamEvent) => void) {
    const instance = this.requireInstance(instanceId);
    for (const event of instance.events.filter((item) => item.seq > after)) callback(event);
    instance.subscribers.add(callback);
    return () => instance.subscribers.delete(callback);
  }

  private requireInstance(instanceId: string): RuntimeInstance {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance not found: ${instanceId}`);
    return instance;
  }

  private async runtimeFromSaved(saved: SavedInstance): Promise<RuntimeInstance> {
    const records = saved.threadId ? await this.recordsForThread(saved.threadId) : [];
    return {
      instanceId: saved.instanceId,
      workingDirectory: saved.workingDirectory,
      threadId: saved.threadId,
      threadOptions: saved.threadOptions,
      runtime: { kind: "server" },
      running: false,
      title: saved.title,
      updatedAt: records.at(-1)?.timestamp ?? saved.updatedAt,
      records,
      events: [],
      appServerItems: new Map(),
      subscribers: new Set(),
      attachments: new Set(),
      lastUsage: latestUsage(records),
      savedAt: saved.savedAt,
      seq: 0
    };
  }

  private async recordsForThread(threadId: string): Promise<CodexRecord[]> {
    const snapshot = await readCodexSessionSnapshot(threadId);
    return snapshot?.records.map((record) => codexRecordFromSession(record, threadId)) ?? [];
  }

  private workerInstance(workerId: string) {
    return [...this.instances.values()].find((instance) =>
      instance.runtime.kind === "worker" && instance.runtime.workerId === workerId
    );
  }

  private enqueueWorkerTurn(instance: RuntimeInstance, input: Input) {
    if (instance.runtime.kind !== "worker") throw new Error("Instance is not worker-backed");
    const userText = summarizeInput(input);
    this.appendUserInputRecord(instance, input);
    if (!instance.threadId) instance.title = userText.slice(0, 80) || instance.title;
    instance.running = true;
    instance.updatedAt = new Date().toISOString();
    this.publish(instance, "instance");

    const codexInput = prepareForkedInput(input, instance.forkContext);
    instance.forkContext = undefined;
    this.enqueueWorkerCommand(instance.runtime.workerId, {
      commandId: randomUUID(),
      type: "turn",
      instanceId: instance.instanceId,
      workingDirectory: instance.workingDirectory,
      createdAt: new Date().toISOString(),
      input: codexInput,
      threadId: instance.threadId,
      options: { ...instance.threadOptions }
    });
  }

  private enqueueWorkerCommand(workerId: string, command: Omit<WorkerCommand, "seq">) {
    const commands = this.workerCommands.get(workerId) ?? [];
    const next: WorkerCommand = {
      ...command,
      seq: (commands.at(-1)?.seq ?? 0) + 1
    };
    commands.push(next);
    if (commands.length > 500) commands.splice(0, commands.length - 500);
    this.workerCommands.set(workerId, commands);
    const waiters = this.workerWaiters.get(workerId);
    if (waiters) {
      for (const waiter of [...waiters]) waiter();
    }
    return next;
  }

  private workerCommandsAfter(workerId: string, after: number) {
    return (this.workerCommands.get(workerId) ?? []).filter((command) => command.seq > after);
  }

  private async syncRecords(instance: RuntimeInstance) {
    if (!instance.threadId) return;
    const snapshot = await readCodexSessionSnapshot(instance.threadId);
    if (!snapshot) return;
    const existing = new Set(instance.records.map((record) => record.id));
    for (const sessionRecord of snapshot.records) {
      const record = codexRecordFromSession(sessionRecord, instance.threadId);
      if (existing.has(record.id)) continue;
      this.removeOptimisticUserRecord(instance, record);
      instance.records.push(record);
      instance.updatedAt = record.timestamp ?? new Date().toISOString();
      this.publish(instance, "record", undefined, record);
    }
    instance.lastUsage = latestUsage(instance.records);
  }

  private appendRuntimeRecord(instance: RuntimeInstance, type: string, payload: unknown) {
    const record: CodexRecord = {
      id: `proxy:${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type,
      payload,
      sourceThreadId: instance.threadId
    };
    instance.records.push(record);
    instance.updatedAt = record.timestamp ?? instance.updatedAt;
    this.publish(instance, "record", undefined, record);
  }

  private appendUserInputRecord(instance: RuntimeInstance, input: Input) {
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
      sourceThreadId: instance.threadId
    };
    instance.records.push(record);
    instance.updatedAt = record.timestamp ?? instance.updatedAt;
    this.publish(instance, "record", undefined, record);
  }

  private removeOptimisticUserRecord(instance: RuntimeInstance, incoming: CodexRecord) {
    const incomingPayload = asRecord(incoming.payload);
    if (incoming.type !== "event_msg" || incomingPayload?.type !== "user_message") return;
    const index = instance.records.findIndex((record) => {
      if (!record.id.startsWith("proxy:user:")) return false;
      const payload = asRecord(record.payload);
      return payload?.type === "user_message"
        && payload.message === incomingPayload.message
        && JSON.stringify(payload.local_images ?? []) === JSON.stringify(incomingPayload.local_images ?? []);
    });
    if (index !== -1) instance.records.splice(index, 1);
  }

  private upsertRecord(instance: RuntimeInstance, record: CodexRecord) {
    const existingIndex = instance.records.findIndex((item) => item.id === record.id);
    if (existingIndex === -1) {
      this.removeOptimisticUserRecord(instance, record);
      instance.records.push(record);
    } else {
      if (recordsEqual(instance.records[existingIndex], record)) return;
      instance.records[existingIndex] = record;
    }
    instance.updatedAt = record.timestamp ?? new Date().toISOString();
    instance.lastUsage = latestUsage(instance.records);
    this.publish(instance, "record", undefined, record);
  }

  private applyAppServerMessage(instance: RuntimeInstance, message: unknown) {
    const record = asRecord(message);
    if (!record) return;

    const result = asRecord(record.result);
    const resultThread = asRecord(result?.thread);
    const resultTurn = asRecord(result?.turn);
    if (resultThread) {
      this.applyAppServerThread(instance, resultThread);
      this.applyAppServerThreadTurns(instance, resultThread);
    }
    if (resultTurn) this.applyAppServerTurn(instance, resultTurn);

    if (asRecord(record.error)) {
      this.appendRuntimeRecord(instance, "error", {
        type: "app_server_error",
        message: stringify(asRecord(record.error))
      });
      this.finishWorkerTurn(instance);
      return;
    }

    const method = typeof record.method === "string" ? record.method : "";
    const params = asRecord(record.params);
    if (!method || !params) return;

    if (method === "thread/started") {
      const thread = asRecord(params.thread);
      if (thread) this.applyAppServerThread(instance, thread);
      return;
    }

    if (method === "thread/status/changed") {
      const status = asRecord(params.status);
      if (status?.type === "active") {
        instance.running = true;
        this.publish(instance, "instance");
      }
      return;
    }

    if (method === "turn/started") {
      const turn = asRecord(params.turn);
      if (turn) this.applyAppServerTurn(instance, turn);
      instance.running = true;
      this.publish(instance, "instance");
      return;
    }

    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (turn) this.applyAppServerTurn(instance, turn);
      this.finishWorkerTurn(instance);
      return;
    }

    if (method === "error") {
      const error = asRecord(params.error);
      this.appendRuntimeRecord(instance, "error", {
        type: "app_server_error",
        message: typeof error?.message === "string" ? error.message : stringify(params)
      });
      this.finishWorkerTurn(instance);
      return;
    }

    if (method === "item/agentMessage/delta") {
      this.applyAgentMessageDelta(instance, params);
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = asRecord(params.item);
      if (item) this.applyAppServerItem(instance, item, method === "item/completed", params);
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      this.upsertRecord(instance, tokenUsageRecord(params));
    }
  }

  private applyAppServerThread(instance: RuntimeInstance, thread: Record<string, unknown>) {
    let changed = false;
    if (typeof thread.id === "string" && instance.threadId !== thread.id) {
      instance.threadId = thread.id;
      changed = true;
    }
    if (typeof thread.preview === "string" && thread.preview.trim()) {
      const title = thread.preview.slice(0, 80);
      if (instance.title !== title) {
        instance.title = title;
        changed = true;
      }
    }
    if (typeof thread.cwd === "string" && instance.workingDirectory !== thread.cwd) {
      instance.workingDirectory = thread.cwd;
      changed = true;
    }
    const status = asRecord(thread.status);
    if (status?.type === "active" && !instance.running) {
      instance.running = true;
      changed = true;
    }
    if (status?.type === "idle" && (instance.running || instance.appServerTurnId)) {
      instance.running = false;
      instance.appServerTurnId = undefined;
      changed = true;
    }
    if (!changed) return;
    instance.updatedAt = new Date().toISOString();
    this.publish(instance, "instance");
  }

  private applyAppServerThreadTurns(instance: RuntimeInstance, thread: Record<string, unknown>) {
    if (!Array.isArray(thread.turns)) return;
    const threadId = typeof thread.id === "string" ? thread.id : instance.threadId;
    for (const turnValue of thread.turns) {
      const turn = asRecord(turnValue);
      if (!turn) continue;
      this.applyAppServerTurn(instance, turn);
      const params = appServerTurnParams(threadId, turn);
      const items = Array.isArray(turn.items) ? turn.items : [];
      for (const itemValue of items) {
        const item = asRecord(itemValue);
        if (item) this.applyAppServerItem(instance, item, true, params);
      }
    }
  }

  private applyAppServerTurn(instance: RuntimeInstance, turn: Record<string, unknown>) {
    if (typeof turn.id === "string" && typeof turn.completedAt !== "number") instance.appServerTurnId = turn.id;
  }

  private applyAgentMessageDelta(instance: RuntimeInstance, params: Record<string, unknown>) {
    if (typeof params.itemId !== "string") return;
    const state = instance.appServerItems.get(params.itemId) ?? {};
    state.text = `${state.text ?? ""}${typeof params.delta === "string" ? params.delta : ""}`;
    instance.appServerItems.set(params.itemId, state);
    this.upsertRecord(instance, appServerAgentMessageRecord(params.itemId, state, params));
  }

  private applyAppServerItem(
    instance: RuntimeInstance,
    item: Record<string, unknown>,
    completed: boolean,
    params: Record<string, unknown>
  ) {
    const itemId = typeof item.id === "string" ? item.id : randomUUID();
    switch (item.type) {
      case "userMessage":
        this.applyAppServerUserMessage(instance, itemId, item, params);
        return;
      case "agentMessage": {
        const state = instance.appServerItems.get(itemId) ?? {};
        state.text = typeof item.text === "string" ? item.text : state.text ?? "";
        state.phase = typeof item.phase === "string" ? item.phase : state.phase ?? "assistant";
        instance.appServerItems.set(itemId, state);
        this.upsertRecord(instance, appServerAgentMessageRecord(itemId, state, params));
        return;
      }
      case "reasoning":
      case "plan":
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "webSearch":
      case "imageGeneration":
        this.upsertRecord(instance, appServerItemRecord(itemId, item, params, completed));
        return;
      default:
        return;
    }
  }

  private applyAppServerUserMessage(
    instance: RuntimeInstance,
    itemId: string,
    item: Record<string, unknown>,
    params: Record<string, unknown>
  ) {
    const record = appServerUserRecord(itemId, item, params);
    const payload = asRecord(record.payload);
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (message && (instance.title === "Worker thread" || instance.title.startsWith("Worker: "))) {
      instance.title = message.slice(0, 80);
    }
    this.upsertRecord(instance, record);
  }

  private finishWorkerTurn(instance: RuntimeInstance) {
    const wasRunning = instance.running;
    instance.running = false;
    instance.appServerTurnId = undefined;
    instance.updatedAt = new Date().toISOString();
    this.publish(instance, wasRunning ? "done" : "instance");
  }

  private publish(
    instance: RuntimeInstance,
    kind: InstanceStreamEvent["kind"],
    event?: ProxyEvent,
    record?: CodexRecord
  ) {
    const streamEvent: InstanceStreamEvent = {
      seq: ++instance.seq,
      instanceId: instance.instanceId,
      kind,
      instance: this.summary(instance),
      event,
      record
    };
    instance.events.push(streamEvent);
    if (instance.events.length > 1000) instance.events.splice(0, instance.events.length - 1000);
    for (const subscriber of instance.subscribers) subscriber(streamEvent);
  }

  private summary(instance: RuntimeInstance): InstanceSummary {
    return {
      instanceId: instance.instanceId,
      workingDirectory: instance.workingDirectory,
      threadId: instance.threadId,
      model: instance.threadOptions.model,
      modelReasoningEffort: instance.threadOptions.modelReasoningEffort,
      runtime: instance.runtime,
      status: instanceStatus(instance),
      running: instance.running,
      attachCount: instance.attachments.size,
      title: instance.title,
      updatedAt: instance.updatedAt,
      messageCount: recordsToViews(instance.records).length,
      lastUsage: instance.lastUsage,
      savedAt: instance.savedAt
    };
  }

  private detail(instance: RuntimeInstance): InstanceDetail {
    return {
      ...this.summary(instance),
      records: instance.records,
      lastSeq: instance.seq
    };
  }
}

const instanceStatus = (instance: RuntimeInstance): InstanceSummary["status"] => {
  if (instance.running) return "running";
  return instance.threadId ? "idle" : "empty";
};

const summarizeInput = (input: Input) => {
  if (typeof input === "string") return input;
  const text = input
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
  return text || "[image]";
};

const imagePaths = (input: Input) => {
  if (typeof input === "string") return [];
  return input
    .filter((item) => item.type === "local_image")
    .map((item) => item.path);
};

const prepareForkedInput = (input: Input, forkContext?: string): Input => {
  if (!forkContext) return input;
  const context = [
    "This is a forked Codex conversation. Continue from the prior context below, but treat this as a new independent thread.",
    "",
    forkContext,
    "",
    "New user message:"
  ].join("\n");

  if (typeof input === "string") return `${context}\n${input}`;
  return [
    { type: "text", text: context },
    ...input
  ];
};

const forkContextFromRecords = (records: CodexRecord[]) => [
  "Forked conversation history:",
  ...recordsToViews(records).map((view) => {
    const parts = [
      `${view.role.toUpperCase()}${view.at ? ` (${view.at})` : ""}:`,
      view.text.trim() || "[empty]",
      view.attachments?.length
        ? view.attachments.map((attachment) => `[image: ${attachment.path}]`).join("\n")
        : null
    ];
    return parts.filter(Boolean).join("\n");
  })
].join("\n\n");

const latestUsage = (records: CodexRecord[]) => {
  const views = recordsToViews(records);
  for (let i = views.length - 1; i >= 0; i -= 1) {
    if (views[i].usage) return views[i].usage;
  }
  return undefined;
};

const recordsEqual = (left: CodexRecord, right: CodexRecord) =>
  JSON.stringify(left) === JSON.stringify(right);

const workerRuntime = (
  workerId: string,
  registration: WorkerRegistration,
  lastSeenAt: string
): InstanceRuntimeSummary => ({
  kind: "worker",
  workerId,
  name: registration.name,
  appServerUrl: registration.appServerUrl,
  online: true,
  lastSeenAt
});

const appServerUserRecord = (
  itemId: string,
  item: Record<string, unknown>,
  params: Record<string, unknown>
): CodexRecord => {
  const content = Array.isArray(item.content) ? item.content : [];
  return {
    id: `app:${threadIdFromParams(params)}:${itemId}`,
    timestamp: timestampFromParams(params, "startedAtMs") ?? new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "user_message",
      message: userInputText(content),
      images: [],
      local_images: userInputLocalImages(content),
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
  id: `app:${threadIdFromParams(params)}:${itemId}`,
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

const numberField = (record: Record<string, unknown> | null, key: string) =>
  typeof record?.[key] === "number" ? record[key] : 0;

const stringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
