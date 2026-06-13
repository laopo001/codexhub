type TunnelSend = (frame: AppServerTunnelFrame) => void;

export type AppServerTunnelFrame =
  | { type: "app_server_tunnel_open"; streamId: string; appServerId: string }
  | { type: "app_server_tunnel_opened"; streamId: string }
  | { type: "app_server_tunnel_message"; streamId: string; data: string }
  | { type: "app_server_tunnel_close"; streamId: string; reason?: string }
  | { type: "app_server_tunnel_error"; streamId: string; message: string };

export type AppServerSocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: "message" | "error" | "close", listener: (event: { data?: unknown }) => void, options?: { once?: boolean }) => void;
};

type PendingStream = {
  socket: VirtualAppServerSocket;
  resolve: (socket: AppServerSocketLike) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type IncomingStream = {
  streamId: string;
  appServerId: string;
  socket: WebSocket;
};

export class AppServerTunnelPeer {
  private readonly targets = new Map<string, string>();
  private readonly pending = new Map<string, PendingStream>();
  private readonly virtualStreams = new Map<string, VirtualAppServerSocket>();
  private readonly incomingStreams = new Map<string, IncomingStream>();

  constructor(private readonly options: {
    send: TunnelSend;
    label?: string;
  }) {}

  registerTarget(appServerId: string, appServerUrl: string) {
    this.targets.set(appServerId, appServerUrl);
  }

  unregisterTarget(appServerId: string) {
    this.targets.delete(appServerId);
    for (const stream of [...this.incomingStreams.values()]) {
      if (stream.appServerId !== appServerId) continue;
      stream.socket.close();
      this.incomingStreams.delete(stream.streamId);
    }
  }

  async openStream(appServerId: string, timeoutMs = 10_000): Promise<AppServerSocketLike> {
    const streamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const socket = new VirtualAppServerSocket({
      streamId,
      send: (frame) => this.send(frame),
      onClose: () => {
        this.virtualStreams.delete(streamId);
        const pending = this.pending.get(streamId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(streamId);
          pending.reject(new Error(`App-server tunnel stream closed before open: ${appServerId}`));
        }
      }
    });
    this.virtualStreams.set(streamId, socket);
    const promise = new Promise<AppServerSocketLike>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(streamId);
        socket.markError(`App-server tunnel stream open timed out: ${appServerId}`);
        reject(new Error(`App-server tunnel stream open timed out: ${appServerId}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(streamId, { socket, resolve, reject, timer });
    });
    this.send({ type: "app_server_tunnel_open", streamId, appServerId });
    return await promise;
  }

  handleFrame(frame: AppServerTunnelFrame) {
    if (frame.type === "app_server_tunnel_open") {
      void this.openIncoming(frame.streamId, frame.appServerId);
      return true;
    }
    if (frame.type === "app_server_tunnel_opened") {
      const pending = this.pending.get(frame.streamId);
      if (!pending) return true;
      clearTimeout(pending.timer);
      this.pending.delete(frame.streamId);
      pending.socket.markOpen();
      pending.resolve(pending.socket);
      return true;
    }
    if (frame.type === "app_server_tunnel_message") {
      const virtual = this.virtualStreams.get(frame.streamId);
      if (virtual) {
        virtual.receiveMessage(frame.data);
        return true;
      }
      const incoming = this.incomingStreams.get(frame.streamId);
      if (incoming?.socket.readyState === WebSocket.OPEN) incoming.socket.send(frame.data);
      return true;
    }
    if (frame.type === "app_server_tunnel_error") {
      const pending = this.pending.get(frame.streamId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.streamId);
        pending.reject(new Error(frame.message));
      }
      this.virtualStreams.get(frame.streamId)?.markError(frame.message);
      this.closeIncoming(frame.streamId, frame.message);
      return true;
    }
    this.virtualStreams.get(frame.streamId)?.markRemoteClosed(frame.reason);
    this.closeIncoming(frame.streamId, frame.reason);
    return true;
  }

  closeAll() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("App-server tunnel closed"));
    }
    this.pending.clear();
    for (const socket of [...this.virtualStreams.values()]) socket.markRemoteClosed("tunnel closed");
    this.virtualStreams.clear();
    for (const stream of [...this.incomingStreams.values()]) stream.socket.close();
    this.incomingStreams.clear();
  }

  private async openIncoming(streamId: string, appServerId: string) {
    const appServerUrl = this.targets.get(appServerId);
    if (!appServerUrl) {
      this.send({ type: "app_server_tunnel_error", streamId, message: `Unknown app-server target: ${appServerId}` });
      return;
    }
    try {
      const socket = await openWebSocket(appServerUrl);
      if (this.incomingStreams.has(streamId)) socket.close();
      this.incomingStreams.set(streamId, { streamId, appServerId, socket });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          this.send({ type: "app_server_tunnel_message", streamId, data: event.data });
        } else if (event.data instanceof ArrayBuffer) {
          this.send({ type: "app_server_tunnel_message", streamId, data: Buffer.from(event.data).toString("utf8") });
        } else {
          this.send({ type: "app_server_tunnel_message", streamId, data: String(event.data) });
        }
      });
      socket.addEventListener("error", () => {
        this.send({ type: "app_server_tunnel_error", streamId, message: "Local app-server websocket error" });
      });
      socket.addEventListener("close", () => {
        this.incomingStreams.delete(streamId);
        this.send({ type: "app_server_tunnel_close", streamId });
      }, { once: true });
      this.send({ type: "app_server_tunnel_opened", streamId });
    } catch (error) {
      this.send({ type: "app_server_tunnel_error", streamId, message: errorText(error) });
    }
  }

  private closeIncoming(streamId: string, reason?: string) {
    const incoming = this.incomingStreams.get(streamId);
    if (!incoming) return;
    this.incomingStreams.delete(streamId);
    incoming.socket.close();
    if (reason && this.options.label) {
      console.error(`${this.options.label} app-server tunnel stream closed: ${reason}`);
    }
  }

  private send(frame: AppServerTunnelFrame) {
    this.options.send(frame);
  }
}

class VirtualAppServerSocket implements AppServerSocketLike {
  readyState: number = WebSocket.CONNECTING;
  private readonly listeners = new Map<string, Array<{ listener: (event: { data?: unknown }) => void; once: boolean }>>();

  constructor(private readonly options: {
    streamId: string;
    send: TunnelSend;
    onClose: () => void;
  }) {}

  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) throw new Error(`App-server tunnel stream is not open: ${this.options.streamId}`);
    this.options.send({ type: "app_server_tunnel_message", streamId: this.options.streamId, data });
  }

  close() {
    if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.options.send({ type: "app_server_tunnel_close", streamId: this.options.streamId });
    this.markRemoteClosed();
  }

  addEventListener(type: "message" | "error" | "close", listener: (event: { data?: unknown }) => void, options: { once?: boolean } = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, listeners);
  }

  markOpen() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.OPEN;
  }

  receiveMessage(data: string) {
    if (this.readyState !== WebSocket.OPEN) return;
    this.emit("message", { data });
  }

  markError(message: string) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.emit("error", { data: new Error(message) });
    this.markRemoteClosed(message);
  }

  markRemoteClosed(reason?: string) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", { data: reason });
    this.options.onClose();
  }

  private emit(type: "message" | "error" | "close", event: { data?: unknown }) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((entry) => !entry.once));
    for (const entry of listeners) entry.listener(event);
  }
}

export const isAppServerTunnelFrame = (value: unknown): value is AppServerTunnelFrame => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "app_server_tunnel_open") {
    return typeof record.streamId === "string" && typeof record.appServerId === "string";
  }
  if (type === "app_server_tunnel_opened") {
    return typeof record.streamId === "string";
  }
  if (type === "app_server_tunnel_message") {
    return typeof record.streamId === "string" && typeof record.data === "string";
  }
  if (type === "app_server_tunnel_close") {
    return typeof record.streamId === "string" && (record.reason === undefined || typeof record.reason === "string");
  }
  if (type === "app_server_tunnel_error") {
    return typeof record.streamId === "string" && typeof record.message === "string";
  }
  return false;
};

const openWebSocket = async (url: string) => {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`WebSocket failed: ${url}`)), { once: true });
  });
  return ws;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
