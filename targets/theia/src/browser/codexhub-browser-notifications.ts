import { Emitter } from "@theia/core/lib/common/event";
import type {
  CodexHubHostNotificationService,
  CodexHubTaskCompleteNotification,
} from "../common/codexhub-protocol.js";

export class CodexHubBrowserNotificationService implements CodexHubHostNotificationService {
  private readonly openThreadEmitter = new Emitter<string>();
  readonly onDidOpenThread = this.openThreadEmitter.event;

  constructor(private readonly activateView: () => Promise<void>) {}

  async requestPermission(): Promise<boolean> {
    const NotificationApi = window.Notification;
    if (!NotificationApi) return false;
    if (NotificationApi.permission === "granted") return true;
    if (NotificationApi.permission !== "default") return false;
    return await NotificationApi.requestPermission() === "granted";
  }

  async show(notification: CodexHubTaskCompleteNotification): Promise<boolean> {
    if (!await this.requestPermission()) return false;
    const browserNotification = new window.Notification(notification.title, {
      body: notification.body,
      tag: `codexhub-task-complete:${notification.threadId}`,
    });
    browserNotification.onclick = () => {
      window.focus();
      void this.openThread(notification.threadId);
      browserNotification.close();
    };
    return true;
  }

  private async openThread(threadId: string) {
    await this.activateView();
    this.openThreadEmitter.fire(threadId);
  }
}
