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
