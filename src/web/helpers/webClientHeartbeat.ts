export type WebClientHeartbeat = {
  beat: () => Promise<void>;
};

export const createWebClientHeartbeat = (options: {
  send: () => Promise<unknown>;
  requestRecovery: () => void;
  failuresBeforeRecovery?: number;
}): WebClientHeartbeat => {
  let inFlight = false;
  let consecutiveFailures = 0;
  let recoveryRequested = false;
  const failuresBeforeRecovery = Math.max(1, Math.floor(options.failuresBeforeRecovery ?? 3));

  return {
    beat: async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await options.send();
        consecutiveFailures = 0;
        recoveryRequested = false;
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= failuresBeforeRecovery && !recoveryRequested) {
          recoveryRequested = true;
          options.requestRecovery();
        }
      } finally {
        inFlight = false;
      }
    }
  };
};
