import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { ServerHandle } from "../../../src/server/index.js";
import { startEmbeddedServer } from "../../../src/server/embedded.js";

const viewId = "codexhub.workspaceView";
const vscodeWorkspaceGroupId = "workspace";
const maxSelectionAttachmentBytes = 512 * 1024;

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
    vscode.commands.registerCommand("codexhub.openConfig", () => provider.openConfig()),
    vscode.commands.registerCommand("codexhub.sendSelectionToChat", () => provider.sendSelectionToChat()),
    vscode.commands.registerCommand("codexhub.sendPathToChat", (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => provider.sendPathToChat(uri, selectedUris)),
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
  private renderPromise: Promise<void> | null = null;
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
    this.renderPromise = this.render();
    void this.renderPromise;
  }

  dispose() {
    this.disposed = true;
    this.webviewMessageSubscription?.dispose();
    this.webviewMessageSubscription = null;
  }

  async refresh() {
    if (!this.view || this.disposed) return;
    this.view.webview.html = statusHtml("Refreshing Codex Hub...");
    this.renderPromise = this.render();
    await this.renderPromise;
  }

  async openInBrowser() {
    const server = await this.ensureServer();
    await vscode.env.openExternal(await externalServerUri(server.url));
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
    if (this.view) this.view.show(false);
    else await vscode.commands.executeCommand(`${viewId}.focus`);
  }

  private async openFileFromWebview(record: Record<string, unknown>) {
    const filePath = stringValue(record.path);
    if (!filePath || filePath.includes("\0") || !path.isAbsolute(filePath)) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const selection = documentSelectionFromWebviewMessage(document, record);
      await vscode.window.showTextDocument(document, {
        preview: false,
        ...(selection ? { selection } : {})
      });
    } catch (error) {
      await vscode.window.showWarningMessage(`Codex Hub could not open ${path.basename(filePath)}: ${errorText(error)}`);
    }
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
      const externalIframeUri = await externalServerUri(iframeUrl.toString());
      this.view.webview.html = iframeHtml(externalIframeUri.toString(), activeFolder.path);
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

  private async waitForView(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.view && !this.disposed && Date.now() < deadline) {
      await delay(100);
    }
    return this.view;
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
      dataDir: this.context.globalStorageUri.fsPath,
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

  private async resolveConfigPath() {
    const fallbackPath = path.join(this.context.globalStorageUri.fsPath, "config.yaml");
    try {
      const server = await this.ensureServer();
      const response = await fetch(new URL("/api/health", server.url));
      if (!response.ok) return fallbackPath;
      const body = asRecord(await response.json().catch(() => null));
      return stringValue(body?.configPath) ?? stringValue(body?.statePath) ?? fallbackPath;
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
      const machineId = await vscodeLocalMachineId(serverUrl);
      const response = await fetch(new URL("/api/projects/open", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machineId,
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

const vscodeLocalMachineId = async (serverUrl: string) => {
  const response = await fetch(new URL("/api/machines", serverUrl));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const body = asRecord(await response.json().catch(() => null));
  const machines = Array.isArray(body?.machines) ? body.machines : [];
  for (const item of machines) {
    const machine = asRecord(item);
    const capabilities = asRecord(machine?.capabilities);
    const machineId = stringValue(machine?.machineId);
    if (
      machineId
      && machine?.type === "local"
      && machine?.online === true
      && capabilities?.projectLauncher !== false
    ) {
      return machineId;
    }
  }
  throw new Error("No online VSCode local project launcher.");
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
  const sourceOrigin = new URL(src).origin;
  const escapedSource = escapeHtml(src);
  const escapedOrigin = escapeHtml(sourceOrigin);
  const scriptOrigin = JSON.stringify(sourceOrigin).replaceAll("<", "\\u003c");
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
    "const vscode = acquireVsCodeApi();",
    "const codexhubFrame = document.getElementById('codexhubFrame');",
    `const codexhubOrigin = ${scriptOrigin};`,
    "const pendingCodexHubMessages = [];",
    "let codexhubFrameLoaded = false;",
    "const postToCodexHubFrame = (data) => {",
    "  if (!codexhubFrameLoaded) {",
    "    pendingCodexHubMessages.push(data);",
    "    return;",
    "  }",
    "  codexhubFrame.contentWindow?.postMessage(data, codexhubOrigin);",
    "};",
    "codexhubFrame.addEventListener('load', () => {",
    "  codexhubFrameLoaded = true;",
    "  while (pendingCodexHubMessages.length) postToCodexHubFrame(pendingCodexHubMessages.shift());",
    "});",
    "window.addEventListener('message', (event) => {",
    "  const data = event.data;",
    "  if (!data) return;",
    "  if (event.source === codexhubFrame.contentWindow && event.origin === codexhubOrigin) {",
    "    if (data.type !== 'codexhub.taskCompleteNotification' && data.type !== 'codexhub.openFile') return;",
    "    vscode.postMessage(data);",
    "    return;",
    "  }",
    "  if (data.type === 'codexhub.addTextAttachment') postToCodexHubFrame(data);",
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringValue = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

const positiveInteger = (value: unknown) => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
};

const documentSelectionFromWebviewMessage = (
  document: vscode.TextDocument,
  record: Record<string, unknown>
) => {
  const line = positiveInteger(record.line);
  if (!line) return undefined;
  const lineIndex = Math.min(document.lineCount - 1, line - 1);
  const column = positiveInteger(record.column) ?? 1;
  const character = Math.min(document.lineAt(lineIndex).text.length, column - 1);
  const position = new vscode.Position(lineIndex, character);
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

const externalServerUri = async (url: string) => {
  const parsed = new URL(url);
  const external = await vscode.env.asExternalUri(vscode.Uri.from({
    scheme: parsed.protocol.replace(/:$/, ""),
    authority: parsed.host,
    path: parsed.pathname
  }));
  const externalUrl = new URL(external.toString());
  externalUrl.search = parsed.search;
  externalUrl.hash = parsed.hash;
  return vscode.Uri.parse(externalUrl.toString());
};

const parsePort = (value: string | undefined) => {
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
