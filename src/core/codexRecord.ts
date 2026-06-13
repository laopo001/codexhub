export type CodexRecord = {
  id: string;
  timestamp?: string;
  type: string;
  payload: unknown;
  order?: number;
  sourceThreadId?: string;
};

export const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};
