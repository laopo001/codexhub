import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ThreadOptions } from "@openai/codex-sdk";
import YAML from "yaml";

export type SavedInstance = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  title: string;
  threadOptions: ThreadOptions;
  updatedAt: string;
  savedAt: string;
};

type InstanceStore = {
  version: 1;
  instances: SavedInstance[];
};

export const instanceStorePath = () => path.join(os.homedir(), ".codex-proxy", "instances.yaml");

export const readSavedInstances = async (): Promise<SavedInstance[]> => {
  try {
    const parsed = YAML.parse(await readFile(instanceStorePath(), "utf8")) as { instances?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.instances)) return [];
    return parsed.instances.filter(isSavedInstance);
  } catch {
    return [];
  }
};

export const writeSavedInstances = async (instances: SavedInstance[]) => {
  const filePath = instanceStorePath();
  const state: InstanceStore = {
    version: 1,
    instances: instances
      .map((instance) => ({ ...instance, threadOptions: sanitizeThreadOptions(instance.threadOptions) }))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, YAML.stringify(state, { lineWidth: 0 }), "utf8");
  return { path: filePath, instances: state.instances };
};

const sanitizeThreadOptions = (options: ThreadOptions): ThreadOptions => {
  const sanitized: ThreadOptions = {};
  if (typeof options.model === "string" && options.model) sanitized.model = options.model;
  if (typeof options.modelReasoningEffort === "string" && options.modelReasoningEffort) {
    sanitized.modelReasoningEffort = options.modelReasoningEffort;
  }
  return sanitized;
};

const isSavedInstance = (value: unknown): value is SavedInstance => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.instanceId === "string"
    && typeof record.workingDirectory === "string"
    && (record.threadId == null || typeof record.threadId === "string")
    && typeof record.title === "string"
    && typeof record.updatedAt === "string"
    && typeof record.savedAt === "string"
    && (!record.threadOptions || typeof record.threadOptions === "object");
};
