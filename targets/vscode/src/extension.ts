import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import {
  embeddedAuthorityDataDirectory,
  migrateLegacyEmbeddedAuthorityData
} from "../../../src/core/authorityPaths.js";
import {
  ensureEmbeddedAuthority,
  probeEmbeddedAuthority,
  type EmbeddedAuthorityHandle
} from "../../../src/core/embeddedAuthority.js";
import { readServerConfigEnv } from "../../../src/core/serverConfigEnv.js";
import {
  embeddedSurfaceProtocolVersion
} from "../../../src/shared/surfaceTypes.js";
import { createCodexHubApiClient, CodexHubApiError } from "../../../src/shared/apiClient.js";
import { apiRoutes } from "../../../src/shared/apiRoutes.js";
import {
  configuredVscodeAuthorityAuthToken,
  removeLegacyVscodeAuthorityTokenFile
} from "./authorityAuth.js";
import {
  readVscodeExtensionSettings,
  type VscodeExtensionSettings
} from "./settings.js";
import { buildWebviewBridgeScript } from "./webviewBridge.js";

const viewId = "codexhub.workspaceView";
const surfaceHeartbeatMs = 10_000;
const maxSelectionAttachmentBytes = 512 * 1024;

const currentVscodeExtensionSettings = () => readVscodeExtensionSettings(
  vscode.workspace.getConfiguration("codexhub")
);

type VscodeCodexHubServer = EmbeddedAuthorityHandle;

let activeProvider: CodexHubWorkspaceViewProvider | null = null;

export function activate(context: vscode.ExtensionContext) {
  const provider = new CodexHubWorkspaceViewProvider(context);
  activeProvider = provider;

  const updateSettings = () => {
    const settings = currentVscodeExtensionSettings();
    void vscode.commands.executeCommand("setContext", "codexhub.enabled", settings.enabled);
    provider.onSettingsChanged(settings);
  };

  updateSettings();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("codexhub.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("codexhub.openInBrowser", () => provider.openInBrowser()),
    vscode.commands.registerCommand("codexhub.openConfig", () => provider.openConfig()),
    vscode.commands.registerCommand("codexhub.sendSelectionToChat", () => provider.sendSelectionToChat()),
    vscode.commands.registerCommand("codexhub.sendPathToChat", (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => provider.sendPathToChat(uri, selectedUris)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("codexhub")) return;
      updateSettings();
    }),
    provider
  );
}

export async function deactivate() {
  const provider = activeProvider;
  activeProvider = null;
  await provider?.shutdown();
}

class CodexHubWorkspaceViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private static currentServer: VscodeCodexHubServer | null = null;
  private static currentServerStart: Promise<VscodeCodexHubServer> | null = null;
  private view: vscode.WebviewView | null = null;
  private webviewMessageSubscription: vscode.Disposable | null = null;
  private renderPromise: Promise<void> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInFlight = false;
  private registeredServerUrl = "";
  private registeredAuthToken = "";
  private readonly surfaceId = `vscode-${randomUUID()}`;
  private readonly leaseId = randomUUID();
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  isEnabled() {
    return currentVscodeExtensionSettings().enabled;
  }

  onSettingsChanged(settings: VscodeExtensionSettings) {
    if (!settings.enabled) {
      this.stopHeartbeat();
      void this.unregisterSurface();
      if (this.view && !this.disposed) {
        this.view.webview.html = statusHtml("Codex Hub is disabled in VS Code Settings.");
      }
      return;
    }
    if (this.view && !this.disposed) {
      this.renderPromise = this.render();
      void this.renderPromise;
    }
  }

  static resetCurrentServer() {
    CodexHubWorkspaceViewProvider.currentServer = null;
    CodexHubWorkspaceViewProvider.currentServerStart = null;
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
    if (!this.isEnabled()) {
      view.webview.html = statusHtml("Codex Hub is disabled in VS Code Settings.");
      return;
    }
    view.webview.html = statusHtml("Starting Codex Hub...");
    this.renderPromise = this.render();
    void this.renderPromise;
  }

  dispose() {
    void this.shutdown();
  }

  async shutdown() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopHeartbeat();
    this.webviewMessageSubscription?.dispose();
    this.webviewMessageSubscription = null;
    await this.unregisterSurface();
  }

  async refresh() {
    if (!this.view || this.disposed) return;
    if (!this.isEnabled()) {
      this.view.webview.html = statusHtml("Codex Hub is disabled in VS Code Settings.");
      return;
    }
    this.view.webview.html = statusHtml("Refreshing Codex Hub...");
    this.renderPromise = this.render();
    await this.renderPromise;
  }

  async openInBrowser() {
    if (!this.isEnabled()) {
      await vscode.window.showInformationMessage("Codex Hub is disabled in VS Code Settings.");
      return;
    }
    const server = await this.ensureServer();
    const folders = fileWorkspaceFolders();
    if (folders.length) {
      const activeFolder = activeWorkspaceFolder(folders) ?? folders[0];
      await this.registerSurface(server, folders, activeFolder.path);
      await vscode.env.openExternal(await externalServerUri(
        vscodeSurfaceServerUrl(server, folders, activeFolder.path, this.surfaceId)
      ));
      return;
    }
    await vscode.env.openExternal(await externalServerUri(authenticatedServerUrl(server)));
  }

  async openConfig() {
    const configPath = await this.resolveConfigPath();
    await ensureConfigFile(configPath);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async sendSelectionToChat() {
    const attachment = selectedCodeAttachmentFromEditor();
    if (!attachment.ok) {
      await vscode.window.showInformationMessage(attachment.message);
      return;
    }
    await this.sendTextAttachmentsToChat([attachment.text]);
  }

  async sendPathToChat(uri?: vscode.Uri, selectedUris?: vscode.Uri[]) {
    const attachment = pathAttachmentsFromExplorerSelection(uri, selectedUris);
    if (!attachment.ok) {
      await vscode.window.showInformationMessage(attachment.message);
      return;
    }
    await this.sendTextAttachmentsToChat(attachment.texts);
  }

  private async sendTextAttachmentsToChat(texts: string[]) {
    if (!this.isEnabled()) {
      await vscode.window.showInformationMessage("Codex Hub is disabled in VS Code Settings.");
      return;
    }
    const normalized = texts.map((text) => text.trim()).filter(Boolean);
    if (!normalized.length) return;
    if (this.view) {
      this.view.show(false);
    } else {
      await vscode.commands.executeCommand(`${viewId}.focus`);
    }
    const view = await this.waitForView();
    if (!view) {
      await vscode.window.showWarningMessage("Codex Hub view is not available.");
      return;
    }
    await this.renderPromise?.catch(() => undefined);
    await delay(100);

    for (const text of normalized) {
      const delivered = await view.webview.postMessage({
        type: "codexhub.addTextAttachment",
        text
      });
      if (!delivered) {
        await vscode.window.showWarningMessage("Codex Hub could not receive the selected content.");
        return;
      }
    }
  }

  private async handleWebviewMessage(message: unknown) {
    const record = asRecord(message);
    if (record?.type === "codexhub.openFile") {
      await this.openFileFromWebview(record);
      return;
    }
    if (record?.type !== "codexhub.taskCompleteNotification") return;
    const notification = asRecord(record.notification);
    const title = stringValue(notification?.title) ?? "Codex task complete";
    const body = stringValue(notification?.body) ?? "";
    const text = truncateNotificationText(body ? `${title}: ${body}` : title);
    const open = "Open";
    const selected = await vscode.window.showInformationMessage(text, open);
    if (selected !== open) return;
    const threadId = stringValue(notification?.threadId);
    if (threadId) await this.openThreadFromHost(threadId);
    else if (this.view) this.view.show(false);
    else await vscode.commands.executeCommand(`${viewId}.focus`);
  }

  private async openThreadFromHost(threadId: string) {
    if (this.view) this.view.show(false);
    else await vscode.commands.executeCommand(`${viewId}.focus`);
    const view = await this.waitForView();
    if (!view) {
      await vscode.window.showWarningMessage("Codex Hub view is not available.");
      return;
    }
    await this.renderPromise?.catch(() => undefined);
    await delay(100);
    const delivered = await view.webview.postMessage({
      type: "codexhub.openThread",
      threadId
    });
    if (!delivered) {
      await vscode.window.showWarningMessage("Codex Hub could not open the completed thread.");
    }
  }

  private async openFileFromWebview(record: Record<string, unknown>) {
    const filePath = stringValue(record.path);
    if (!filePath || filePath.includes("\0") || !path.isAbsolute(filePath)) return;
    try {
      const selection = editorSelectionFromWebviewMessage(record);
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath), {
        preview: false,
        ...(selection ? { selection } : {})
      });
    } catch (error) {
      await vscode.window.showWarningMessage(`Codex Hub could not open ${path.basename(filePath)}: ${errorText(error)}`);
    }
  }

  private async render() {
    if (!this.view || this.disposed) return;
    if (!this.isEnabled()) {
      this.stopHeartbeat();
      await this.unregisterSurface();
      this.view.webview.html = statusHtml("Codex Hub is disabled in VS Code Settings.");
      return;
    }
    const workspaceFolders = fileWorkspaceFolders();
    if (!workspaceFolders.length) {
      this.stopHeartbeat();
      await this.unregisterSurface();
      this.view.webview.html = statusHtml("Open a folder or workspace to use Codex Hub.");
      return;
    }
    const activeFolder = activeWorkspaceFolder(workspaceFolders) ?? workspaceFolders[0];

    try {
      const server = await this.ensureServer();
      await this.registerSurface(server, workspaceFolders, activeFolder.path);
      const externalIframeUri = await externalServerUri(
        vscodeSurfaceServerUrl(server, workspaceFolders, activeFolder.path, this.surfaceId)
      );
      this.view.webview.html = iframeHtml(externalIframeUri.toString(true), activeFolder.path);
    } catch (error) {
      this.view.webview.html = statusHtml(`Codex Hub failed to start: ${errorText(error)}`);
    }
  }

  private async ensureServer() {
    if (!this.isEnabled()) throw new Error("Codex Hub is disabled in VS Code Settings.");
    const current = CodexHubWorkspaceViewProvider.currentServer;
    if (current) {
      const health = await probeEmbeddedAuthority(current.url, current.authorityId, Boolean(current.authToken));
      if (health) return current;
      CodexHubWorkspaceViewProvider.resetCurrentServer();
    }
    if (!CodexHubWorkspaceViewProvider.currentServerStart) {
      CodexHubWorkspaceViewProvider.currentServerStart = this.startAuthorityService();
    }
    try {
      CodexHubWorkspaceViewProvider.currentServer = await CodexHubWorkspaceViewProvider.currentServerStart;
      return CodexHubWorkspaceViewProvider.currentServer;
    } catch (error) {
      CodexHubWorkspaceViewProvider.resetCurrentServer();
      throw error;
    }
  }

  private async waitForView(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.view && !this.disposed && Date.now() < deadline) {
      await delay(100);
    }
    return this.view;
  }

  private async startAuthorityService(): Promise<VscodeCodexHubServer> {
    const dataDir = embeddedAuthorityDataDirectory();
    await migrateLegacyEmbeddedAuthorityData(this.context.globalStorageUri.fsPath, dataDir).catch((error: unknown) => {
      console.warn(`codexhub vscode could not migrate legacy authority data: ${errorText(error)}`);
    });
    await removeLegacyVscodeAuthorityTokenFile(dataDir).catch((error: unknown) => {
      console.warn(`codexhub vscode could not remove obsolete authority token file: ${errorText(error)}`);
    });
    const staticDirectory = this.context.asAbsolutePath("dist");
    const buildId = await vscodeWindowBuildId(this.context, staticDirectory);
    const configEnv = await readServerConfigEnv(path.join(dataDir, "config.yaml"));
    const authToken = configuredVscodeAuthorityAuthToken(process.env, configEnv);
    return await ensureEmbeddedAuthority({
      dataDir,
      authorityServicePath: this.context.asAbsolutePath("authority-service.cjs"),
      staticDirectory,
      remoteClientPath: this.context.asAbsolutePath("dist-node/ssh/remote-client.cjs"),
      buildId,
      authToken,
      logFileName: "authority.log"
    });
  }

  private async registerSurface(
    server: VscodeCodexHubServer,
    folders: VscodeWorkspaceFolder[],
    activePath: string,
    attempts = 30
  ) {
    const client = createCodexHubApiClient({ baseUrl: server.url, authToken: server.authToken });
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await client.route(apiRoutes.registerEmbeddedSurface, {
          surface: "vscode",
          surfaceId: this.surfaceId,
          leaseId: this.leaseId,
          protocolVersion: embeddedSurfaceProtocolVersion,
          workspacePaths: folders.map((folder) => folder.path),
          activeWorkspacePath: activePath,
          label: vscodeWorkspaceGroupLabel(folders),
          buildId: server.buildId
        });
        this.registeredServerUrl = server.url;
        this.registeredAuthToken = server.authToken;
        this.startHeartbeat();
        if (server.replacementExpected) void delay(500).then(() => this.heartbeat());
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientSurfaceRegistrationError(error) || attempt + 1 >= attempts) break;
        await delay(500);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private startHeartbeat() {
    if (this.heartbeatTimer || this.disposed) return;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), surfaceHeartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async heartbeat() {
    if (this.heartbeatInFlight || this.disposed || !this.registeredServerUrl) return;
    this.heartbeatInFlight = true;
    try {
      const client = createCodexHubApiClient({
        baseUrl: this.registeredServerUrl,
        authToken: this.registeredAuthToken
      });
      await client.route(apiRoutes.heartbeatEmbeddedSurface, this.surfaceId, {
        leaseId: this.leaseId,
        protocolVersion: embeddedSurfaceProtocolVersion
      });
    } catch (error) {
      try {
        CodexHubWorkspaceViewProvider.resetCurrentServer();
        const server = await this.ensureServer();
        const folders = fileWorkspaceFolders();
        if (!folders.length) return;
        const activeFolder = activeWorkspaceFolder(folders) ?? folders[0];
        await this.registerSurface(server, folders, activeFolder.path, 3);
        if (this.view) {
          this.renderPromise = this.render();
          await this.renderPromise;
        }
      } catch (reconnectError) {
        console.error(`codexhub vscode surface reconnect failed: ${errorText(reconnectError || error)}`);
      }
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async unregisterSurface() {
    const serverUrl = this.registeredServerUrl;
    const authToken = this.registeredAuthToken;
    this.registeredServerUrl = "";
    this.registeredAuthToken = "";
    if (!serverUrl) return;
    const client = createCodexHubApiClient({
      baseUrl: serverUrl,
      authToken
    });
    await client.route(apiRoutes.unregisterEmbeddedSurface, this.surfaceId, this.leaseId).catch(() => undefined);
  }

  private async resolveConfigPath() {
    const fallbackPath = path.join(embeddedAuthorityDataDirectory(), "config.yaml");
    if (!this.isEnabled()) return fallbackPath;
    try {
      const server = await this.ensureServer();
      const response = await fetch(new URL("/api/health", server.url));
      if (!response.ok) return fallbackPath;
      const body = asRecord(await response.json().catch(() => null));
      return stringValue(body?.configPath) ?? fallbackPath;
    } catch (error) {
      console.warn(`codexhub vscode config path fallback: ${errorText(error)}`);
      return fallbackPath;
    }
  }
}

type VscodeWorkspaceFolder = {
  path: string;
  name: string;
};

type SelectedCodeAttachment =
  | { ok: true; text: string }
  | { ok: false; message: string };

type PathAttachments =
  | { ok: true; texts: string[] }
  | { ok: false; message: string };

const selectedCodeAttachmentFromEditor = (): SelectedCodeAttachment => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { ok: false, message: "Open a file and select code to send to Codex Hub." };

  const selections = editor.selections
    .filter((selection) => !selection.isEmpty)
    .map((selection) => ({
      selection,
      text: editor.document.getText(selection)
    }))
    .filter((item) => item.text.trim().length > 0);
  if (!selections.length) return { ok: false, message: "Select code to send to Codex Hub." };

  const document = editor.document;
  const documentPath = document.uri.scheme === "file" ? document.uri.fsPath : document.fileName;
  const displayName = path.basename(documentPath || "Untitled");
  const ranges = selections.map((item) => selectionRangeLabel(item.selection));
  const body = selections.length === 1
    ? selections[0].text
    : selections.map((item, index) => [
      `--- Selection ${index + 1}: ${selectionRangeLabel(item.selection)} ---`,
      item.text
    ].join("\n")).join("\n\n");
  const lines = [
    `File: ${displayName}${ranges.length ? `:${ranges.join(",")}` : ""}`,
    document.uri.scheme === "file" ? `Path: ${document.uri.fsPath}` : `Document: ${document.fileName}`,
    document.languageId ? `Language: ${document.languageId}` : null,
    "",
    body
  ];
  const text = lines.filter((line): line is string => line !== null).join("\n");
  if (Buffer.byteLength(text, "utf8") > maxSelectionAttachmentBytes) {
    return {
      ok: false,
      message: "Selected code is larger than 512KB. Send a smaller selection to Codex Hub."
    };
  }
  return { ok: true, text };
};

