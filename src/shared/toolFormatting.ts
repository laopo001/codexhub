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
