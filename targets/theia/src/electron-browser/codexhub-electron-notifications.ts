import { Emitter } from "@theia/core/lib/common/event";
import "@theia/core/lib/electron-common/electron-api";
import type {
  CodexHubHostNotificationService,
  CodexHubNativeNotificationService,
  CodexHubTaskCompleteNotification,
} from "../common/codexhub-protocol.js";

export class CodexHubElectronNotificationService implements CodexHubHostNotificationService {
  private readonly openThreadEmitter = new Emitter<string>();
  readonly onDidOpenThread = this.openThreadEmitter.event;

  constructor(
    private readonly nativeNotifications: CodexHubNativeNotificationService,
    private readonly activateView: () => Promise<void>,
  ) {}

  openThread(threadId: string) {
    void this.activateView().then(() => {
      this.openThreadEmitter.fire(threadId);
    });
  }

  async requestPermission(): Promise<boolean> {
    return this.nativeNotifications.isSupported();
  }

  async show(notification: CodexHubTaskCompleteNotification): Promise<boolean> {
    return this.nativeNotifications.show({
      windowId: window.electronTheiaCore.WindowMetadata.webcontentId,
      notification,
    });
  }
}
