import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import {
  embeddedAuthorityDataDirectory,
  migrateLegacyEmbeddedAuthorityData
} from "../../../src/core/authorityPaths.js";
import {
  authorityBuildId,
  ensureEmbeddedAuthority,
  probeEmbeddedAuthority,
  type EmbeddedAuthorityHandle
} from "../../../src/core/embeddedAuthority.js";
import { resolveAuthorityPackage } from "../../../src/core/authorityPackage.js";
import { withUserPath } from "../../../src/core/userPath.js";
import { readServerConfigEnv } from "../../../src/core/serverConfigEnv.js";
import {
  embeddedSurfaceProtocolVersion,
  formatVscodeSurfacePrefix,
  resolveVscodeChannel,
  type VscodeChannel
} from "../../../src/shared/surfaceTypes.js";
import {
  isTaskCompleteNotification,
  taskCompleteNotificationTitle
} from "../../../src/shared/taskNotifications.js";
import { createCodexHubApiClient, CodexHubApiError } from "../../../src/shared/apiClient.js";
import { apiRoutes } from "../../../src/shared/apiRoutes.js";
import {
  configuredVscodeAuthorityAuthToken,
  removeLegacyVscodeAuthorityTokenFile
} from "./authorityAuth.js";
import {
  readVscodeExtensionSettings,
  vscodeToolModel
} from "./settings.js";
import { buildWebviewBridgeScript } from "./webviewBridge.js";
import { VscodeWebviewHtmlController } from "./webviewHtmlController.js";

const viewId = "codexhub.workspaceView";
const surfaceHeartbeatMs = 10_000;
const maxSelectionAttachmentBytes = 512 * 1024;
const maxCommitDiffCharacters = 96_000;

type GitSourceControl = {
  rootUri?: vscode.Uri;
};

type GitRepository = {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  diff: (cached?: boolean) => Promise<string>;
  state: {
    indexChanges: Array<{ uri: vscode.Uri }>;
    workingTreeChanges: Array<{ uri: vscode.Uri }>;
    untrackedChanges: Array<{ uri: vscode.Uri }>;
  };
};

type GitApi = {
  repositories: GitRepository[];
  getRepository: (uri: vscode.Uri) => GitRepository | null;
};

const currentVscodeExtensionSettings = () => readVscodeExtensionSettings(
  vscode.workspace.getConfiguration("codexhub")
);

type VscodeCodexHubServer = EmbeddedAuthorityHandle;

let activeProvider: CodexHubWorkspaceViewProvider | null = null;

