import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export type WorkspaceEntry = {
  path: string;
  name: string;
  lastOpenedAt: string;
};

type WorkspaceState = {
  version: 1;
  workspaces: WorkspaceEntry[];
};

const statePath = () => path.join(os.homedir(), ".codex-proxy", "state.yaml");

export const defaultWorkspacePath = (fallback: string) => normalizePath(fallback);

export const listWorkspaces = async (fallback: string): Promise<WorkspaceEntry[]> => {
  const state = await readState();
  if (state.workspaces.length) return state.workspaces;
  return [workspaceEntry(await defaultWorkspacePath(fallback))];
};

export const addWorkspace = async (workspacePath: string): Promise<WorkspaceEntry[]> => {
  const normalized = await assertDirectory(workspacePath);
  const state = await readState();
  const entry = workspaceEntry(normalized);
  const workspaces = [
    entry,
    ...state.workspaces.filter((workspace) => workspace.path !== normalized)
  ].slice(0, 24);
  await writeState({ version: 1, workspaces });
  return workspaces;
};

export const touchWorkspace = async (workspacePath: string): Promise<void> => {
  await addWorkspace(workspacePath);
};

export const listDirectoryChildren = async (directoryPath: string) => {
  const normalized = await assertDirectory(directoryPath);
  const items = await readdir(normalized, { withFileTypes: true });
  const entries = await Promise.all(items
    .filter((item) => item.isDirectory() && !item.name.startsWith("."))
    .map(async (item) => {
      const childPath = path.join(normalized, item.name);
      return {
        name: item.name,
        path: childPath,
        hasChildren: await hasChildDirectory(childPath)
      };
    }));

  return {
    path: normalized,
    parent: path.dirname(normalized) === normalized ? null : path.dirname(normalized),
    shortcuts: directoryShortcuts(),
    children: entries.sort((left, right) => left.name.localeCompare(right.name))
  };
};

const readState = async (): Promise<WorkspaceState> => {
  try {
    const parsed = YAML.parse(await readFile(statePath(), "utf8")) as { workspaces?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.workspaces)) {
      return { version: 1, workspaces: [] };
    }
    return {
      version: 1,
      workspaces: parsed.workspaces
        .filter(isWorkspaceEntry)
        .sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt))
    };
  } catch {
    return { version: 1, workspaces: [] };
  }
};

const writeState = async (state: WorkspaceState) => {
  const filePath = statePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, YAML.stringify(state), "utf8");
};

const workspaceEntry = (workspacePath: string): WorkspaceEntry => ({
  path: workspacePath,
  name: path.basename(workspacePath) || workspacePath,
  lastOpenedAt: new Date().toISOString()
});

const assertDirectory = async (value: string): Promise<string> => {
  const normalized = await normalizePath(value);
    const info = await stat(normalized);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${normalized}`);
  return normalized;
};

const normalizePath = async (value: string): Promise<string> => {
  const expanded = value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  return realpath(path.resolve(expanded));
};

const hasChildDirectory = async (directoryPath: string): Promise<boolean> => {
  try {
    const items = await readdir(directoryPath, { withFileTypes: true });
    return items.some((item) => item.isDirectory() && !item.name.startsWith("."));
  } catch {
    return false;
  }
};

const directoryShortcuts = () => [
  workspaceEntry(os.homedir()),
  workspaceEntry(path.join(os.homedir(), "projects")),
  workspaceEntry("/mnt/d/Downloads")
];

const isWorkspaceEntry = (value: unknown): value is WorkspaceEntry => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string"
    && typeof record.name === "string"
    && typeof record.lastOpenedAt === "string";
};
