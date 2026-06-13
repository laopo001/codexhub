import path from "node:path";
import { stat } from "node:fs/promises";
import * as vscode from "vscode";
import type { ServerHandle } from "../../../src/server/index.js";
import { startEmbeddedServer } from "../../../src/server/embedded.js";

const viewId = "codexhub.workspaceView";
const vscodeWorkspaceGroupId = "workspace";

type VscodeCodexHubServer = {
  url: string;
  owned?: ServerHandle;
};

export function activate(context: vscode.ExtensionContext) {
  const provider = new CodexHubWorkspaceViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("codexhub.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("codexhub.openInBrowser", () => provider.openInBrowser()),
    provider
  );
}

export async function deactivate() {
  await CodexHubWorkspaceViewProvider.stopCurrentServer({ force: true });
}

class CodexHubWorkspaceViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private static currentServer: VscodeCodexHubServer | null = null;
  private static currentServerStart: Promise<VscodeCodexHubServer> | null = null;
  private view: vscode.WebviewView | null = null;
  private webviewMessageSubscription: vscode.Disposable | null = null;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  static async stopCurrentServer(options: { force?: boolean } = {}) {
    const server = CodexHubWorkspaceViewProvider.currentServer;
    CodexHubWorkspaceViewProvider.currentServer = null;
    CodexHubWorkspaceViewProvider.currentServerStart = null;
    if (!options.force) return;
    await server?.owned?.stop().catch((error: unknown) => {
      console.error(`codexhub vscode server stop failed: ${errorText(error)}`);
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.webviewMessageSubscription?.dispose();
    this.webviewMessageSubscription = view.webview.onDidReceiveMessage((message) => {
      void this.handleWebviewMessage(message);
    });
    view.webview.options = {
      enableScripts: true
    };
    view.webview.html = statusHtml("Starting Codex Hub...");
    void this.render();
  }

  dispose() {
    this.disposed = true;
    this.webviewMessageSubscription?.dispose();
    this.webviewMessageSubscription = null;
  }

  async refresh() {
    if (!this.view || this.disposed) return;
    this.view.webview.html = statusHtml("Refreshing Codex Hub...");
    await this.render();
  }

  async openInBrowser() {
    const server = await this.ensureServer();
    await vscode.env.openExternal(vscode.Uri.parse(server.url));
  }

  private async handleWebviewMessage(message: unknown) {
    const record = asRecord(message);
    if (record?.type !== "codexhub.taskCompleteNotification") return;
    const notification = asRecord(record.notification);
    const title = stringValue(notification?.title) ?? "Codex task complete";
    const body = stringValue(notification?.body) ?? "";
    const text = truncateNotificationText(body ? `${title}: ${body}` : title);
    const open = "Open";
    const selected = await vscode.window.showInformationMessage(text, open);
    if (selected !== open) return;
    if (this.view) this.view.show(false);
    else await vscode.commands.executeCommand(`${viewId}.focus`);
  }

  private async render() {
    if (!this.view || this.disposed) return;
    const workspaceFolders = fileWorkspaceFolders();
    if (!workspaceFolders.length) {
      this.view.webview.html = statusHtml("Open a folder or workspace to use Codex Hub.");
      return;
    }
    const activeFolder = activeWorkspaceFolder(workspaceFolders) ?? workspaceFolders[0];

    try {
      const server = await this.ensureServer();
      const url = server.url;
      await openWorkspaceProjects(url, workspaceFolders, activeFolder.path);
      const iframeUrl = new URL("/", url);
      iframeUrl.searchParams.set("surface", "vscode");
      iframeUrl.searchParams.set("workspacePath", activeFolder.path);
      for (const folder of workspaceFolders) iframeUrl.searchParams.append("workspaceFolder", folder.path);
      this.view.webview.html = iframeHtml(iframeUrl.toString(), activeFolder.path);
    } catch (error) {
      this.view.webview.html = statusHtml(`Codex Hub failed to start: ${errorText(error)}`);
    }
  }

  private async ensureServer() {
    if (CodexHubWorkspaceViewProvider.currentServer) return CodexHubWorkspaceViewProvider.currentServer;
    if (!CodexHubWorkspaceViewProvider.currentServerStart) {
      CodexHubWorkspaceViewProvider.currentServerStart = this.startWindowServer();
    }
    CodexHubWorkspaceViewProvider.currentServer = await CodexHubWorkspaceViewProvider.currentServerStart;
    return CodexHubWorkspaceViewProvider.currentServer;
  }

  private async startWindowServer(): Promise<VscodeCodexHubServer> {
    const staticDirectory = this.context.asAbsolutePath("dist");
    const buildId = await vscodeWindowBuildId(this.context, staticDirectory);
    const explicitPort = parsePort(process.env.CODEX_HUB_PORT);
    const owned = await startEmbeddedServer({
      host: process.env.CODEX_HUB_HOST ?? "0.0.0.0",
      portMode: explicitPort ? "preferred" : "random",
      preferredPort: explicitPort,
      explicitPort: Boolean(explicitPort),
      staticDirectory,
      surface: "vscode",
      buildId,
      features: {
        localMachine: true
      },
      logPrefix: "codexhub vscode window"
    });
    return { url: serverUrl(owned.host, owned.port), owned };
  }
}

type VscodeWorkspaceFolder = {
  path: string;
  name: string;
};

const fileWorkspaceFolders = (): VscodeWorkspaceFolder[] =>
  (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => ({
      path: folder.uri.fsPath,
      name: folder.name
    }));

const activeWorkspaceFolder = (folders: VscodeWorkspaceFolder[]) => {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  return activeFolder?.uri.scheme === "file"
    ? folders.find((folder) => folder.path === activeFolder.uri.fsPath)
    : undefined;
};

const openWorkspaceProjects = async (serverUrl: string, folders: VscodeWorkspaceFolder[], activePath: string) => {
  const orderedFolders = [
    ...folders.filter((folder) => folder.path === activePath),
    ...folders.filter((folder) => folder.path !== activePath)
  ];
  const label = vscodeWorkspaceGroupLabel(folders);
  for (const folder of orderedFolders) {
    await openWorkspaceProject(serverUrl, folder.path, label);
  }
};

const openWorkspaceProject = async (serverUrl: string, workspacePath: string, groupLabel: string) => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(new URL("/api/projects/open", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: workspacePath,
          reuse: true,
          persist: false,
          source: {
            kind: "vscode",
            groupId: vscodeWorkspaceGroupId,
            label: groupLabel
          }
        })
      });
      if (response.ok) return;
      const body = await response.text();
      lastError = new Error(`HTTP ${response.status}: ${body}`);
      if (!isTransientProjectLauncherOpenError(response.status, body)) break;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError instanceof Error ? lastError : new Error(errorText(lastError));
};

