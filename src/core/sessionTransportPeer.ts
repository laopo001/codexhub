import type { MachineSessionTransportMessage } from "./machineTransportProtocol.js";
import type { SessionCommand, SessionEventInput, SessionRegistration } from "../shared/threadTypes.js";

export type SessionTransportCallbacks = {
  registration: () => SessionRegistration;
  handleCommand: (command: SessionCommand) => Promise<unknown>;
  onState: (state: "connecting" | "online" | "offline", message: string) => void;
};

export type SessionTransportPeerOptions = {
  sessionId: string;
  send: (message: unknown) => void;
  callbacks: SessionTransportCallbacks;
  onStop?: () => void;
  messages?: Partial<{
    connecting: (sessionId: string) => string;
    online: (sessionId: string) => string;
    offline: (sessionId: string) => string;
    commandQueueFailed: string;
    serverError: string;
  }>;
};

// 这里是 machine/direct transport 共用的 session 端；重连时保留 command cursor。
export class SessionTransportPeer {
  private registered = false;
  private stopped = false;
  private commandCursor = 0;
  private pendingOutgoing: unknown[] = [];
  private commandChain = Promise.resolve();

  constructor(private readonly options: SessionTransportPeerOptions) {}

  start() {
    if (this.stopped) return;
    this.register();
  }

  reconnect() {
    if (this.stopped) return;
    this.registered = false;
    this.register();
  }

  markDisconnected() {
    if (this.stopped || !this.registered) return;
    this.registered = false;
    this.options.callbacks.onState(
      "offline",
      this.options.messages?.offline?.(this.options.sessionId)
        ?? `codexhub machine session offline: ${this.options.sessionId}`
    );
  }

  stop(options: { unregister?: boolean } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    if (options.unregister && this.registered) {
      this.options.send({ type: "session_unregister", sessionId: this.options.sessionId });
    }
    this.registered = false;
    this.pendingOutgoing = [];
    this.options.onStop?.();
  }

  sendEvent(event: SessionEventInput) {
    this.sendOrQueue({ type: "session_event", sessionId: this.options.sessionId, event });
  }

  sendHeartbeat(registration: Partial<SessionRegistration>) {
    this.sendOrQueue({
      type: "session_heartbeat",
      sessionId: this.options.sessionId,
      registration
    }, { queue: false });
  }

  handleServerMessage(message: MachineSessionTransportMessage) {
    if (this.stopped) return;
    if (message.sessionId !== this.options.sessionId) return;
    if (message.type === "session_registered") {
      this.registered = true;
      this.options.callbacks.onState(
        "online",
        this.options.messages?.online?.(message.sessionId)
          ?? `codexhub machine session connected: ${message.sessionId}`
      );
      this.flushPending();
      return;
    }
    if (message.type === "session_commands") {
      this.commandCursor = Math.max(this.commandCursor, message.cursor);
      this.enqueueCommands(message.commands);
      return;
    }
    console.error(`${this.options.messages?.serverError ?? "codexhub machine session error"}: ${message.message}`);
  }

  private register() {
    this.options.callbacks.onState(
      "connecting",
      this.options.messages?.connecting?.(this.options.sessionId)
        ?? `codexhub machine session connecting: ${this.options.sessionId}`
    );
    this.options.send({
      type: "session_register",
      sessionId: this.options.sessionId,
      commandCursor: this.commandCursor,
      registration: this.options.callbacks.registration()
    });
  }

  private enqueueCommands(commands: SessionCommand[]) {
    // 这里的 session command 必须按服务端顺序执行，commandCursor 才能安全 replay。
    this.commandChain = this.commandChain.then(async () => {
      for (const command of commands) {
        try {
          const result = await this.options.callbacks.handleCommand(command);
          if (result !== undefined) {
            this.sendOrQueue({
              type: "session_command_result",
              sessionId: this.options.sessionId,
              commandId: command.commandId,
              result
            });
          }
        } catch (error) {
          this.sendOrQueue({
            type: "session_command_error",
            sessionId: this.options.sessionId,
            commandId: command.commandId,
            message: errorText(error)
          });
        } finally {
          this.commandCursor = Math.max(this.commandCursor, command.seq);
        }
      }
    }).catch((error) => {
      console.error(`${this.options.messages?.commandQueueFailed ?? "codexhub machine session command queue failed"}: ${errorText(error)}`);
    });
  }

  private flushPending() {
    for (const message of this.pendingOutgoing.splice(0)) this.options.send(message);
  }

  private sendOrQueue(message: unknown, options: { queue?: boolean } = {}) {
    if (this.registered) {
      this.options.send(message);
      return;
    }
    // 这里的 heartbeat 是临时状态；thread events/results 会排队等注册恢复。
    if (options.queue === false) return;
    this.pendingOutgoing.push(message);
    if (this.pendingOutgoing.length > 1000) this.pendingOutgoing.splice(0, this.pendingOutgoing.length - 1000);
  }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
