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
  status: "running" | "idle" | "empty";
  running: boolean;
  attachCount: number;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
  savedAt?: string;
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

type RuntimeInstance = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  threadOptions: ThreadOptions;
  forkContext?: string;
  running: boolean;
  title: string;
  updatedAt: string;
  records: CodexRecord[];
  events: InstanceStreamEvent[];
  subscribers: Set<(event: InstanceStreamEvent) => void>;
  attachments: Set<string>;
  abortController?: AbortController;
  lastUsage?: Usage;
  savedAt?: string;
  seq: number;
};

export class InstanceHub {
  private readonly proxy: CodexProxy;
  private readonly instances = new Map<string, RuntimeInstance>();

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
    const snapshots = [...this.instances.values()].map((instance): SavedInstance => {
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
      running: false,
      title: "New thread",
      updatedAt: now,
      records: [],
      events: [],
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
      running: false,
      title,
      updatedAt: records.at(-1)?.timestamp ?? now,
      records,
      events: [],
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
      running: false,
      title: `Fork: ${source.title}`,
      updatedAt: now,
      records,
      events: [],
      subscribers: new Set(),
      attachments: new Set(),
      lastUsage: latestUsage(records),
      seq: 0
    };
    this.instances.set(instance.instanceId, instance);
    this.publish(instance, "instance");
    return this.detail(instance);
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
    if (!instance.running || !instance.abortController) return { stopped: false };
    instance.abortController.abort();
    return { stopped: true };
  }

  async runTurn(instanceId: string, input: Input, _source: "web" | "telegram" | "task" = "web") {
    const instance = this.requireInstance(instanceId);
    if (instance.running) throw new Error(`Instance is already running: ${instanceId}`);

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
      running: false,
      title: saved.title,
      updatedAt: records.at(-1)?.timestamp ?? saved.updatedAt,
      records,
      events: [],
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
