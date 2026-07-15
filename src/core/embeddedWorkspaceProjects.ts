import { CodexHubApiError, createCodexHubApiClient } from "../shared/apiClient.js";
import { apiRoutes } from "../shared/apiRoutes.js";
import type { ProjectSource } from "../shared/projectTypes.js";

export type EmbeddedWorkspaceProjectsInput = {
  serverUrl: string;
  workspacePaths: string[];
  activeWorkspacePath?: string;
  source: ProjectSource;
  attempts?: number;
  retryDelayMs?: number;
};

const launcherUnavailableMessages = [
  "No online codexhub project launcher",
  "No online codexhub machine",
  "Project launcher is offline or not found"
];

export const isTransientEmbeddedProjectOpenError = (error: unknown) =>
  error instanceof CodexHubApiError
  && error.status === 409
  && launcherUnavailableMessages.some((message) => error.responseText.includes(message));

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const openEmbeddedWorkspaceProjects = async (input: EmbeddedWorkspaceProjectsInput) => {
  if (!input.workspacePaths.length) return;
  const client = createCodexHubApiClient({ baseUrl: input.serverUrl });
  const orderedPaths = [
    ...input.workspacePaths.filter((workspacePath) => workspacePath === input.activeWorkspacePath),
    ...input.workspacePaths.filter((workspacePath) => workspacePath !== input.activeWorkspacePath)
  ];
  for (const workspacePath of orderedPaths) {
    let lastError: unknown = null;
    const attempts = input.attempts ?? 30;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const payload = await client.route(apiRoutes.machines);
        const local = (payload.machines ?? []).find((machine) =>
          machine.type === "local"
          && machine.online
          && machine.capabilities?.projectLauncher !== false
        );
        if (!local) throw new Error("Local project launcher is still starting.");
        await client.route(apiRoutes.startProjectThread, {
          machineId: local.machineId,
          path: workspacePath,
          reuse: true,
          persist: false,
          source: input.source
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (error instanceof CodexHubApiError && !isTransientEmbeddedProjectOpenError(error)) break;
      }
      if (attempt + 1 < attempts) await delay(input.retryDelayMs ?? 500);
    }
    if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
};
