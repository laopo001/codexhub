import { randomUUID } from "node:crypto";
import type { CodexOptions, Input, ThreadOptions } from "@openai/codex-sdk";
import { CodexProxy } from "./codexProxy.js";
import { itemText, type ProxyEvent } from "./events.js";

export type InstanceMessageRole = "user" | "codex" | "event" | "error" | "tool" | "thinking";

export type InstanceMessage = {
  id: string;
  role: InstanceMessageRole;
  label?: string;
  text: string;
  at: string;
  source?: "web" | "telegram" | "codex" | "proxy-runtime";
};

export type InstanceSummary = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  running: boolean;
  attachCount: number;
  title: string;
  updatedAt: string;
  messageCount: number;
};

export type InstanceDetail = InstanceSummary & {
  messages: InstanceMessage[];
  lastSeq: number;
};

export type InstanceStreamEvent = {
  seq: number;
  instanceId: string;
  kind: "instance" | "message" | "event" | "done";
  instance: InstanceSummary;
  message?: InstanceMessage;
  event?: ProxyEvent;
};

type RuntimeInstance = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  running: boolean;
  title: string;
  updatedAt: string;
  messages: InstanceMessage[];
  events: InstanceStreamEvent[];
  subscribers: Set<(event: InstanceStreamEvent) => void>;
  attachments: Set<string>;
  abortController?: AbortController;
  seq: number;
};

export class InstanceHub {
  private readonly proxy: CodexProxy;
  private readonly instances = new Map<string, RuntimeInstance>();

  constructor(codexOptions: CodexOptions = {}, defaultThreadOptions: ThreadOptions = {}) {
    this.proxy = new CodexProxy(codexOptions, defaultThreadOptions);
  }

  createInstance(workingDirectory: string): InstanceDetail {
    const now = new Date().toISOString();
    const instance: RuntimeInstance = {
      instanceId: randomUUID(),
      workingDirectory,
      running: false,
      title: "New thread",
      updatedAt: now,
      messages: [],
      events: [],
      subscribers: new Set(),
      attachments: new Set(),
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

  deleteOrDetach(instanceId: string, clientId?: string) {
    const instance = this.requireInstance(instanceId);
    if (clientId) instance.attachments.delete(clientId);
    const deleted = instance.attachments.size === 0;
    if (deleted) {
      instance.abortController?.abort();
      if (instance.threadId) this.proxy.releaseThread(instance.threadId, { workingDirectory: instance.workingDirectory });
      this.instances.delete(instanceId);
    } else {
      instance.updatedAt = new Date().toISOString();
      this.publish(instance, "instance");
    }
    return { deleted, attachCount: instance.attachments.size };
  }

  async runTurn(instanceId: string, input: Input, source: "web" | "telegram" = "web") {
    const instance = this.requireInstance(instanceId);
    if (instance.running) throw new Error(`Instance is already running: ${instanceId}`);

    const userText = typeof input === "string" ? input : "[structured input]";
    this.appendMessage(instance, {
      role: "user",
      text: userText,
      source
    });
    if (!instance.threadId) instance.title = userText.slice(0, 80) || instance.title;

    instance.running = true;
    instance.abortController = new AbortController();
    this.publish(instance, "instance");

    try {
      for await (const event of this.proxy.runStream({
        input,
        threadId: instance.threadId,
        workingDirectory: instance.workingDirectory,
        skipGitRepoCheck: true,
        signal: instance.abortController.signal
      })) {
        if (event.type === "thread") instance.threadId = event.threadId;
        this.publish(instance, "event", event);

        const message = messageFromProxyEvent(event);
        if (message) this.appendMessage(instance, message);
      }
    } catch (error) {
      if (!instance.abortController.signal.aborted) {
        this.appendMessage(instance, {
          role: "error",
          label: "error",
          text: error instanceof Error ? error.message : String(error),
          source: "proxy-runtime"
        });
      }
    } finally {
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

  private appendMessage(instance: RuntimeInstance, partial: Omit<InstanceMessage, "id" | "at">) {
    const message: InstanceMessage = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...partial
    };
    instance.messages.push(message);
    instance.updatedAt = message.at;
    this.publish(instance, "message", undefined, message);
  }

  private publish(
    instance: RuntimeInstance,
    kind: InstanceStreamEvent["kind"],
    event?: ProxyEvent,
    message?: InstanceMessage
  ) {
    const streamEvent: InstanceStreamEvent = {
      seq: ++instance.seq,
      instanceId: instance.instanceId,
      kind,
      instance: this.summary(instance),
      event,
      message
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
      running: instance.running,
      attachCount: instance.attachments.size,
      title: instance.title,
      updatedAt: instance.updatedAt,
      messageCount: instance.messages.length
    };
  }

  private detail(instance: RuntimeInstance): InstanceDetail {
    return {
      ...this.summary(instance),
      messages: instance.messages,
      lastSeq: instance.seq
    };
  }
}

const messageFromProxyEvent = (event: ProxyEvent): Omit<InstanceMessage, "id" | "at"> | null => {
  if (event.type === "artifact") return { role: "event", label: "artifact", text: event.text, source: "codex" };
  if (event.type === "error") return { role: "error", label: "error", text: event.message, source: "codex" };
  if (event.type !== "item" || event.phase !== "completed") return null;

  const text = itemText(event.item);
  if (!text) return null;

  return {
    role: itemRole(event.item),
    label: itemLabel(event.item),
    text,
    source: "codex"
  };
};

const itemRole = (item: any): InstanceMessageRole => {
  if (item.type === "agent_message") return "codex";
  if (item.type === "reasoning") return "thinking";
  if (item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "web_search") return "tool";
  if (item.type === "error") return "error";
  return "event";
};

const itemLabel = (item: any): string => {
  const state = item.status;
  if (item.type === "command_execution") return state ? `command: ${state}` : "command";
  if (item.type === "mcp_tool_call") return state ? `${item.server}.${item.tool}: ${state}` : `${item.server}.${item.tool}`;
  if (item.type === "web_search") return "web search";
  if (item.type === "reasoning") return "thinking";
  if (item.type === "todo_list") return "plan";
  if (item.type === "file_change") return state ? `file change: ${state}` : "file change";
  if (item.type === "agent_message") return "codex";
  return item.type ?? "event";
};
