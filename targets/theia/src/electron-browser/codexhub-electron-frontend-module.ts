import { ElectronIpcConnectionProvider } from "@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source";
import { ContainerModule, type interfaces } from "@theia/core/shared/inversify";
import {
  codexHubNativeNotificationServicePath,
  CodexHubHostNotificationService,
  type CodexHubNativeNotificationClient,
  type CodexHubNativeNotificationService,
} from "../common/codexhub-protocol.js";
import { CodexHubViewContribution } from "../browser/codexhub-view-contribution.js";
import { CodexHubElectronNotificationService } from "./codexhub-electron-notifications.js";

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
  const createService = (context: interfaces.Context) => {
    let service: CodexHubElectronNotificationService;
    const client: CodexHubNativeNotificationClient = {
      openThread: (threadId) => service.openThread(threadId),
    };
    const proxy = ElectronIpcConnectionProvider.createProxy<CodexHubNativeNotificationService>(
      context.container,
      codexHubNativeNotificationServicePath,
      client,
    );
    service = new CodexHubElectronNotificationService(proxy, async () => {
      await context.container.get(CodexHubViewContribution).openView({ activate: true });
    });
    return service;
  };
  if (isBound(CodexHubHostNotificationService)) {
    rebind(CodexHubHostNotificationService).toDynamicValue(createService).inSingletonScope();
  } else {
    bind(CodexHubHostNotificationService).toDynamicValue(createService).inSingletonScope();
  }
});
