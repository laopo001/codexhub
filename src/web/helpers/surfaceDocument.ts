import type { CodexHubSurface } from "../../shared/surfaceTypes.js";

export const surfaceDocumentUsesPersistentState = (input: {
  surface: CodexHubSurface;
  nativeElectron: boolean;
  topLevel: boolean;
}) => input.surface === "default"
  || input.nativeElectron
  || (input.surface === "vscode" && !input.topLevel);
