import { readFile } from "node:fs/promises";
import YAML from "yaml";

const stateEnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const normalizeServerConfigEnv = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!stateEnvNamePattern.test(key)) continue;
    if (typeof rawValue === "string") {
      env[key] = rawValue;
    } else if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      env[key] = String(rawValue);
    }
  }
  return env;
};

/**
 * Apply the non-VS Code portion of config.yaml to a process environment.
 *
 * The environment remains an override boundary: shell/.env/CLI values are
 * already present and must win over values persisted in config.yaml. Keeping
 * this operation in one helper makes ordinary Node, Electron, and the
 * detached VS Code authority use the same precedence rules.
 */
export const applyServerConfigEnv = (
  configEnv: Record<string, string> | undefined,
  target: NodeJS.ProcessEnv = process.env
) => {
  for (const [key, value] of Object.entries(configEnv ?? {})) {
    if (!(key in target)) target[key] = value;
  }
  return target;
};

/** Read only config.yaml's env map without loading or mutating server state. */
export const readServerConfigEnv = async (filePath: string): Promise<Record<string, string> | undefined> => {
  let rawText: string;
  try {
    rawText = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
  try {
    const parsed = YAML.parse(rawText) as { env?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return normalizeServerConfigEnv(parsed.env);
  } catch {
    return undefined;
  }
};

/** Read config.yaml's non-VS Code settings and apply them without overwriting explicit process values. */
export const readAndApplyServerConfigEnv = async (
  filePath: string,
  target: NodeJS.ProcessEnv = process.env
) => {
  const configEnv = await readServerConfigEnv(filePath);
  applyServerConfigEnv(configEnv, target);
  return configEnv;
};
