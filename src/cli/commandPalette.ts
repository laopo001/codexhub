import type { CommandPaletteEntry } from "../shared/threadTypes.js";

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
};

export const builtinCommandPaletteEntries = (config: JsonRecord | null): CommandPaletteEntry[] => {
  const features = asRecord(config?.features);
  const memories = asRecord(config?.memories);
  const model = stringField(config, "model");
  const effort = stringField(config, "model_reasoning_effort");
  const serviceTier = stringField(config, "service_tier");
  const modelDetail = [model, effort, serviceTier].filter(Boolean).join(" · ");
  const entries: CommandPaletteEntry[] = [
    {
      id: "builtin:model",
      kind: "builtin",
      name: "model",
      title: "模型",
      shortDescription: "选择模型",
      description: "选择当前 thread 使用的模型、reasoning 和服务层级。",
      detail: modelDetail || undefined,
      insertText: "/model",
      action: "open_model",
      enabled: true
    },
    {
      id: "builtin:status",
      kind: "builtin",
      name: "status",
      title: "状态",
      shortDescription: "显示对话状态",
      description: "显示对话 ID、上下文使用情况及额度限制。",
      insertText: "/status",
      action: "insert",
      enabled: true
    },
    {
      id: "builtin:plan",
      kind: "builtin",
      name: "plan",
      title: "计划模式",
      shortDescription: "开启计划模式",
      description: "将下一轮输入作为计划模式发送给 Codex。",
      insertText: "/plan",
      action: "set_plan_mode",
      enabled: true
    },
    {
      id: "builtin:review",
      kind: "builtin",
      name: "review",
      title: "Review changes",
      shortDescription: "审查当前改动",
      description: "调用 app-server review/start 审查当前 workspace 未提交改动。",
      insertText: "/review",
      action: "review_changes",
      enabled: true
    },
    {
      id: "builtin:compact",
      kind: "builtin",
      name: "compact",
      title: "Compact",
      shortDescription: "压缩上下文",
      description: "调用 app-server thread/compact/start 压缩当前 thread 上下文。",
      insertText: "/compact",
      action: "compact_thread",
      enabled: true
    },
    {
      id: "builtin:fast",
      kind: "builtin",
      name: "fast",
      title: "Fast",
      shortDescription: "查看或切换快速服务层级",
      description: "查看或切换当前 thread 的 Fast service tier。",
      detail: serviceTier ? `当前 ${serviceTier}` : undefined,
      insertText: "/fast status",
      action: "insert",
      enabled: true
    }
  ];

  if (features?.goals !== false) {
    entries.splice(2, 0, {
      id: "builtin:goal",
      kind: "builtin",
      name: "goal",
      title: "目标",
      shortDescription: "设置持续努力目标",
      description: "切换到 Goal composer 模式，让下一轮输入设置 Codex 持续努力实现的目标。",
      insertText: "/goal",
      action: "set_goal_mode",
      enabled: true
    });
  }

  if (features?.memories === true || memories) {
    entries.splice(features?.goals !== false ? 3 : 2, 0, {
      id: "builtin:memories",
      kind: "builtin",
      name: "memories",
      title: "记忆",
      shortDescription: memoryShortDescription(memories),
      description: "显示当前 app-server 配置里的记忆使用与生成状态。",
      detail: memoryShortDescription(memories),
      insertText: "/memories",
      action: "insert",
      enabled: true
    });
  }

  return entries;
};

export const commandPaletteEntryFromSkill = (
  skill: JsonRecord | null,
  pluginDisplayName: string | undefined
): CommandPaletteEntry | null => {
  const name = stringField(skill, "name");
  const description = stringField(skill, "description");
  const enabled = skill?.enabled !== false;
  if (!name || !description || !enabled) return null;
  const skillInterface = asRecord(skill?.interface);
  const displayName = stringField(skillInterface, "displayName");
  const shortDescription = stringField(skill, "shortDescription") || stringField(skillInterface, "shortDescription");
  const pathValue = stringField(skill, "path");
  const scope = stringField(skill, "scope");
  return {
    id: `skill:${name}:${pathValue || pluginDisplayName || ""}`,
    kind: "skill",
    name,
    title: displayName || skillDisplayName(name),
    shortDescription: shortDescription || undefined,
    description,
    detail: pluginDisplayName || skillScopeLabel(scope),
    insertText: `@${name}`,
    action: "insert",
    enabled,
    source: pluginDisplayName || pathValue || undefined,
    scope: scope || undefined
  };
};

export const commandPaletteEntryFromPlugin = (summary: JsonRecord | null, fallbackName: string): CommandPaletteEntry | null => {
  const pluginInterface = asRecord(summary?.interface);
  const name = stringField(summary, "name") || fallbackName || pluginNameFromId(stringField(summary, "id"));
  const displayName = stringField(pluginInterface, "displayName") || skillDisplayName(name);
  const description = stringField(pluginInterface, "description")
    || stringField(pluginInterface, "longDescription")
    || stringField(pluginInterface, "shortDescription")
    || stringField(summary, "description")
    || stringField(summary, "longDescription")
    || stringField(summary, "shortDescription");
  if (!name || !displayName || !description) return null;
  const availability = stringField(summary, "availability").toUpperCase();
  return {
    id: `plugin:${name}`,
    kind: "plugin",
    name,
    title: displayName,
    shortDescription: stringField(pluginInterface, "shortDescription") || stringField(summary, "shortDescription") || undefined,
    description,
    detail: "Plugin",
    insertText: `@${name}`,
    action: "insert",
    enabled: availability !== "UNAVAILABLE"
  };
};

export const dedupeCommandPaletteEntries = (entries: CommandPaletteEntry[]) => {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.kind}:${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const memoryShortDescription = (memories: JsonRecord | null) => [
  memoryFlagLabel(memories?.use_memories, "使用"),
  memoryFlagLabel(memories?.generate_memories, "生成")
].join("，");

const memoryFlagLabel = (value: unknown, label: string) =>
  value === true ? `${label}开` : value === false ? `${label}关` : `${label}默认`;

const skillDisplayName = (name: string) => {
  const localName = name.includes(":") ? name.split(":").pop() || name : name;
  return localName
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
};

const skillScopeLabel = (scope?: string) => {
  if (scope === "user") return "个人";
  if (scope === "repo") return "Repo";
  if (scope === "admin") return "Admin";
  if (scope === "system") return "系统";
  return undefined;
};

export const pluginNameFromId = (id?: string) => id?.split("@")[0] || "";

export const pluginNameFromSkillName = (name: string) => {
  const index = name.indexOf(":");
  return index > 0 ? [name.slice(0, index)] : [];
};

export const stringField = (record: JsonRecord | null | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
};

