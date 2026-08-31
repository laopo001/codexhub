export type WebClientHeartbeat = {
  beat: () => Promise<void>;
};

export const createWebClientHeartbeat = (options: {
  send: () => Promise<unknown>;
  requestRecovery: () => void;
}): WebClientHeartbeat => {
  let inFlight = false;

  return {
    beat: async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await options.send();
      } catch {
        options.requestRecovery();
      } finally {
        inFlight = false;
      }
    }
  };
};
