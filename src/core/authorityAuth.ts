import { unlink } from "node:fs/promises";
import path from "node:path";

export const authorityAuthTokenEnvName = "CODEX_HUB_AUTH_TOKEN";

type Environment = Record<string, string | undefined>;

const normalizedToken = (value: string | undefined) => value?.trim() ?? "";

/** Authority authentication is opt-in; the process environment wins over config.yaml. */
export const configuredAuthorityAuthToken = (
  processEnv: Environment,
  configEnv: Environment | undefined
) => normalizedToken(processEnv[authorityAuthTokenEnvName])
  || normalizedToken(configEnv?.[authorityAuthTokenEnvName]);

/** Only an explicit auth-token env argument may enable the detached authority service. */
export const authorityServiceAuthToken = (
  optInEnvName: string | undefined,
  processEnv: Environment
) => {
  if (!optInEnvName) return "";
  if (optInEnvName !== authorityAuthTokenEnvName) {
    throw new Error(`Unsupported authority auth-token environment variable: ${optInEnvName}`);
  }
  const token = normalizedToken(processEnv[authorityAuthTokenEnvName]);
  if (!token) throw new Error("Missing explicitly configured authority access token.");
  return token;
};

export const removeLegacyAuthorityTokenFiles = async (dataDir: string) => {
  let removed = false;
  for (const fileName of ["authority-token", "vscode-authority-token"]) {
    try {
      await unlink(path.join(dataDir, fileName));
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
};
