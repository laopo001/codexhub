import type { OpenThreadPresence, RealtimeMessage, RealtimeOutgoingMessage } from "./apiContract.js";
import { asRecord } from "./recordTypes.js";
import type { ThreadStreamEvent } from "./threadTypes.js";

export type RealtimeControlCursors = {
  runtimesAfter?: number;
  projectsAfter?: number;
  tasksAfter?: number;
  connectionsAfter?: number;
};

export type CodexHubRealtimeClientOptions = {
  url: string | (() => string);
  cursors?: RealtimeControlCursors;
  reconnectDelayMs?: number | null;
  webSocketFactory?: (url: string) => WebSocket;
  onMessage: (message: RealtimeMessage) => void | Promise<void>;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

const realtimeMessageTypes = new Set([
  "open_threads",
  "runtimes",
  "projects",
  "tasks",
  "connections",
  "thread",
  "record",
  "record_delta",
  "done",
  "ready",
  "thread_subscribed",
  "thread_unsubscribed",
  "error"
]);

export const parseRealtimeMessage = (data: unknown): RealtimeMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const type = typeof record?.type === "string"
    ? record.type
    : typeof record?.kind === "string" ? record.kind : "";
  if (!realtimeMessageTypes.has(type)) return null;
  return { ...record, type } as RealtimeMessage;
};

