import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { RpcProxy } from "@theia/core/lib/common/messaging/proxy-factory";
import type {
  CodexHubBackendService,
  CodexHubBackendStartInput,
  CodexHubBackendStartResult,
} from "../common/codexhub-protocol.js";

type ConnectionClient = RpcProxy<Record<string, never>>;
type EmbeddedServerHandle = {
  stop(): Promise<void>;
};

export class CodexHubTheiaBackendService implements CodexHubBackendService {
  private server: EmbeddedServerHandle | null = null;
  private serverUrl = "";
  private serverKey = "";
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(
    client: ConnectionClient,
    private readonly staticDirectory: string,
    private readonly remoteClientPath: string,
  ) {
    client.onDidCloseConnection(() => {
      void this.stop();
    });
  }

  start(input: CodexHubBackendStartInput): Promise<CodexHubBackendStartResult> {
    const normalized = normalizeStartInput(input);
    const key = workspaceKey(normalized.workspacePaths);
    return this.enqueue(async () => {
      if (this.server && this.serverKey === key) return { url: this.serverUrl };
      await this.stopCurrent();
      return this.startServer(normalized, key);
    });
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopCurrent());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private async stopCurrent(): Promise<void> {
    const current = this.server;
    this.server = null;
    this.serverUrl = "";
    this.serverKey = "";
    await current?.stop();
  }

  private async startServer(
    input: CodexHubBackendStartInput,
    key: string,
  ): Promise<CodexHubBackendStartResult> {
    const { localServerUrl, startEmbeddedServer } = await import("../../../../src/server/embedded.js");
    if (!process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH) {
      process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH = this.remoteClientPath;
    }
    this.serverKey = key;
    try {
      const server = await startEmbeddedServer({
        host: "127.0.0.1",
        portMode: "random",
        dataDir: theiaDataDirectory(key),
        staticDirectory: this.staticDirectory,
        surface: "theia",
        features: { localMachine: true },
        logPrefix: "codexhub theia window",
      });
      this.server = server;
      const url = localServerUrl(server);
      this.serverUrl = url;
      await openWorkspaceProjects(url, input);
      return { url };
    } catch (error) {
      await this.stopCurrent();
      throw error;
    }
  }
}

const normalizeStartInput = (input: CodexHubBackendStartInput): CodexHubBackendStartInput => {
  const workspacePaths = [...new Set(
    (Array.isArray(input.workspacePaths) ? input.workspacePaths : [])
      .map((value) => value.trim())
      .filter((value) => path.isAbsolute(value)),
  )];
  const activeWorkspacePath = input.activeWorkspacePath?.trim();
  return {
    workspacePaths,
    activeWorkspacePath: activeWorkspacePath && workspacePaths.includes(activeWorkspacePath)
      ? activeWorkspacePath
      : workspacePaths[0],
    workspaceLabel: input.workspaceLabel?.trim() || workspacePaths.map((value) => path.basename(value)).join(", "),
  };
};

const workspaceKey = (workspacePaths: string[]) => createHash("sha256")
  .update(workspacePaths.join("\0") || "empty-workspace")
  .digest("hex")
  .slice(0, 16);

const theiaDataDirectory = (key: string) => path.join(
  process.env.CODEX_HUB_THEIA_DATA_DIR?.trim()
    || path.join(os.homedir(), ".config", "codexhub", "theia"),
  key,
);

const openWorkspaceProjects = async (serverUrl: string, input: CodexHubBackendStartInput) => {
  const { openEmbeddedWorkspaceProjects } = await import("../../../../src/core/embeddedWorkspaceProjects.js");
  await openEmbeddedWorkspaceProjects({
    serverUrl,
    workspacePaths: input.workspacePaths,
    activeWorkspacePath: input.activeWorkspacePath,
    source: {
      kind: "theia",
      groupId: "theia-workspace",
      label: input.workspaceLabel || "Theia Workspace"
    }
  });
};
