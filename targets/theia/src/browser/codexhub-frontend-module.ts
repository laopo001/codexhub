import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { bindViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { MessageService } from "@theia/core/lib/common/message-service";
import { OpenerService } from "@theia/core/lib/browser/opener-service";
import { WebSocketConnectionProvider } from "@theia/core/lib/browser/messaging/ws-connection-provider";
import { ContainerModule, decorate, injectable } from "@theia/core/shared/inversify";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import {
  codexHubBackendServicePath,
  CodexHubBackendService,
  CodexHubHostNotificationService,
} from "../common/codexhub-protocol.js";
import { CodexHubBrowserNotificationService } from "./codexhub-browser-notifications.js";
import { CodexHubViewContribution } from "./codexhub-view-contribution.js";
import { CodexHubWidget, codexHubWidgetId } from "./codexhub-widget.js";

decorate(injectable(), CodexHubViewContribution);

export default new ContainerModule((bind) => {
  bind(CodexHubBackendService).toDynamicValue((context) =>
    WebSocketConnectionProvider.createProxy(context.container, codexHubBackendServicePath),
  ).inSingletonScope();
  bind(CodexHubHostNotificationService).toDynamicValue((context) =>
    new CodexHubBrowserNotificationService(async () => {
      await context.container.get(CodexHubViewContribution).openView({ activate: true });
    }),
  ).inSingletonScope();
  bind(CodexHubWidget).toDynamicValue((context) => new CodexHubWidget(
    context.container.get(CodexHubBackendService),
    context.container.get(WorkspaceService),
    context.container.get(CodexHubHostNotificationService),
    context.container.get(OpenerService),
    context.container.get(ApplicationShell),
    context.container.get(MessageService),
  ));
  bind(WidgetFactory).toDynamicValue((context) => ({
    id: codexHubWidgetId,
    createWidget: () => context.container.get(CodexHubWidget),
  })).inSingletonScope();
  bindViewContribution(bind, CodexHubViewContribution);
});