export const codexHubRealtimeUrl = (baseUrl: string, authToken?: string | null) => {
  const url = new URL("/api/events/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = authToken?.trim();
  if (token) url.searchParams.set("codexhub_token", token);
  return url.toString();
};

const maxCursor = (current: number | undefined, incoming: number | undefined) =>
  Math.max(current ?? 0, incoming ?? 0);
export const threadCursorAfterEvent = (
  current: number | undefined,
  event: Pick<ThreadStreamEvent, "seq" | "snapshot">
) => {
  if (!event.snapshot) return maxCursor(current, event.seq);
  // 所有 snapshot 页共享一个 barrier seq；最后一页到达前保持旧 cursor，
  // 让中途断线的重连必然重新请求完整 canonical snapshot。
  return event.snapshot.complete ? event.seq : current ?? 0;
};
const webSocketOpenState = 1;
const threadDeltaBatchWindowMs = 16;

export class CodexHubRealtimeClient {
  private openThreads: OpenThreadPresence[] = [];
  private supportsOpenThreadPresence = false;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly subscriptions = new Map<string, number>();
  private readonly cursors: Required<RealtimeControlCursors>;
  private bufferedThreadDeltas: RealtimeMessage[] = [];
  private bufferedThreadDeltaTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CodexHubRealtimeClientOptions) {
    this.cursors = {
      runtimesAfter: options.cursors?.runtimesAfter ?? 0,
      projectsAfter: options.cursors?.projectsAfter ?? 0,
      tasksAfter: options.cursors?.tasksAfter ?? 0,
      connectionsAfter: options.cursors?.connectionsAfter ?? 0
    };
  }

  connect() {
    this.stopped = false;
    this.clearReconnectTimer();
    this.openSocket();
  }

  disconnect() {
    this.stopped = true;
    this.clearReconnectTimer();
    this.flushBufferedThreadDeltas();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  send(message: RealtimeOutgoingMessage) {
    if (message.type === "hello") this.rememberHello(message);
    if (message.type === "subscribe_thread") {
      this.subscriptions.set(message.threadId, maxCursor(this.subscriptions.get(message.threadId), message.after));
    }
    if (message.type === "unsubscribe_thread") this.subscriptions.delete(message.threadId);
    return this.sendRaw(message);
  }

  setOpenThreads(threads: OpenThreadPresence[]) {
    this.openThreads = threads;
    if (this.supportsOpenThreadPresence) this.sendRaw({ type: "set_open_threads", threads });
  }

  subscribeThread(threadId: string, after = 0) {
    return this.send({ type: "subscribe_thread", threadId, after });
  }

  unsubscribeThread(threadId: string) {
    return this.send({ type: "unsubscribe_thread", threadId });
  }

  private openSocket() {
    if (this.stopped) return;
    this.supportsOpenThreadPresence = false;
    const previous = this.socket;
    this.socket = null;
    this.flushBufferedThreadDeltas();
    previous?.close();

    const url = typeof this.options.url === "function" ? this.options.url() : this.options.url;
    const socket = (this.options.webSocketFactory ?? ((value) => new WebSocket(value)))(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopped) return;
      this.sendRaw({ type: "hello", ...this.cursors });
      for (const [threadId, after] of this.subscriptions) {
        this.sendRaw({ type: "subscribe_thread", threadId, after });
      }
      this.options.onOpen?.();
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopped) return;
      const message = parseRealtimeMessage(event.data);
      if (!message) return;
      this.rememberIncoming(message);
      if (message.type === "record_delta") {
        this.bufferedThreadDeltas.push(message);
        this.scheduleThreadDeltaFlush();
        return;
      }
      this.flushBufferedThreadDeltas();
      this.deliverMessage(message);
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) socket.close();
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.flushBufferedThreadDeltas();
      this.options.onClose?.();
      this.scheduleReconnect();
    });
  }

  private sendRaw(message: RealtimeOutgoingMessage) {
    const socket = this.socket;
    if (!socket || socket.readyState !== webSocketOpenState) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private rememberHello(message: Extract<RealtimeOutgoingMessage, { type: "hello" }>) {
    this.cursors.runtimesAfter = maxCursor(this.cursors.runtimesAfter, message.runtimesAfter);
    this.cursors.projectsAfter = maxCursor(this.cursors.projectsAfter, message.projectsAfter);
    this.cursors.tasksAfter = maxCursor(this.cursors.tasksAfter, message.tasksAfter);
    this.cursors.connectionsAfter = maxCursor(this.cursors.connectionsAfter, message.connectionsAfter);
  }

  private rememberIncoming(message: RealtimeMessage) {
    if (message.type === "ready" && message.openThreadPresence) {
      this.supportsOpenThreadPresence = true;
      this.sendRaw({ type: "set_open_threads", threads: this.openThreads });
    }
    if (message.type === "runtimes") this.cursors.runtimesAfter = maxCursor(this.cursors.runtimesAfter, message.seq);
    if (message.type === "projects") this.cursors.projectsAfter = maxCursor(this.cursors.projectsAfter, message.seq);
    if (message.type === "tasks") this.cursors.tasksAfter = maxCursor(this.cursors.tasksAfter, message.seq);
    if (message.type === "connections") this.cursors.connectionsAfter = maxCursor(this.cursors.connectionsAfter, message.seq);
    if (
      message.type === "thread"
      || message.type === "record"
      || message.type === "record_delta"
      || message.type === "done"
    ) {
      const threadId = message.thread.threadId;
      if (this.subscriptions.has(threadId)) {
        this.subscriptions.set(threadId, threadCursorAfterEvent(this.subscriptions.get(threadId), message));
      }
    }
  }

  private scheduleReconnect() {
    const delay = this.options.reconnectDelayMs === undefined ? 1000 : this.options.reconnectDelayMs;
    if (this.stopped || delay === null || delay < 0) return;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleThreadDeltaFlush() {
    if (this.bufferedThreadDeltaTimer !== null) return;
    this.bufferedThreadDeltaTimer = setTimeout(() => {
      this.bufferedThreadDeltaTimer = null;
      this.flushBufferedThreadDeltas();
    }, threadDeltaBatchWindowMs);
  }

  private flushBufferedThreadDeltas() {
    if (this.bufferedThreadDeltaTimer !== null) {
      clearTimeout(this.bufferedThreadDeltaTimer);
      this.bufferedThreadDeltaTimer = null;
    }
    const messages = this.bufferedThreadDeltas;
    this.bufferedThreadDeltas = [];
    for (const message of messages) this.deliverMessage(message);
  }

  private deliverMessage(message: RealtimeMessage) {
    void Promise.resolve(this.options.onMessage(message)).catch((error) => this.options.onError?.(error));
  }
}