export function activate(context: vscode.ExtensionContext) {
  const provider = new CodexHubWorkspaceViewProvider(context);
  activeProvider = provider;
  void vscode.commands.executeCommand("setContext", "codexhub.commitMessageGenerating", false);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("codexhub.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("codexhub.openInBrowser", () => provider.openInBrowser()),
    vscode.commands.registerCommand("codexhub.openConfig", () => provider.openConfig()),
    vscode.commands.registerCommand("codexhub.sendSelectionToChat", () => provider.sendSelectionToChat()),
    vscode.commands.registerCommand("codexhub.sendPathToChat", (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => provider.sendPathToChat(uri, selectedUris)),
    vscode.commands.registerCommand("codexhub.generateCommitMessage", (sourceControl?: GitSourceControl) => provider.generateCommitMessage(sourceControl)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
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
  private readonly htmlController = new VscodeWebviewHtmlController((html) => {
    if (this.view && !this.disposed) {
      this.view.webview.html = html;
    }
  });

  constructor(private readonly context: vscode.ExtensionContext) {}

  static resetCurrentServer() {
    CodexHubWorkspaceViewProvider.currentServer = null;
    CodexHubWorkspaceViewProvider.currentServerStart = null;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.htmlController.reset();
    this.webviewMessageSubscription?.dispose();
    this.webviewMessageSubscription = view.webview.onDidReceiveMessage((message) => {
      void this.handleWebviewMessage(message);
    });
    view.webview.options = {
      enableScripts: true
    };
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
    this.renderPromise = this.render({ forceHtml: true });
    await this.renderPromise;
  }

  async openInBrowser() {
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

  async generateCommitMessage(sourceControl?: GitSourceControl) {
    const git = await gitApi();
    if (!git) {
      await vscode.window.showErrorMessage("Codex Hub could not access the built-in Git extension.");
      return;
    }
    const repository = sourceControl?.rootUri
      ? git.getRepository(sourceControl.rootUri)
      : await selectGitRepository(git.repositories);
    if (!repository) return;

    let failureMessage: string | null = null;
    await vscode.commands.executeCommand("setContext", "codexhub.commitMessageGenerating", true);
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.SourceControl,
        title: `Codex Hub: Generating commit message for ${path.basename(repository.rootUri.fsPath) || "repository"}...`
      }, async () => {
        const diff = await commitGenerationDiff(repository);
        if (!diff) {
          void vscode.window.showInformationMessage("Codex Hub found no Git changes to describe.");
          return;
        }
        const server = await this.ensureServer();
        const folders = fileWorkspaceFolders();
        const activeFolder = workspaceFolderForPath(folders, repository.rootUri.fsPath)
          ?? activeWorkspaceFolder(folders)
          ?? folders[0];
        if (!activeFolder) throw new Error("Open a workspace folder before generating a commit message.");
        await this.registerSurface(server, folders, activeFolder.path);
        const client = createCodexHubApiClient({ baseUrl: server.url, authToken: server.authToken });
        const projects = await client.route(apiRoutes.projects);
        const project = projects.projects.find((candidate) => sameFsPath(candidate.path, activeFolder.path));
        if (!project) throw new Error(`Codex Hub project is not registered for ${activeFolder.path}`);
        await client.route(apiRoutes.ensureRuntime, project.machineId, { cwd: repository.rootUri.fsPath });
        const generationSettings = currentVscodeExtensionSettings();
        const result = await client.route(apiRoutes.generateCommitMessage, project.machineId, {
          cwd: repository.rootUri.fsPath,
          diff,
          model: vscodeToolModel(generationSettings, generationSettings.gitCommitModel),
          prompt: generationSettings.gitCommitPrompt,
          ...(repository.inputBox.value.trim() ? { currentMessage: repository.inputBox.value.trim() } : {})
        });
        const message = result.message?.trim();
        if (!message) throw new Error(result.error || "Codex did not generate a commit message.");
        repository.inputBox.value = message;
      });
    } catch (error) {
      failureMessage = error instanceof CodexHubApiError && error.status === 404
        ? "The shared Codex Hub authority is still running an older build without commit-message generation. Reload every VS Code or Electron window using Codex Hub, then try again."
        : errorText(error);
    } finally {
      await vscode.commands.executeCommand("setContext", "codexhub.commitMessageGenerating", false);
    }
    if (failureMessage) {
      void vscode.window.showErrorMessage(`Codex Hub commit message generation failed: ${failureMessage}`);
    }
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
    const notification = isTaskCompleteNotification(record.notification) ? record.notification : null;
    const rawNotification = asRecord(record.notification);
    const title = notification
      ? taskCompleteNotificationTitle(notification)
      : stringValue(rawNotification?.title) ?? "Codex 任务已完成";
    const body = notification?.body ?? stringValue(rawNotification?.body) ?? "";
    const text = truncateNotificationText(body ? `${title} · ${body}` : title);
    const open = "Open";
    const selected = await vscode.window.showInformationMessage(text, open);
    if (selected !== open) return;
    const threadId = notification?.threadId ?? stringValue(rawNotification?.threadId);
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

  private setWebviewHtml(key: string, html: string, force = false) {
    if (!this.view || this.disposed) return;
    this.htmlController.update(key, html, force);
  }

  private async render(options?: { forceHtml?: boolean }) {
    if (!this.view || this.disposed) return;
    const forceHtml = Boolean(options?.forceHtml);
    const workspaceFolders = fileWorkspaceFolders();
    if (!workspaceFolders.length) {
      this.stopHeartbeat();
      await this.unregisterSurface();
      this.setWebviewHtml("no-workspace", statusHtml("Open a folder or workspace to use Codex Hub."), forceHtml);
      return;
    }
    const activeFolder = activeWorkspaceFolder(workspaceFolders) ?? workspaceFolders[0];

    const loadingTimer = setTimeout(() => {
      if (!this.htmlController.currentKey && this.view && !this.disposed) {
        this.setWebviewHtml("loading", statusHtml("Starting Codex Hub..."), forceHtml);
      }
    }, 800);

    try {
      const server = await this.ensureServer();
      await this.registerSurface(server, workspaceFolders, activeFolder.path);
      const externalIframeUri = await externalServerUri(
        vscodeSurfaceServerUrl(server, workspaceFolders, activeFolder.path, this.surfaceId)
      );
      const iframeSrc = externalIframeUri.toString(true);
      this.setWebviewHtml(`iframe:${iframeSrc}`, iframeHtml(iframeSrc, activeFolder.path), forceHtml);
    } catch (error) {
      this.setWebviewHtml(`error:${errorText(error)}`, statusHtml(`Codex Hub failed to start: ${errorText(error)}`), forceHtml);
    } finally {
      clearTimeout(loadingTimer);
    }
  }

  private async ensureServer() {
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
    const configEnv = await readServerConfigEnv(path.join(dataDir, "config.yaml"));
    const environment = await withUserPath({ ...(configEnv ?? {}), ...process.env });
    const packageResolution = await resolveAuthorityPackage({
      authorityServicePath: this.context.asAbsolutePath("authority-service.cjs"),
      staticDirectory: this.context.asAbsolutePath("dist"),
      remoteClientPath: this.context.asAbsolutePath("dist-node/ssh/remote-client.cjs")
    }, environment);
    const staticDirectory = packageResolution.staticDirectory;
    const buildId = packageResolution.source === "bundled"
      ? await vscodeWindowBuildId(this.context, staticDirectory)
      : await authorityBuildId([
        packageResolution.authorityServicePath,
        path.join(staticDirectory, "index.html")
      ], "npm");
    const authToken = configuredVscodeAuthorityAuthToken(process.env, configEnv);
    return await ensureEmbeddedAuthority({
      dataDir,
      authorityServicePath: packageResolution.authorityServicePath,
      staticDirectory,
      remoteClientPath: packageResolution.remoteClientPath,
      buildId,
      authToken,
      logFileName: "authority.log",
      // Keep shell/.env/CLI values authoritative while allowing the shared
      // config.yaml to select the Node executable for the first client.
      environment,
      authorityServiceSource: packageResolution.source
    });
  }

  private async registerSurface(
    server: VscodeCodexHubServer,
    folders: VscodeWorkspaceFolder[],
    activePath: string,
    attempts = 30
  ) {
    const client = createCodexHubApiClient({ baseUrl: server.url, authToken: server.authToken });
    const vscodeChannel = resolveVscodeChannel(vscode.env.uriScheme, vscode.env.appName) ?? undefined;
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
          label: vscodeWorkspaceGroupLabel(folders, vscodeChannel),
          buildId: server.buildId,
          ...(vscodeChannel ? { vscodeChannel } : {})
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
          // The authority can restart on the same stable URL, so an ordinary
          // render would be deduplicated and leave the old iframe document
          // (including its local "Restarting..." state) mounted forever.
          // A failed heartbeat followed by successful re-registration is the
          // host's authoritative recovery signal and must reload once.
          this.renderPromise = this.render({ forceHtml: true });
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

const gitApi = async (): Promise<GitApi | null> => {
  const extension = vscode.extensions.getExtension<{ getAPI: (version: 1) => GitApi }>("vscode.git");
  if (!extension) return null;
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports?.getAPI(1) ?? null;
};

const selectGitRepository = async (repositories: GitRepository[]) => {
  if (!repositories.length) {
    await vscode.window.showInformationMessage("Codex Hub found no Git repositories in this workspace.");
    return null;
  }
  if (repositories.length === 1) return repositories[0];
  const selected = await vscode.window.showQuickPick(
    repositories.map((repository) => ({
      label: path.basename(repository.rootUri.fsPath) || repository.rootUri.fsPath,
      description: repository.rootUri.fsPath,
      repository
    })),
    { placeHolder: "Select a repository for commit message generation" }
  );
  return selected?.repository ?? null;
};

const commitGenerationDiff = async (repository: GitRepository) => {
  const staged = (await repository.diff(true)).trim();
  if (staged) return truncateCommitDiff(`Staged changes:\n${staged}`);
  const working = (await repository.diff(false)).trim();
  const untracked = repository.state.untrackedChanges.map((change) =>
    path.relative(repository.rootUri.fsPath, change.uri.fsPath) || path.basename(change.uri.fsPath)
  );
  if (working) {
    return truncateCommitDiff([
      `Working tree changes:\n${working}`,
      untracked.length ? `Untracked files:\n${untracked.map((file) => `- ${file}`).join("\n")}` : null
    ].filter((value): value is string => Boolean(value)).join("\n\n"));
  }
  if (untracked.length) return truncateCommitDiff(`Untracked files:\n${untracked.map((file) => `- ${file}`).join("\n")}`);
  return "";
};

const truncateCommitDiff = (value: string) => value.length <= maxCommitDiffCharacters
  ? value
  : `${value.slice(0, maxCommitDiffCharacters)}\n\n[Diff truncated by Codex Hub]`;

const workspaceFolderForPath = (folders: VscodeWorkspaceFolder[], candidatePath: string) =>
  folders.find((folder) => {
    const relative = path.relative(folder.path, candidatePath);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
  });

const sameFsPath = (left: string, right: string) => {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const activeWorkspaceFolder = (folders: VscodeWorkspaceFolder[]) => {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  return activeFolder?.uri.scheme === "file"
    ? folders.find((folder) => folder.path === activeFolder.uri.fsPath)
    : undefined;
};

const vscodeWorkspaceGroupLabel = (folders: VscodeWorkspaceFolder[], channel?: VscodeChannel) => {
  const prefix = formatVscodeSurfacePrefix(channel);
  const workspaceName = vscode.workspace.name?.trim();
  if (workspaceName && (folders.length > 1 || workspaceName !== folders[0]?.name)) return `${prefix}: ${workspaceName}`;
  const folderName = folders[0]?.name?.trim();
  return folderName ? `${prefix}: ${folderName}` : `${prefix} Workspace`;
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
