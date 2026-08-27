import type { CodexHubSurface } from "../../shared/surfaceTypes.js";

export const hostManagesSurfaceDocument = (input: {
  surface: CodexHubSurface;
  nativeElectron: boolean;
  topLevel: boolean;
}) => input.nativeElectron || (input.surface === "vscode" && !input.topLevel);
