import { AbstractViewContribution } from "@theia/core/lib/browser/shell/view-contribution";
import { CodexHubWidget, codexHubWidgetId } from "./codexhub-widget.js";

export class CodexHubViewContribution extends AbstractViewContribution<CodexHubWidget> {
  constructor() {
    super({
      widgetId: codexHubWidgetId,
      widgetName: "Codex Hub",
      defaultWidgetOptions: {
        area: "left",
        rank: 40,
      },
      toggleCommandId: "codexhub.theia.toggle",
    });
  }
}
