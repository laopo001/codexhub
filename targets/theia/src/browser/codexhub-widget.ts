import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { BaseWidget } from "@theia/core/lib/browser/widgets/widget";
import { MessageService } from "@theia/core/lib/common/message-service";
import { Disposable } from "@theia/core/lib/common/disposable";
import URI from "@theia/core/lib/common/uri";
import { codicon, open, OpenerService } from "@theia/core/lib/browser";
import { Message } from "@theia/core/shared/@lumino/messaging";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import type {
  CodexHubBackendService,
  CodexHubHostNotificationService,
  CodexHubTaskCompleteNotification,
} from "../common/codexhub-protocol.js";

export const codexHubWidgetId = "codexhub.theia.workspace";

export class CodexHubWidget extends BaseWidget {
  private readonly frame = document.createElement("iframe");
  private readonly status = document.createElement("div");
  private frameOrigin = "";
  private frameLoaded = false;
  private pendingFrameMessages: unknown[] = [];
  private startVersion = 0;

  constructor(
    private readonly backend: CodexHubBackendService,
    private readonly workspaceService: WorkspaceService,
    private readonly notifications: CodexHubHostNotificationService,
    private readonly openerService: OpenerService,
    private readonly shell: ApplicationShell,
    private readonly messageService: MessageService,
  ) {
    super();
    this.id = codexHubWidgetId;
    this.title.label = "Codex Hub";
    this.title.caption = "Codex Hub";
    this.title.iconClass = codicon("hubot");
    this.title.closable = true;
    this.node.tabIndex = 0;
    this.node.style.position = "relative";
    this.node.style.overflow = "hidden";
    this.node.style.height = "100%";

    this.status.textContent = "Starting Codex Hub...";
    this.status.style.padding = "14px";
    this.status.style.lineHeight = "1.45";
    this.frame.title = "Codex Hub";
    this.frame.style.display = "none";
    this.frame.style.width = "100%";
    this.frame.style.height = "100%";
    this.frame.style.border = "0";
    this.frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-downloads");
    this.node.append(this.status, this.frame);

    const handleMessage = (event: MessageEvent) => this.handleFrameMessage(event);
    window.addEventListener("message", handleMessage);
    this.toDispose.push(Disposable.create(() => window.removeEventListener("message", handleMessage)));

    const handleLoad = () => {
      this.frameLoaded = true;
      const pending = this.pendingFrameMessages;
      this.pendingFrameMessages = [];
      for (const message of pending) this.postToFrame(message);
    };
    this.frame.addEventListener("load", handleLoad);
    this.toDispose.push(Disposable.create(() => this.frame.removeEventListener("load", handleLoad)));
    this.toDispose.push(this.notifications.onDidOpenThread((threadId) => {
      void this.openThread(threadId);
    }));
    this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => {
      void this.start();
    }));
    this.toDispose.push(Disposable.create(() => {
      void this.backend.stop();
    }));

    void this.start();
  }

  protected override onActivateRequest(message: Message): void {
    super.onActivateRequest(message);
    this.frame.focus();
  }

  private async start() {
    const version = ++this.startVersion;
    this.showStatus("Starting Codex Hub...");
    try {
      await this.workspaceService.ready;
      const roots = await this.workspaceService.roots;
      const workspacePaths = roots.map((root) => root.resource.path.fsPath()).filter(Boolean);
      if (!workspacePaths.length) {
        await this.backend.stop();
        if (version === this.startVersion) this.showStatus("Open a folder or workspace to use Codex Hub.");
        return;
      }
      const activeWorkspacePath = this.workspaceService.workspace?.resource.path.fsPath() || workspacePaths[0];
      const workspaceLabel = roots.map((root) => root.name).filter(Boolean).join(", ");
      const server = await this.backend.start({ workspacePaths, activeWorkspacePath, workspaceLabel });
      if (version !== this.startVersion) return;
      const frameUrl = new URL("/", server.url);
      frameUrl.searchParams.set("surface", "theia");
      frameUrl.searchParams.set("workspacePath", activeWorkspacePath);
      for (const workspacePath of workspacePaths) frameUrl.searchParams.append("workspaceFolder", workspacePath);
      this.frameOrigin = frameUrl.origin;
      this.frameLoaded = false;
      this.pendingFrameMessages = [];
      this.frame.src = frameUrl.toString();
      this.status.style.display = "none";
      this.frame.style.display = "block";
    } catch (error) {
      if (version !== this.startVersion) return;
      const message = error instanceof Error ? error.message : String(error);
      this.showStatus(`Codex Hub failed to start: ${message}`);
      void this.messageService.error(`Codex Hub failed to start: ${message}`);
    }
  }

  private showStatus(message: string) {
    this.status.textContent = message;
    this.status.style.display = "block";
    this.frame.style.display = "none";
  }

  private handleFrameMessage(event: MessageEvent) {
    if (event.source !== this.frame.contentWindow || event.origin !== this.frameOrigin) return;
    const record = asRecord(event.data);
    if (record?.type === "codexhub.taskCompleteNotification") {
      const notification = taskCompleteNotification(record.notification);
      if (notification) void this.notifications.show(notification);
      return;
    }
    if (record?.type === "codexhub.requestNotificationPermission") {
      void this.notifications.requestPermission();
      return;
    }
    if (record?.type === "codexhub.openFile") {
      const filePath = stringValue(record.path);
      if (filePath) void open(this.openerService, URI.fromFilePath(filePath));
    }
  }

  private async openThread(threadId: string) {
    const normalized = threadId.trim();
    if (!normalized) return;
    await this.shell.revealWidget(this.id);
    await this.shell.activateWidget(this.id);
    this.postToFrame({ type: "codexhub.openThread", threadId: normalized });
  }

  private postToFrame(message: unknown) {
    if (!this.frameLoaded) {
      this.pendingFrameMessages.push(message);
      return;
    }
    this.frame.contentWindow?.postMessage(message, this.frameOrigin);
  }
}

const taskCompleteNotification = (value: unknown): CodexHubTaskCompleteNotification | null => {
  const record = asRecord(value);
  const title = stringValue(record?.title);
  const body = stringValue(record?.body);
  const threadId = stringValue(record?.threadId);
  if (!title || !body || !threadId) return null;
  const duration = stringValue(record?.duration) || undefined;
  return { title, body, threadId, duration };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringValue = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : "";
