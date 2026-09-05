import type { FastifyInstance } from "fastify";

export type ServerLifecycleOptions = {
  intervals: Array<NodeJS.Timeout | null>;
  subscriptionTimers: Map<string, NodeJS.Timeout>;
  stopTunneledSessions: () => Promise<void>;
  stopSshMachines: () => Promise<void>;
  stopParentRegistration: () => Promise<void>;
  stopLocalMachine: () => Promise<void>;
  stopEmbeddedSurfaces: () => void;
  stopIntegrations: () => void;
  flushState: () => Promise<void>;
};

export const registerServerLifecycle = (app: FastifyInstance, options: ServerLifecycleOptions) => {
  // 必须在 HTTP drain 前停止 runtime：在途请求可能正等待它的命令结果。
  app.addHook("preClose", async () => {
    for (const interval of options.intervals) {
      if (interval) clearInterval(interval);
    }
    for (const timer of options.subscriptionTimers.values()) clearTimeout(timer);
    options.subscriptionTimers.clear();
    options.stopEmbeddedSurfaces();
    options.stopIntegrations();
    const results = await Promise.allSettled([
      options.stopTunneledSessions(),
      options.stopSshMachines(),
      options.stopParentRegistration(),
      options.stopLocalMachine()
    ]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Failed to stop server runtimes");
  });
  app.addHook("onClose", async () => {
    await options.flushState();
  });
};
