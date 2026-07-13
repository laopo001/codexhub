import { RpcConnectionHandler } from "@theia/core/lib/common/messaging/proxy-factory";
import { ElectronConnectionHandler } from "@theia/core/lib/electron-main/messaging/electron-connection-handler";
import { ContainerModule } from "@theia/core/shared/inversify";
import {
  codexHubNativeNotificationServicePath,
  type CodexHubNativeNotificationClient,
} from "../common/codexhub-protocol.js";
import { CodexHubNativeNotificationServiceImpl } from "./codexhub-native-notification-service.js";

export default new ContainerModule((bind) => {
  bind(ElectronConnectionHandler).toDynamicValue(() =>
    new RpcConnectionHandler<CodexHubNativeNotificationClient>(
      codexHubNativeNotificationServicePath,
      (client) => new CodexHubNativeNotificationServiceImpl(client),
    ),
  ).inSingletonScope();
});
