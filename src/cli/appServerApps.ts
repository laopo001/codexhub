import { asRecord } from "../shared/recordTypes.js";
import type { AppMetadataSummary, PluginReconcileResult, SessionAppsResult } from "../shared/threadTypes.js";

type Request = (method: string, params: unknown) => Promise<unknown>;

const arrayField = (value: unknown, field: string, method: string): unknown[] => {
  const array = asRecord(value)?.[field];
  if (!Array.isArray(array)) throw new Error(`${method} did not return ${field}`);
  return array;
};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const nullableString = (value: unknown) => typeof value === "string" ? value : null;
const unsupported = (error: unknown) => /not supported|method not found|unknown method|requires experimentalApi/i.test(error instanceof Error ? error.message : String(error));

/** 分开读取安装快照、账号可访问性和展示元数据，不从 callable 反推账号权限。 */
export const readAppServerApps = async (request: Request, threadId?: string): Promise<SessionAppsResult> => {
  const scope = threadId ? { threadId } : {};
  let result: unknown;
  try {
    result = await request("app/installed", { ...scope, forceRefresh: false });
  } catch (error) {
    if (unsupported(error)) throw new Error("This Codex runtime does not support installed app state.");
    throw error;
  }
  const installed = arrayField(result, "apps", "app/installed").map((value) => {
    const app = asRecord(value);
    if (!app || typeof app.id !== "string" || !app.id || typeof app.enabled !== "boolean" || typeof app.callable !== "boolean") {
      throw new Error("app/installed returned invalid app state");
    }
    return { id: app.id, runtimeName: nullableString(app.runtimeName), enabled: app.enabled, callable: app.callable, accessible: null as boolean | null };
  });
  if (!installed.length) return { installed, metadata: [], missingAppIds: [] };
  const warnings: string[] = [];
  const accessibility = new Map<string, boolean>();
  try {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await request("app/list", { ...scope, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const value of arrayField(page, "data", "app/list")) {
        const app = asRecord(value);
        if (typeof app?.id === "string" && typeof app.isAccessible === "boolean") accessibility.set(app.id, app.isAccessible);
      }
      const next = asRecord(page)?.nextCursor;
      cursor = typeof next === "string" && next ? next : undefined;
      if (cursor && seen.has(cursor)) throw new Error("app/list repeated a cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    for (const app of installed) app.accessible = accessibility.get(app.id) ?? null;
  } catch {
    warnings.push("Account accessibility is unavailable; installed and callable states remain available.");
  }
  const metadata: AppMetadataSummary[] = [];
  const missing = new Set<string>();
  // 官方 app/read 单次最多接受 100 个 ID，按安装快照分批读取。
  for (let offset = 0; offset < installed.length; offset += 100) {
    const appIds = installed.slice(offset, offset + 100).map((app) => app.id);
    try {
      const page = await request("app/read", { ...scope, appIds, includeTools: true });
      const found = new Set<string>();
      for (const value of arrayField(page, "apps", "app/read")) {
        const app = asRecord(value);
        if (!app || typeof app.id !== "string" || typeof app.name !== "string" || !appIds.includes(app.id)) continue;
        found.add(app.id);
        const tools = Array.isArray(app.toolSummaries) ? app.toolSummaries.flatMap((raw) => {
          const tool = asRecord(raw);
          if (!tool || typeof tool.name !== "string" || typeof tool.isEnabled !== "boolean" || typeof tool.isReadOnly !== "boolean") return [];
          return [{ name: tool.name, title: nullableString(tool.title), description: nullableString(tool.description) ?? "", enabled: tool.isEnabled, disabledReason: nullableString(tool.disabledReason), readOnly: tool.isReadOnly }];
        }) : null;
        metadata.push({ id: app.id, name: app.name, description: nullableString(app.description), iconUrl: nullableString(app.iconUrl), iconUrlDark: nullableString(app.iconUrlDark), distributionChannel: nullableString(app.distributionChannel), installUrl: nullableString(app.installUrl), pluginDisplayNames: strings(app.pluginDisplayNames), tools });
      }
      for (const id of appIds) if (!found.has(id)) missing.add(id);
    } catch {
      for (const id of appIds) missing.add(id);
      if (!warnings.includes("Some app metadata could not be loaded.")) warnings.push("Some app metadata could not be loaded.");
    }
  }
  return { installed, metadata, missingAppIds: [...missing], ...(warnings.length ? { warnings } : {}) };
};

/** 只投影公开同步结果，不能把成功响应解释为所有运行时能力已就绪。 */
export const reconcileAppServerPlugins = async (request: Request, reason: string | null): Promise<PluginReconcileResult> => {
  let value: unknown;
  try {
    value = await request("plugin/reconcile", { reason });
  } catch (error) {
    if (unsupported(error)) throw new Error("This Codex runtime does not support plugin reconciliation.");
    throw error;
  }
  const changedPlugins = arrayField(value, "changedPlugins", "plugin/reconcile").map((raw) => {
    const plugin = asRecord(raw);
    if (!plugin || typeof plugin.id !== "string" || typeof plugin.hasMcps !== "boolean" || typeof plugin.hasApps !== "boolean" || typeof plugin.hasHooks !== "boolean" || typeof plugin.hasSkills !== "boolean") throw new Error("plugin/reconcile returned invalid plugin changes");
    return { id: plugin.id, hasMcps: plugin.hasMcps, hasApps: plugin.hasApps, hasHooks: plugin.hasHooks, hasSkills: plugin.hasSkills };
  });
  const failureIds = (field: string) => {
    const ids = arrayField(value, field, "plugin/reconcile");
    if (!ids.every((id): id is string => typeof id === "string")) throw new Error(`plugin/reconcile returned invalid ${field}`);
    return ids;
  };
  return { changedPlugins, failedRemotePluginIds: failureIds("failedRemotePluginIds"), failedMaterializationRemotePluginIds: failureIds("failedMaterializationRemotePluginIds") };
};
