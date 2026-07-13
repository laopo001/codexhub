import { BrowserWindow, Notification, webContents } from "@theia/electron/shared/electron";
import type { RpcProxy } from "@theia/core/lib/common/messaging/proxy-factory";
import type {
  CodexHubNativeNotificationClient,
  CodexHubNativeNotificationInput,
  CodexHubNativeNotificationService,
} from "../common/codexhub-protocol.js";

export type CodexHubNotificationWindow = {
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
};

export type CodexHubNativeNotificationHandle = {
  close(): void;
  onClick(listener: () => void): void;
  onClose(listener: () => void): void;
  onFailed(listener: (error: string) => void): void;
  show(): void;
};

export type CodexHubNativeNotificationRuntime = {
  create(options: {
    id: string;
    groupId: string;
    groupTitle: string;
    title: string;
    body: string;
    timeoutType: "never";
  }): CodexHubNativeNotificationHandle;
  isSupported(): boolean;
  resolveWindow(windowId: number): CodexHubNotificationWindow | null;
};

export class CodexHubNativeNotificationServiceImpl implements CodexHubNativeNotificationService {
  private readonly activeNotifications = new Set<CodexHubNativeNotificationHandle>();

  constructor(
    private readonly client: RpcProxy<CodexHubNativeNotificationClient>,
    private readonly runtime: CodexHubNativeNotificationRuntime = electronNotificationRuntime,
  ) {
    client.onDidCloseConnection(() => {
      for (const notification of this.activeNotifications) notification.close();
      this.activeNotifications.clear();
    });
  }

  async isSupported(): Promise<boolean> {
    return this.runtime.isSupported();
  }

  async show(input: CodexHubNativeNotificationInput): Promise<boolean> {
    if (!this.runtime.isSupported()) return false;
    const windowId = Number(input.windowId);
    const threadId = input.notification.threadId.trim();
    if (!Number.isInteger(windowId) || windowId <= 0 || !threadId) return false;
    const targetWindow = this.runtime.resolveWindow(windowId);
    if (!targetWindow || targetWindow.isDestroyed()) return false;

    const notification = this.runtime.create({
      id: `codexhub-${windowId}-${threadId}`,
      groupId: `codexhub-${threadId}`,
      groupTitle: "Codex Hub",
      title: input.notification.title,
      body: input.notification.body,
      timeoutType: "never",
    });
    this.activeNotifications.add(notification);
    const release = () => this.activeNotifications.delete(notification);
    notification.onClose(release);
    notification.onFailed((error) => {
      release();
      console.error(`Codex Hub native notification failed: ${error}`);
    });
    notification.onClick(() => {
      if (targetWindow.isDestroyed()) return;
      if (targetWindow.isMinimized()) targetWindow.restore();
      targetWindow.show();
      targetWindow.focus();
      this.client.openThread(threadId);
      release();
    });
    notification.show();
    return true;
  }
}

const electronNotificationRuntime: CodexHubNativeNotificationRuntime = {
  isSupported: () => Notification.isSupported(),
  resolveWindow: (windowId) => {
    const contents = webContents.fromId(windowId);
    if (!contents || contents.isDestroyed()) return null;
    return BrowserWindow.fromWebContents(contents);
  },
  create: (options) => {
    const notification = new Notification(options);
    return {
      close: () => notification.close(),
      onClick: (listener) => notification.once("click", listener),
      onClose: (listener) => notification.once("close", listener),
      onFailed: (listener) => notification.once("failed", (_event, error) => listener(error)),
      show: () => notification.show(),
    };
  },
};
