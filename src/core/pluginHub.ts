import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export type PluginAssetContribution = {
  path: string;
  url: string;
};

export type PluginOrigin = "builtin" | "local";
export type PluginIntegrationRunner = "builtin" | "external";

export type PluginIntegrationContribution = {
  type: string;
  runner: PluginIntegrationRunner;
  enabled: boolean;
  label?: string;
  requiredEnv: string[];
  configured?: boolean;
  started?: boolean;
};

export type PluginSummary = {
  pluginId: string;
  name: string;
  version?: string;
  enabled: boolean;
  origin: PluginOrigin;
  root: string;
  contributions: {
    web: {
      styles: PluginAssetContribution[];
    };
    integrations: PluginIntegrationContribution[];
  };
};

export type PluginIntegrationManifest = string | {
  type?: string;
  runner?: PluginIntegrationRunner;
  label?: string;
  enabled?: boolean;
  requiredEnv?: string[];
};

export type PluginManifest = {
  version?: number;
  id?: string;
  name?: string;
  enabled?: boolean;
  contributes?: {
    web?: {
      styles?: string[];
    };
    integrations?: PluginIntegrationManifest[];
  };
};

export type BuiltinPluginDefinition = {
  root: string;
  manifest: PluginManifest;
};

export type PluginIntegrationState = {
  configured?: boolean;
  started?: boolean;
};

type LoadedPlugin = {
  manifest: PluginManifest;
  root: string;
  origin: PluginOrigin;
};

type PluginHubOptions = {
  roots?: string[];
  builtins?: BuiltinPluginDefinition[];
};

export class PluginHub {
  private readonly roots: string[];
  private readonly builtins: BuiltinPluginDefinition[];
  private readonly integrationStates = new Map<string, PluginIntegrationState>();

  constructor(options: PluginHubOptions = {}) {
    this.roots = options.roots ?? defaultPluginRoots();
    this.builtins = options.builtins ?? [];
  }

  async listPlugins(): Promise<PluginSummary[]> {
    const plugins = await this.loadPlugins();
    return plugins
      .map((plugin) => this.toSummary(plugin))
      .filter((plugin): plugin is PluginSummary => Boolean(plugin))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  }

  setIntegrationState(type: string, state: PluginIntegrationState) {
    this.integrationStates.set(type, {
      ...this.integrationStates.get(type),
      ...state
    });
  }

  async hasEnabledBuiltinIntegration(type: string) {
    const plugins = await this.loadPlugins();
    return plugins.some((plugin) => {
      if (plugin.origin !== "builtin" || plugin.manifest.enabled === false) return false;
      return safeIntegrationList(plugin.manifest.contributes?.integrations, plugin.origin, true, this.integrationStates)
        .some((integration) => integration.type === type && integration.runner === "builtin" && integration.enabled);
    });
  }

  async resolveAsset(pluginId: string, assetPath: string) {
    const plugin = (await this.loadPlugins())
      .find((item) => item.origin === "local" && item.manifest.enabled !== false && item.manifest.id === pluginId);
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
    const safePath = normalizeAssetPath(assetPath);
    const filePath = path.resolve(plugin.root, safePath);
    if (!filePath.startsWith(`${plugin.root}${path.sep}`)) throw new Error("Plugin asset path is outside plugin root.");
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`Plugin asset is not a file: ${assetPath}`);
    return filePath;
  }

  private async loadPlugins(): Promise<LoadedPlugin[]> {
    const candidates = await pluginCandidates(this.roots);
    const loaded = await Promise.all(candidates.map((root) => loadPlugin(root)));
    return [
      ...this.builtins.map((plugin) => ({
        ...plugin,
        origin: "builtin" as const
      })),
      ...loaded.filter((plugin): plugin is LoadedPlugin => Boolean(plugin))
    ];
  }

  private toSummary(plugin: LoadedPlugin): PluginSummary | null {
    const id = plugin.manifest.id?.trim();
    if (!id) return null;
    const enabled = plugin.manifest.enabled !== false;
    return {
      pluginId: id,
      name: plugin.manifest.name?.trim() || id,
      version: plugin.manifest.version ? String(plugin.manifest.version) : undefined,
      enabled,
      origin: plugin.origin,
      root: plugin.root,
      contributions: {
        web: {
          styles: enabled
            ? safeAssetList(plugin.manifest.contributes?.web?.styles)
              .map((assetPath) => ({
                path: assetPath,
                url: `/api/plugins/${encodeURIComponent(id)}/assets/${assetPath.split("/").map(encodeURIComponent).join("/")}`
              }))
            : []
        },
        integrations: safeIntegrationList(
          plugin.manifest.contributes?.integrations,
          plugin.origin,
          enabled,
          this.integrationStates
        )
      }
    };
  }
}

