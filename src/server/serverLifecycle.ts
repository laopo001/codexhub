import type { FastifyInstance } from "fastify";

export type ServerLifecycleOptions = {
  intervals: Array<NodeJS.Timeout | null>;
  subscriptionTimers: Map<string, NodeJS.Timeout>;
  stopTunneledSessions: () => Promise<void>;
  stopSshMachines: () => Promise<void>;
  stopParentRegistration: () => Promise<void>;
  stopLocalMachine: () => Promise<void>;
  stopIntegrations: () => void;
  flushState: () => Promise<void>;
};

export const registerServerLifecycle = (app: FastifyInstance, options: ServerLifecycleOptions) => {
  app.addHook("onClose", async () => {
    for (const interval of options.intervals) {
      if (interval) clearInterval(interval);
    }
    for (const timer of options.subscriptionTimers.values()) clearTimeout(timer);
    options.subscriptionTimers.clear();
    await options.stopTunneledSessions();
    await options.stopSshMachines();
    await options.stopParentRegistration();
    await options.stopLocalMachine();
    options.stopIntegrations();
    await options.flushState();
  });
};
