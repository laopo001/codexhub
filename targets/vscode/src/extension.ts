import path from "node:path";
import * as vscode from "vscode";
import type { ServerHandle } from "../../../src/server/index.js";
import { localServerUrl, startEmbeddedServer } from "../../../src/server/embedded.js";

const viewId = "codexhub.workspaceView";

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
  await CodexHubWorkspaceViewProvider.stopCurrentServer();
}

class CodexHubWorkspaceViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private static currentServer: ServerHandle | null = null;
  private static currentServerStart: Promise<ServerHandle> | null = null;
  private view: vscode.WebviewView | null = null;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  static async stopCurrentServer() {
    const server = CodexHubWorkspaceViewProvider.currentServer;
    CodexHubWorkspaceViewProvider.currentServer = null;
    CodexHubWorkspaceViewProvider.currentServerStart = null;
    await server?.stop().catch((error: unknown) => {
      console.error(`codexhub vscode server stop failed: ${errorText(error)}`);
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true
    };
    view.webview.html = statusHtml("Starting Codex Hub...");
    void this.render();
  }

  dispose() {
    this.disposed = true;
  }

  async refresh() {
    if (!this.view || this.disposed) return;
    this.view.webview.html = statusHtml("Refreshing Codex Hub...");
    await this.render();
  }

  async openInBrowser() {
    const server = await this.ensureServer();
    await vscode.env.openExternal(vscode.Uri.parse(localServerUrl(server)));
  }

  private async render() {
    if (!this.view || this.disposed) return;
    const workspacePath = activeWorkspacePath();
    if (!workspacePath) {
      this.view.webview.html = statusHtml("Open a folder or workspace to use Codex Hub.");
      return;
    }

    try {
      const server = await this.ensureServer();
      const url = localServerUrl(server);
      await openWorkspaceProject(url, workspacePath);
      this.view.webview.html = iframeHtml(`${url}/?surface=vscode`, workspacePath);
    } catch (error) {
      this.view.webview.html = statusHtml(`Codex Hub failed to start: ${errorText(error)}`);
    }
  }

  private async ensureServer() {
    if (CodexHubWorkspaceViewProvider.currentServer) return CodexHubWorkspaceViewProvider.currentServer;
    if (!CodexHubWorkspaceViewProvider.currentServerStart) {
      CodexHubWorkspaceViewProvider.currentServerStart = startEmbeddedServer({
        host: "127.0.0.1",
        preferredPort: 18789,
        explicitPort: false,
        staticDirectory: this.context.asAbsolutePath("dist"),
        surface: "vscode",
        features: {
          localMachine: true,
          ssh: false,
          tasks: false,
          integrations: false
        },
        logPrefix: "codexhub vscode"
      });
    }
    CodexHubWorkspaceViewProvider.currentServer = await CodexHubWorkspaceViewProvider.currentServerStart;
    return CodexHubWorkspaceViewProvider.currentServer;
  }
}

const activeWorkspacePath = () => {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  const folder = activeFolder ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.scheme === "file" ? folder.uri.fsPath : "";
};

const openWorkspaceProject = async (serverUrl: string, workspacePath: string) => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(new URL("/api/projects/open", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: workspacePath, reuse: true })
      });
      if (response.ok) return;
      const body = await response.text();
      lastError = new Error(`HTTP ${response.status}: ${body}`);
      if (!body.includes("No online codexhub machine")) break;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError instanceof Error ? lastError : new Error(errorText(lastError));
};

const iframeHtml = (src: string, workspacePath: string) => {
  const nonce = randomNonce();
  const escapedSource = escapeHtml(src);
  const escapedOrigin = escapeHtml(new URL(src).origin);
  const escapedTitle = escapeHtml(`Codex Hub: ${path.basename(workspacePath) || workspacePath}`);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapedOrigin}; style-src 'nonce-${nonce}';">`,
    `<title>${escapedTitle}</title>`,
    `<style nonce="${nonce}">`,
    "html, body, iframe { width: 100%; height: 100%; margin: 0; padding: 0; }",
    "body { overflow: hidden; background: var(--vscode-sideBar-background); }",
    "iframe { display: block; border: 0; }",
    "</style>",
    "</head>",
    "<body>",
    `<iframe src="${escapedSource}" title="${escapedTitle}" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"></iframe>`,
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

const delay = async (ms: number) => await new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