const defaultPluginRoots = () => {
  const env = process.env.CODEX_HUB_PLUGIN_DIRS ?? process.env.CODEX_HUB_PLUGIN_DIR;
  if (env) return uniquePaths(env.split(path.delimiter).filter(Boolean).map((item) => path.resolve(item)));
  return uniquePaths([
    path.join(os.homedir(), ".local", "share", "codexhub", "plugins"),
    path.resolve(process.cwd(), "plugins")
  ]);
};

const pluginCandidates = async (roots: string[]) => {
  const candidates: string[] = [];
  for (const root of roots) {
    const rootInfo = await safeStat(root);
    if (!rootInfo?.isDirectory()) continue;
    if (await manifestPath(root)) candidates.push(root);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (await manifestPath(candidate)) candidates.push(candidate);
    }
  }
  return uniquePaths(candidates);
};

const loadPlugin = async (root: string): Promise<LoadedPlugin | null> => {
  const manifest = await manifestPath(root);
  if (!manifest) return null;
  const text = await readFile(manifest, "utf8").catch(() => "");
  if (!text.trim()) return null;
  const parsed = YAML.parse(text) as PluginManifest | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return {
    root,
    manifest: parsed,
    origin: "local"
  };
};

const manifestPath = async (root: string) => {
  for (const name of ["codexhub.plugin.yaml", "codexhub.plugin.yml", "plugin.yaml", "plugin.yml", "plugin.json"]) {
    const filePath = path.join(root, name);
    const info = await safeStat(filePath);
    if (info?.isFile()) return filePath;
  }
  return null;
};

const safeStat = async (filePath: string) => {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
};

const safeAssetList = (values: unknown) =>
  Array.isArray(values)
    ? values
      .filter((value): value is string => typeof value === "string")
      .map((value) => {
        try {
          return normalizeAssetPath(value);
        } catch {
          return "";
        }
      })
      .filter(Boolean)
    : [];

const safeIntegrationList = (
  values: unknown,
  origin: PluginOrigin,
  pluginEnabled: boolean,
  integrationStates: Map<string, PluginIntegrationState>
): PluginIntegrationContribution[] => {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeIntegration(value, origin, pluginEnabled, integrationStates))
    .filter((value): value is PluginIntegrationContribution => Boolean(value));
};

const normalizeIntegration = (
  value: unknown,
  origin: PluginOrigin,
  pluginEnabled: boolean,
  integrationStates: Map<string, PluginIntegrationState>
): PluginIntegrationContribution | null => {
  const rawType = typeof value === "string"
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as { type?: unknown }).type
      : undefined;
  const type = typeof rawType === "string" ? rawType.trim() : "";
  if (!type) return null;

  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as {
      runner?: unknown;
      label?: unknown;
      enabled?: unknown;
      requiredEnv?: unknown;
    }
    : {};
  const runner = origin === "builtin" && record.runner === "builtin" ? "builtin" : "external";
  const requiredEnv = safeStringList(record.requiredEnv);
  const state = integrationStates.get(type);
  const enabled = pluginEnabled && record.enabled !== false;
  return {
    type,
    runner,
    enabled,
    label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined,
    requiredEnv,
    configured: state?.configured ?? (requiredEnv.length ? requiredEnv.every((name) => Boolean(process.env[name])) : undefined),
    started: runner === "builtin" ? state?.started ?? false : undefined
  };
};

const safeStringList = (values: unknown) =>
  Array.isArray(values)
    ? values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
    : [];

const normalizeAssetPath = (value: string) => {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid plugin asset path: ${value}`);
  }
  return normalized;
};

const uniquePaths = (values: string[]) => [...new Set(values.map((value) => path.resolve(value)))];