const pathAttachmentsFromExplorerSelection = (uri?: vscode.Uri, selectedUris?: vscode.Uri[]): PathAttachments => {
  const uris = uniqueUris([
    ...(Array.isArray(selectedUris) && selectedUris.length ? selectedUris : []),
    ...(uri ? [uri] : [])
  ]);
  const paths = uris
    .map(pathTextFromUri)
    .filter((item): item is string => Boolean(item));
  if (!paths.length) {
    return { ok: false, message: "Select a file in Explorer to send its path to Codex Hub." };
  }
  return { ok: true, texts: paths.map((item) => `Path: ${item}`) };
};

const uniqueUris = (uris: vscode.Uri[]) => {
  const seen = new Set<string>();
  return uris.filter((uri) => {
    const key = uri.toString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const pathTextFromUri = (uri: vscode.Uri) => {
  if (uri.scheme === "file") return uri.fsPath;
  return uri.toString(true);
};

const selectionRangeLabel = (selection: vscode.Selection) => {
  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;
  return startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
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

const vscodeWorkspaceGroupLabel = (folders: VscodeWorkspaceFolder[]) => {
  const workspaceName = vscode.workspace.name?.trim();
  if (workspaceName && (folders.length > 1 || workspaceName !== folders[0]?.name)) return `VSCode: ${workspaceName}`;
  const folderName = folders[0]?.name?.trim();
  return folderName ? `VSCode: ${folderName}` : "VSCode Workspace";
};

const vscodeWorkspaceStateScope = (folders: VscodeWorkspaceFolder[]) => createHash("sha256")
  .update(folders.map((folder) => folder.path).sort().join("\0"))
  .digest("hex")
  .slice(0, 24);

const iframeHtml = (src: string, workspacePath: string) => {
  const nonce = randomNonce();
  const sourceOrigin = new URL(src).origin;
  const escapedSource = escapeHtml(src);
  const escapedOrigin = escapeHtml(sourceOrigin);
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
    `<iframe id="codexhubFrame" src="${escapedSource}" title="${escapedTitle}" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"></iframe>`,
    `<script nonce="${nonce}">`,
    buildWebviewBridgeScript(sourceOrigin),
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringValue = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

const positiveInteger = (value: unknown) => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
};

const editorSelectionFromWebviewMessage = (record: Record<string, unknown>) => {
  const line = positiveInteger(record.line);
  if (!line) return undefined;
  const column = positiveInteger(record.column) ?? 1;
  const position = new vscode.Position(line - 1, column - 1);
  return new vscode.Range(position, position);
};

const truncateNotificationText = (value: string) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
};

const ensureConfigFile = async (filePath: string) => {
  try {
    if ((await stat(filePath)).isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, defaultConfigFileText(), { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
};

const defaultConfigFileText = () => [
  "version: 1",
  `updatedAt: "${new Date().toISOString()}"`,
  "config:",
  "  ui:",
  "    taskCompleteSystemNotifications: false",
  "# Shared Node/Electron/authority settings belong in env below; do not put them in VS Code Settings.",
  "env: {}",
  "machines: []",
  "projects: []",
  "tasks: []",
  "sshHosts: []",
  ""
].join("\n");

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
    fileFingerprint(context.asAbsolutePath("authority-service.cjs")),
    fileFingerprint(path.join(staticDirectory, "index.html"))
  ]);
  return `vscode:${id}:${version}:${fingerprints.join(":")}`;
};

const fileFingerprint = async (filePath: string) => {
  try {
    const contents = await readFile(filePath);
    const digest = createHash("sha256").update(contents).digest("hex").slice(0, 20);
    return `${path.basename(filePath)}-${contents.byteLength}-${digest}`;
  } catch {
    return `${path.basename(filePath)}-missing`;
  }
};

const authenticatedServerUrl = (server: VscodeCodexHubServer) => {
  const url = new URL("/", server.url);
  if (server.authToken) url.searchParams.set("codexhub_token", server.authToken);
  return url.toString();
};

const vscodeSurfaceServerUrl = (
  server: VscodeCodexHubServer,
  folders: VscodeWorkspaceFolder[],
  activePath: string,
  surfaceId: string
) => {
  const url = new URL(authenticatedServerUrl(server));
  url.searchParams.set("surface", "vscode");
  url.searchParams.set("surfaceId", surfaceId);
  url.searchParams.set("stateScope", vscodeWorkspaceStateScope(folders));
  url.searchParams.set("workspacePath", activePath);
  for (const folder of folders) url.searchParams.append("workspaceFolder", folder.path);
  return url.toString();
};

const isTransientSurfaceRegistrationError = (error: unknown) =>
  error instanceof CodexHubApiError
  && error.status === 409
  && (
    error.responseText.includes("Local project launcher is still starting")
    || error.responseText.includes("No online codexhub project launcher")
  );

const externalServerUri = async (url: string) => {
  const parsed = new URL(url);
  const external = await vscode.env.asExternalUri(vscode.Uri.from({
    scheme: parsed.protocol.replace(/:$/, ""),
    authority: parsed.host,
    path: parsed.pathname
  }));
  return external.with({
    query: parsed.searchParams.toString(),
    fragment: parsed.hash.replace(/^#/, "")
  });
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
