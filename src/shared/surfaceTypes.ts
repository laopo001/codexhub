export type CodexHubSurface = "default" | "vscode" | "theia";
export type EmbeddedCodexHubSurface = Exclude<CodexHubSurface, "default">;

export const isCodexHubSurface = (value: unknown): value is CodexHubSurface =>
  value === "default" || value === "vscode" || value === "theia";

export const isEmbeddedCodexHubSurface = (
  surface: CodexHubSurface
): surface is EmbeddedCodexHubSurface => surface !== "default";
