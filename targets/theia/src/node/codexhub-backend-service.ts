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
  if (!input.workspacePaths.length) return;
  const ordered = [
    ...input.workspacePaths.filter((item) => item === input.activeWorkspacePath),
    ...input.workspacePaths.filter((item) => item !== input.activeWorkspacePath),
  ];
  for (const workspacePath of ordered) {
    await openWorkspaceProject(serverUrl, workspacePath, input.workspaceLabel || "Theia Workspace");
  }
};

const openWorkspaceProject = async (serverUrl: string, workspacePath: string, label: string) => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const machineId = await localMachineId(serverUrl);
      const response = await fetch(new URL("/api/projects/open", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machineId,
          path: workspacePath,
          reuse: true,
          persist: false,
          source: {
            kind: "theia",
            groupId: "theia-workspace",
            label,
          },
        }),
      });
      if (response.ok) return;
      const body = await response.text();
      lastError = new Error(`HTTP ${response.status}: ${body}`);
      if (!isLauncherStarting(response.status, body)) break;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const localMachineId = async (serverUrl: string) => {
  const response = await fetch(new URL("/api/machines", serverUrl));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const body = asRecord(await response.json().catch(() => null));
  const machines = Array.isArray(body?.machines) ? body.machines : [];
  const local = machines
    .map(asRecord)
    .find((machine) => machine?.type === "local" && machine.online === true && asRecord(machine.capabilities)?.projectLauncher !== false);
  const machineId = typeof local?.machineId === "string" ? local.machineId : "";
  if (!machineId) throw new Error("Theia local project launcher is still starting.");
  return machineId;
};

const isLauncherStarting = (status: number, body: string) =>
  status === 409 && /launcher|machine|offline|starting/i.test(body);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
