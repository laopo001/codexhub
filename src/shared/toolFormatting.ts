import { asRecord } from "./recordTypes.js";

export const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

export const formatWriteStdinChars = (args: Record<string, unknown>) => {
  if (typeof args.chars !== "string") return "<missing>";
  if (!args.chars) return "<empty> (poll only; no stdin was written)";
  if (args.chars === "\u0003") return "Ctrl-C (\\u0003)";
  if (args.chars === "\n") return "Enter (\\n)";
  return JSON.stringify(args.chars);
};

export const formatWriteStdinSummary = (args: Record<string, unknown>) => {
  const session = typeof args.session_id === "number" || typeof args.session_id === "string"
    ? `session ${args.session_id}`
    : "session";
  return `stdin: ${formatWriteStdinChars(args)} -> ${session}`;
};

export const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

/** 兼容 app-server 新旧时长字段；无效值不进入展示层。 */
export const payloadDurationMs = (
  payload: Record<string, unknown>,
  ...keys: string[]
) => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  }
  return undefined;
};

/** 用于工具摘要的毫秒/整秒展示，不依赖消息时间戳。 */
export const formatMilliseconds = (value: number) =>
  value >= 1000 && value % 1000 === 0 ? `${value / 1000}s` : `${value}ms`;
