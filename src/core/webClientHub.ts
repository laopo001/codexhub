export type WebClientHubOptions = {
  timeoutMs?: number;
  retryMs?: number;
  now?: () => number;
  canShutdown: () => boolean;
  onIdle: () => void;
};

export const defaultWebClientAuthorityTimeoutMs = 5 * 60_000;
const defaultRetryMs = 5_000;

export class WebClientHub {
  private readonly clients = new Map<string, number>();
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTriggered = false;

  constructor(private readonly options: WebClientHubOptions) {
    this.timeoutMs = positiveMilliseconds(options.timeoutMs, defaultWebClientAuthorityTimeoutMs);
    this.retryMs = positiveMilliseconds(options.retryMs, defaultRetryMs);
    this.now = options.now ?? Date.now;
    this.sweepTimer = setInterval(() => this.expireStaleClients(), Math.min(5_000, this.timeoutMs));
    this.sweepTimer.unref?.();
    this.scheduleIdleCheck(this.timeoutMs);
  }

  touch(clientId: string) {
    this.clients.set(clientId, this.now());
    this.idleTriggered = false;
    this.cancelIdleCheck();
  }

  list() {
    return [...this.clients.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([clientId, lastSeenAtMs]) => ({
        clientId,
        lastSeenAt: new Date(lastSeenAtMs).toISOString(),
        expiresAt: new Date(lastSeenAtMs + this.timeoutMs).toISOString()
      }));
  }

  stop() {
    clearInterval(this.sweepTimer);
    this.cancelIdleCheck();
    this.clients.clear();
  }

  private expireStaleClients() {
    const deadline = this.now() - this.timeoutMs;
    for (const [clientId, lastSeenAtMs] of this.clients) {
      if (lastSeenAtMs > deadline) continue;
      this.clients.delete(clientId);
    }
    if (!this.clients.size) this.scheduleIdleCheck(0);
  }

  private scheduleIdleCheck(delayMs: number) {
    if (this.idleTimer || this.idleTriggered) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size) return;
      if (!this.options.canShutdown()) {
        this.scheduleIdleCheck(this.retryMs);
        return;
      }
      this.idleTriggered = true;
      this.options.onIdle();
    }, delayMs);
    this.idleTimer.unref?.();
  }

  private cancelIdleCheck() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

const positiveMilliseconds = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
