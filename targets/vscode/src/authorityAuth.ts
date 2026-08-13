import { unlink } from "node:fs/promises";
import path from "node:path";

export const vscodeAuthorityAuthTokenEnvName = "CODEX_HUB_AUTH_TOKEN";

type Environment = Record<string, string | undefined>;

const normalizedToken = (value: string | undefined) => value?.trim() ?? "";

/**
 * VSCode authority authentication is opt-in. The extension-host environment
 * wins over config.yaml, matching the server's ordinary env precedence.
 */
export const configuredVscodeAuthorityAuthToken = (
  processEnv: Environment,
  configEnv: Environment | undefined
) => normalizedToken(processEnv[vscodeAuthorityAuthTokenEnvName])
  || normalizedToken(configEnv?.[vscodeAuthorityAuthTokenEnvName]);

/**
 * Ignore inherited CODEX_HUB_AUTH_TOKEN unless the spawning extension opted in
 * explicitly. This also prevents pre-opt-in extensions from re-enabling their
 * formerly generated local token when using a newer authority-service bundle.
 */
export const authorityServiceAuthToken = (
  optInEnvName: string | undefined,
  processEnv: Environment
) => {
  if (!optInEnvName) return "";
  if (optInEnvName !== vscodeAuthorityAuthTokenEnvName) {
    throw new Error(`Unsupported VSCode authority auth-token environment variable: ${optInEnvName}`);
  }
  const token = normalizedToken(processEnv[vscodeAuthorityAuthTokenEnvName]);
  if (!token) throw new Error("Missing explicitly configured VSCode authority access token.");
  return token;
};

export const removeLegacyVscodeAuthorityTokenFile = async (dataDir: string) => {
  try {
    await unlink(path.join(dataDir, "vscode-authority-token"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
