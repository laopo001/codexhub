import { startAttachedCodexhubSession, type HeadlessCodexhubSessionHandle } from "../cli/codexhubConnect.js";
import type { AppServerTunnelPeer } from "../core/appServerTunnel.js";
import type { ThreadHub } from "../core/threadHub.js";
import { DirectThreadHubSessionTransport } from "./directSessionTransport.js";

type TunneledSessionEntry = {
  transportId: string;
  machineId: string;
  appServerId: string;
  handle: HeadlessCodexhubSessionHandle;
};

export type TunneledSessionManagerOptions = {
  apiBase: string;
  threads: ThreadHub;
  captureSessionState: () => void;
  publishProjects: () => void;
  refreshRetainedThreadRecordSubscriptions: () => void;
};

export class TunneledSessionManager {
  private readonly sessions = new Map<string, TunneledSessionEntry>();

  constructor(private readonly options: TunneledSessionManagerOptions) {}

  async stop(sessionId: string, transportId?: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry || (transportId && entry.transportId !== transportId)) return;
    this.sessions.delete(sessionId);
    await entry.handle.stop().catch(() => undefined);
    this.options.publishProjects();
  }

  async stopForTransport(transportId: string) {
    const sessionIds = [...this.sessions.entries()]
      .filter(([, entry]) => entry.transportId === transportId)
      .map(([sessionId]) => sessionId);
    await Promise.allSettled(sessionIds.map((sessionId) => this.stop(sessionId, transportId)));
  }

  async stopAll() {
    await Promise.allSettled([...this.sessions.values()].map((entry) => entry.handle.stop()));
    this.sessions.clear();
  }

  async attach(input: {
    machineId: string;
    transportId: string;
    commandId: string;
    sessionId: string;
    appServerId: string;
    cwd: string;
    appServerUrl: string;
    tunnel: AppServerTunnelPeer;
  }) {
    const existing = this.sessions.get(input.sessionId);
    if (existing && existing.transportId !== input.transportId) await this.stop(input.sessionId);
    if (existing && existing.transportId === input.transportId) return existing.handle.threadId;
    const sessionTransportId = `${input.transportId}:app-server:${input.sessionId}`;
    const handle = await startAttachedCodexhubSession({
      apiBase: this.options.apiBase,
      appServerUrl: `tunnel://${input.appServerId}`,
      appServerTransportFactory: () => input.tunnel.openStream(input.appServerId),
      sessionId: input.sessionId,
      machineId: input.machineId,
      cwd: input.cwd,
      readyLabel: "codexhub tunneled app-server ready",
      transportFactory: (_context, callbacks) => new DirectThreadHubSessionTransport({
        threads: this.options.threads,
        sessionId: input.sessionId,
        machineId: input.machineId,
        transportId: sessionTransportId,
        onChange: () => {
          this.options.captureSessionState();
          this.options.publishProjects();
        },
        onRegister: this.options.refreshRetainedThreadRecordSubscriptions
      }, callbacks)
    });
    this.sessions.set(input.sessionId, {
      transportId: input.transportId,
      machineId: input.machineId,
      appServerId: input.appServerId,
      handle
    });
    this.options.publishProjects();
    return handle.threadId;
  }

  async startThread(input: { transportId: string; sessionId: string; cwd: string; threadId?: string }) {
    const entry = this.sessions.get(input.sessionId);
    if (!entry || entry.transportId !== input.transportId) {
      throw new Error(`Tunneled app-server session not attached: ${input.sessionId}`);
    }
    const threadId = input.threadId
      ? await entry.handle.ensureThread(input.threadId, input.cwd)
      : await entry.handle.startThread(input.cwd);
    this.options.publishProjects();
    return threadId;
  }
}
