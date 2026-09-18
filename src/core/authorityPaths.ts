import os from "node:os";
import path from "node:path";

/** Resolve the shared CodexHub data directory used by ordinary and embedded authorities. */
export const codexHubDataDirectory = (
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir()
) => path.resolve(
  env.CODEX_HUB_DATA_DIR?.trim() || path.join(homeDirectory, ".config", "codexhub")
);

/** VSCode and Electron deliberately use the same authority data directory. */
export const embeddedAuthorityDataDirectory = codexHubDataDirectory;
