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
  const failuresBeforeRecovery = Math.max(1, Math.floor(options.failuresBeforeRecovery ?? 3));

  return {
    beat: async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await options.send();
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= failuresBeforeRecovery) {
          consecutiveFailures = 0;
          try {
            options.requestRecovery();
          } catch {
            // Host recovery failures must not break the heartbeat loop.
          }
        }
      } finally {
        inFlight = false;
      }
    }
  };
};
