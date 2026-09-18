import { readFile } from "node:fs/promises";
import YAML from "yaml";

const stateEnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

type AppliedConfigEntry = { inheritedValue: string | undefined; configValue: string };
const appliedConfigEnvironments = new WeakMap<object, Map<string, AppliedConfigEntry>>();

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

/** Apply config.yaml's env map over inherited process values. */
export const applyServerConfigEnv = (
  configEnv: Record<string, string> | undefined,
  target: NodeJS.ProcessEnv = process.env
) => {
  const normalized = configEnv ?? {};
  const applied = appliedConfigEnvironments.get(target) ?? new Map<string, AppliedConfigEntry>();
  appliedConfigEnvironments.set(target, applied);
  for (const [key, entry] of applied) {
    if (key in normalized) continue;
    if (target[key] !== entry.configValue) continue;
    if (entry.inheritedValue === undefined) delete target[key];
    else target[key] = entry.inheritedValue;
    applied.delete(key);
  }
  const setAppliedValue = (key: string, value: string) => {
    // The config file location is resolved before its contents are read and
    // cannot be changed by an env entry inside that same file.
    if (key === "CODEX_HUB_DATA_DIR") return;
    const previous = applied.get(key);
    if (previous) previous.configValue = value;
    else applied.set(key, { inheritedValue: target[key], configValue: value });
    target[key] = value;
  };
  for (const [key, value] of Object.entries(normalized)) setAppliedValue(key, value);
  return target;
};

export const mergeServerConfigEnv = (
  inherited: NodeJS.ProcessEnv,
  configEnv: Record<string, string> | undefined
) => applyServerConfigEnv(configEnv, { ...inherited });

/** Remove config-injected values from a child environment before a restart. */
export const restoreAppliedServerConfigEnv = (
  target: NodeJS.ProcessEnv = process.env,
  source: NodeJS.ProcessEnv = process.env
) => {
  const applied = appliedConfigEnvironments.get(source);
  if (!applied) return target;
  for (const [key, entry] of applied) {
    if (target[key] !== entry.configValue) continue;
    if (entry.inheritedValue === undefined) delete target[key];
    else target[key] = entry.inheritedValue;
  }
  return target;
};

export const isServerConfigEnvApplied = (
  key: string,
  source: NodeJS.ProcessEnv = process.env
) => appliedConfigEnvironments.get(source)?.has(key) ?? false;

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

/** Read config.yaml's env map and apply it over inherited process values. */
export const readAndApplyServerConfigEnv = async (
  filePath: string,
  target: NodeJS.ProcessEnv = process.env
) => {
  const configEnv = await readServerConfigEnv(filePath);
  applyServerConfigEnv(configEnv, target);
  return configEnv;
};
