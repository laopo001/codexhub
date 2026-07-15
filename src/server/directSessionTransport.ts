import type { HeadlessSessionTransport, HeadlessSessionTransportCallbacks } from "../cli/codexhubConnect.js";
import type { ThreadHub } from "../core/threadHub.js";
import type { SessionCommand, SessionEventInput, SessionRegistration } from "../shared/threadTypes.js";

export class DirectThreadHubSessionTransport implements HeadlessSessionTransport {
  private stopped = false;
  private registered = false;
  private commandCursor = 0;
  private commandLoopStarted = false;

  constructor(
    private readonly options: {
      threads: ThreadHub;
      sessionId: string;
      machineId?: string;
      transportId: string;
      onChange: () => void;
      onRegister?: () => void;
    },
    private readonly callbacks: HeadlessSessionTransportCallbacks
  ) {}

  start() {
    if (this.stopped || this.registered) return;
    this.callbacks.onState("connecting", `codexhub direct session registering: ${this.options.sessionId}`);
    // 这是 server 内部 transport，不再经 machine WebSocket 反绕一圈。
    const { currentThreadId: _legacyCurrentThreadId, ...registration } = this.callbacks.registration() as SessionRegistration & { currentThreadId?: string };
    this.options.threads.registerSession({
      ...registration,
      sessionId: this.options.sessionId,
      machineId: this.options.machineId,
      transportId: this.options.transportId
    });
    this.registered = true;
    this.callbacks.onState("online", `codexhub direct session connected: ${this.options.sessionId}`);
    this.options.onRegister?.();
    this.options.onChange();
    this.startCommandLoop();
  }

  stop(options: { unregister?: boolean } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.registered) {
      if (options.unregister) this.options.threads.unregisterSession(this.options.sessionId, this.options.transportId);
      else this.options.threads.disconnectSession(this.options.sessionId, this.options.transportId);
    }
    this.registered = false;
    this.options.onChange();
  }

  sendEvent(event: SessionEventInput) {
    if (this.stopped || !this.registered) return;
    this.options.threads.applySessionEvent(this.options.sessionId, event);
    this.options.onChange();
  }

  sendHeartbeat(registration: Partial<SessionRegistration>) {
    if (this.stopped || !this.registered) return;
    this.options.threads.heartbeatSession(this.options.sessionId, registration);
  }

  private startCommandLoop() {
    if (this.commandLoopStarted) return;
    this.commandLoopStarted = true;
    void this.commandLoop().catch((error: unknown) => {
      if (!this.stopped) this.callbacks.onState("offline", `codexhub direct session command loop failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async commandLoop() {
    while (!this.stopped && this.registered) {
      // 直接 transport 同样使用 ThreadHub command cursor，保持和远端 session 一致的 replay 语义。
      const response = await this.options.threads.waitSessionCommands(this.options.sessionId, this.commandCursor, 60_000);
      if (this.stopped || !this.registered) return;
      this.commandCursor = Math.max(this.commandCursor, response.cursor);
      for (const command of response.commands) {
        await this.handleCommand(command);
      }
    }
  }

  private async handleCommand(command: SessionCommand) {
    try {
      const result = await this.callbacks.handleCommand(command);
      if (result !== undefined) {
        this.options.threads.resolveSessionCommand(this.options.sessionId, command.commandId, result);
      }
    } catch (error) {
      this.options.threads.failSessionCommand(this.options.sessionId, command.commandId, error instanceof Error ? error.message : String(error));
    } finally {
      this.commandCursor = Math.max(this.commandCursor, command.seq);
      this.options.onChange();
    }
  }
}

