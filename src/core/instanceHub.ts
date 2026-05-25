import { randomUUID } from "node:crypto";
import type { CodexOptions, Input, ThreadOptions, Usage } from "@openai/codex-sdk";
import { CodexProxy } from "./codexProxy.js";
import { itemText, type ProxyEvent } from "./events.js";

export type InstanceMessageRole = "user" | "codex" | "assistant" | "event" | "error" | "tool" | "thinking";

export type InstanceMessage = {
  id: string;
  role: InstanceMessageRole;
  label?: string;
  text: string;
  attachments?: Array<{ type: "image"; path: string }>;
  at: string;
  source?: "web" | "telegram" | "codex" | "proxy-runtime";
  status?: "pending" | "completed" | "failed";
  itemType?: string;
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
  lastUsage?: Usage;
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
  lastUsage?: Usage;
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

  restoreInstance(
    workingDirectory: string,
    threadId: string,
    messages: Array<Omit<InstanceMessage, "id" | "at"> & { id?: string; at?: string }>,
    title = "Restored thread"
  ): InstanceDetail {
    const now = new Date().toISOString();
    const instanceMessages = messages.map((message) => ({
      ...message,
      id: message.id ?? randomUUID(),
      at: message.at ?? now,
      role: message.role === "assistant" ? "codex" : message.role
    } satisfies InstanceMessage));
    const instance: RuntimeInstance = {
      instanceId: randomUUID(),
      workingDirectory,
      threadId,
      running: false,
      title,
      updatedAt: instanceMessages.at(-1)?.at ?? now,
      messages: instanceMessages,
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
      instance.running = false;
      instance.updatedAt = new Date().toISOString();
      this.publish(instance, "done");
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

    const userText = summarizeInput(input);
    this.appendMessage(instance, {
      role: "user",
      text: userText,
      attachments: imageAttachments(input),
      source
    });
    if (!instance.threadId) instance.title = userText.slice(0, 80) || instance.title;

    instance.running = true;
    instance.abortController = new AbortController();
    const turnId = randomUUID();
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
        if (event.type === "final" && event.usage) instance.lastUsage = event.usage;
        this.publish(instance, "event", event);

        const message = messageFromProxyEvent(event, turnId);
        if (message) this.upsertMessage(instance, message);
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

  private upsertMessage(instance: RuntimeInstance, partial: Omit<InstanceMessage, "at">) {
    const now = new Date().toISOString();
    const existingIndex = instance.messages.findIndex((message) => message.id === partial.id);
    const message: InstanceMessage = existingIndex === -1
      ? { at: now, ...partial }
      : { ...instance.messages[existingIndex], ...partial, at: now };

    if (existingIndex === -1) {
      instance.messages.push(message);
    } else {
      instance.messages[existingIndex] = message;
    }

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
      messageCount: instance.messages.length,
      lastUsage: instance.lastUsage
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

const messageFromProxyEvent = (event: ProxyEvent, turnId: string): Omit<InstanceMessage, "at"> | null => {
  if (event.type === "artifact") {
    return { id: randomUUID(), role: "event", label: "artifact", text: event.text, source: "codex" };
  }
  if (event.type === "error") {
    return { id: randomUUID(), role: "error", label: "error", text: event.message, source: "codex", status: "failed" };
  }
  if (event.type !== "item") return null;
  if (isToolItem(event.item)) return toolMessageFromItem(event.item, event.phase, turnId);
  if (event.phase !== "completed") return null;

  const text = itemText(event.item);
  if (!text) return null;

  return {
    id: `item:${turnId}:${event.item.id}`,
    role: itemRole(event.item),
    label: itemLabel(event.item),
    text,
    source: "codex",
    itemType: event.item.type
  };
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

const imageAttachments = (input: Input): InstanceMessage["attachments"] | undefined => {
  if (typeof input === "string") return undefined;
  const images = input
    .filter((item) => item.type === "local_image")
    .map((item) => ({ type: "image" as const, path: item.path }));
  return images.length ? images : undefined;
};

const isToolItem = (item: any) =>
  item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "web_search";

const toolMessageFromItem = (
  item: any,
  phase: "started" | "updated" | "completed",
  turnId: string
): Omit<InstanceMessage, "at"> => {
  const status = toolStatus(item, phase);
  return {
    id: `item:${turnId}:${item.id}`,
    role: "tool",
    label: toolLabel(item),
    text: toolText(item, status),
    source: "codex",
    status,
    itemType: item.type
  };
};

const toolStatus = (item: any, phase: "started" | "updated" | "completed"): InstanceMessage["status"] => {
  if (item.status === "failed") return "failed";
  if (item.status === "completed" || phase === "completed") return "completed";
  return "pending";
};

const toolLabel = (item: any): string => {
  if (item.type === "command_execution") return "tool call: command";
  if (item.type === "mcp_tool_call") return `tool call: ${item.server}.${item.tool}`;
  if (item.type === "web_search") return "tool call: web search";
  return `tool call: ${item.type ?? "unknown"}`;
};

const toolText = (item: any, status: InstanceMessage["status"]): string => {
  if (item.type === "command_execution") return commandToolText(item, status);
  if (item.type === "mcp_tool_call") return mcpToolText(item, status);
  if (item.type === "web_search") {
    return [
      "Call",
      `web search: ${item.query}`,
      "",
      status === "pending" ? "Waiting for result..." : statusText(status)
    ].join("\n");
  }
  return status === "pending" ? "Waiting for result..." : statusText(status);
};

const commandToolText = (item: any, status: InstanceMessage["status"]) => [
  "Call",
  `$ ${item.command}`,
  "",
  status === "pending" ? "Waiting for command result..." : `Result: ${statusText(status)}`,
  typeof item.exit_code === "number" ? `Exit code: ${item.exit_code}` : null,
  item.aggregated_output ? ["", "Output", item.aggregated_output].join("\n") : null
].filter(Boolean).join("\n");

const mcpToolText = (item: any, status: InstanceMessage["status"]) => [
  "Call",
  `${item.server}.${item.tool}`,
  "",
  "Arguments",
  stringifyUnknown(item.arguments),
  "",
  status === "pending" ? "Waiting for tool result..." : `Result: ${statusText(status)}`,
  mcpResultText(item)
].filter(Boolean).join("\n");

const mcpResultText = (item: any): string | null => {
  if (item.error) return item.error.message;

  const content = item.result?.content
    ?.map((block: unknown) => contentBlockText(block))
    .filter((text: string | null): text is string => Boolean(text))
    .join("\n");
  if (content) return content;

  if (item.result?.structured_content != null) return stringifyUnknown(item.result.structured_content);
  return null;
};

const contentBlockText = (block: unknown): string | null => {
  if (!block || typeof block !== "object") return null;
  const record = block as Record<string, unknown>;

  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (record.type === "image") return "[image result]";
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;

  return null;
};

const statusText = (status: InstanceMessage["status"]) => {
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "waiting";
};

const stringifyUnknown = (value: unknown) => {
  if (value == null) return "{}";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