const isTransientProjectLauncherOpenError = (status: number, body: string) =>
  status === 409 && (
    body.includes("No online codexhub project launcher")
    || body.includes("No online codexhub machine")
    || body.includes("Project launcher is offline or not found")
  );

const vscodeWorkspaceGroupLabel = (folders: VscodeWorkspaceFolder[]) => {
  const workspaceName = vscode.workspace.name?.trim();
  if (workspaceName && (folders.length > 1 || workspaceName !== folders[0]?.name)) return `VSCode: ${workspaceName}`;
  const folderName = folders[0]?.name?.trim();
  return folderName ? `VSCode: ${folderName}` : "VSCode Workspace";
};

const iframeHtml = (src: string, workspacePath: string) => {
  const nonce = randomNonce();
  const escapedSource = escapeHtml(src);
  const escapedOrigin = escapeHtml(new URL(src).origin);
  const sourceOriginJson = scriptJson(new URL(src).origin);
  const escapedTitle = escapeHtml(`Codex Hub: ${path.basename(workspacePath) || workspacePath}`);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapedOrigin}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">`,
    `<title>${escapedTitle}</title>`,
    `<style nonce="${nonce}">`,
    "html, body, iframe { width: 100%; height: 100%; margin: 0; padding: 0; }",
    "body { overflow: hidden; background: var(--vscode-sideBar-background); }",
    "iframe { display: block; border: 0; }",
    "</style>",
    "</head>",
    "<body>",
    `<iframe src="${escapedSource}" title="${escapedTitle}" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"></iframe>`,
    `<script nonce="${nonce}">`,
    "const vscode = acquireVsCodeApi();",
    `const expectedOrigin = ${sourceOriginJson};`,
    "window.addEventListener('message', (event) => {",
    "  if (event.origin !== expectedOrigin) return;",
    "  const data = event.data;",
    "  if (!data || data.type !== 'codexhub.taskCompleteNotification') return;",
    "  vscode.postMessage(data);",
    "});",
    "</script>",
    "</body>",
    "</html>"
  ].join("");
};

const statusHtml = (message: string) => {
  const nonce = randomNonce();
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">`,
    "<title>Codex Hub</title>",
    `<style nonce="${nonce}">`,
    "body { margin: 0; padding: 14px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size) var(--vscode-font-family); }",
    ".status { overflow-wrap: anywhere; line-height: 1.45; }",
    "</style>",
    "</head>",
    "<body>",
    `<div class="status">${escapeHtml(message)}</div>`,
    "</body>",
    "</html>"
  ].join("");
};

const randomNonce = () => Math.random().toString(36).slice(2);

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const scriptJson = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringValue = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

const truncateNotificationText = (value: string) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
};

const delay = async (ms: number) => await new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const vscodeWindowBuildId = async (context: vscode.ExtensionContext, staticDirectory: string) => {
  const packageJson = asRecord(context.extension.packageJSON);
  const version = stringValue(packageJson?.version) ?? "0.0.0";
  const id = context.extension.id || "codexhub";
  const fingerprints = await Promise.all([
    fileFingerprint(context.asAbsolutePath("extension.cjs")),
    fileFingerprint(path.join(staticDirectory, "index.html"))
  ]);
  return `vscode:${id}:${version}:${fingerprints.join(":")}`;
};

const fileFingerprint = async (filePath: string) => {
  try {
    const info = await stat(filePath);
    return `${path.basename(filePath)}-${info.size}-${Math.trunc(info.mtimeMs)}`;
  } catch {
    return `${path.basename(filePath)}-missing`;
  }
};

const serverUrl = (host: string, port: number) => {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}`;
};

const parsePort = (value: string | undefined) => {
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
