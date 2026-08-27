export type AuthorityInstanceHealth = {
  serverInstanceId?: string;
};

/**
 * Top-level Web clients reload only when realtime reconnects to a replacement
 * authority process. Same-instance network reconnects remain mounted.
 */
export class AuthorityInstanceRecoveryController {
  private acceptedInstanceId = "";
  private checkInFlight: Promise<boolean> | null = null;
  private reloadRequested = false;

  accept(serverInstanceId: string | undefined) {
    const normalized = serverInstanceId?.trim() ?? "";
    if (normalized) this.acceptedInstanceId = normalized;
  }

  checkAfterReconnect(
    readHealth: () => Promise<AuthorityInstanceHealth>,
    reload: () => void
  ) {
    if (this.checkInFlight) return this.checkInFlight;
    this.checkInFlight = this.checkReplacement(readHealth, reload).finally(() => {
      this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  private async checkReplacement(
    readHealth: () => Promise<AuthorityInstanceHealth>,
    reload: () => void
  ) {
    const health = await readHealth();
    const currentInstanceId = health.serverInstanceId?.trim() ?? "";
    if (!currentInstanceId) return false;

    const previousInstanceId = this.acceptedInstanceId;
    this.acceptedInstanceId = currentInstanceId;
    if (!previousInstanceId || currentInstanceId === previousInstanceId || this.reloadRequested) {
      return false;
    }

    this.reloadRequested = true;
    reload();
    return true;
  }
}

export const authorityInstanceRecovery = new AuthorityInstanceRecoveryController();
