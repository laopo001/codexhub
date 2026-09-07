import type { SessionCommand } from "../shared/threadTypes.js";

/**
 * CodexHub-level commands sent to a child backend.  This deliberately reuses
 * the existing semantic SessionCommand vocabulary; it never carries raw
 * app-server JSON-RPC frames.
 */
export type RemoteBackendCommand = Omit<SessionCommand, "seq">;

export type RemoteBackendExecutor = {
  execute: (sessionId: string, command: RemoteBackendCommand) => Promise<unknown>;
  waitForCompletion?: (sessionId: string, commandId: string) => Promise<void>;
};
