import path from "node:path";
import { stat } from "node:fs/promises";
import * as vscode from "vscode";
import type { ServerHandle } from "../../../src/server/index.js";
import { startEmbeddedServer } from "../../../src/server/embedded.js";

const viewId = "codexhub.workspaceView";
const defaultDaemonPort = 18788;

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
  await CodexHubWorkspaceViewProvider.stopCurrentServer({ force: process.env.CODEX_HUB_VSCODE_STOP_ON_DEACTIVATE === "1" });
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
    const workspacePath = activeWorkspacePath();
    if (!workspacePath) {
      this.view.webview.html = statusHtml("Open a folder or workspace to use Codex Hub.");
      return;
    }

    try {
      const server = await this.ensureServer();
      const url = server.url;
      await openWorkspaceProject(url, workspacePath);
      this.view.webview.html = iframeHtml(`${url}/?surface=vscode`, workspacePath);
    } catch (error) {
      this.view.webview.html = statusHtml(`Codex Hub failed to start: ${errorText(error)}`);
    }
  }

  private async ensureServer() {
    if (CodexHubWorkspaceViewProvider.currentServer) return CodexHubWorkspaceViewProvider.currentServer;
    if (!CodexHubWorkspaceViewProvider.currentServerStart) {
      CodexHubWorkspaceViewProvider.currentServerStart = this.startOrReuseSharedServer();
    }
    CodexHubWorkspaceViewProvider.currentServer = await CodexHubWorkspaceViewProvider.currentServerStart;
    return CodexHubWorkspaceViewProvider.currentServer;
  }

  private async startOrReuseSharedServer(): Promise<VscodeCodexHubServer> {
    const preferredPort = parsePort(process.env.CODEX_HUB_VSCODE_DAEMON_PORT) ?? defaultDaemonPort;
    const sharedUrl = `http://127.0.0.1:${preferredPort}`;
    const staticDirectory = this.context.asAbsolutePath("dist");
    const buildId = await vscodeDaemonBuildId(this.context, staticDirectory);
    if (await isReusableCodexHubServer(sharedUrl, { staticDirectory, buildId })) return { url: sharedUrl };
    const owned = await startEmbeddedServer({
      host: "127.0.0.1",
      portMode: "preferred",
      preferredPort,
      explicitPort: false,
      staticDirectory,
      surface: "vscode",
      buildId,
      features: {
        localMachine: true
      },
      logPrefix: "codexhub vscode daemon"
    });
    return { url: serverUrl(owned.host, owned.port), owned };
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

const isReusableCodexHubServer = async (
  serverUrl: string,
  expected: { staticDirectory: string; buildId: string }
) => {
  try {
    const response = await fetch(new URL("/api/health", serverUrl));
    if (!response.ok) return false;
    const health = asRecord(await response.json());
    if (health?.ok !== true) return false;
    if (health.surface !== "vscode") return false;
    if (typeof health.staticDirectory !== "string" || !samePath(health.staticDirectory, expected.staticDirectory)) return false;
    return health.build === expected.buildId;
  } catch {
    return false;
  }
};

const vscodeDaemonBuildId = async (context: vscode.ExtensionContext, staticDirectory: string) => {
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

const samePath = (left: string, right: string) => {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
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
