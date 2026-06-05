import { asRecord, type CodexRecord } from "./codexRecord.js";

export type ThreadRateLimitUsage = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
};

export type ThreadUsage = {
  context: {
    usedTokens: number;
    windowTokens: number;
  } | null;
  primaryRateLimit: ThreadRateLimitUsage | null;
  secondaryRateLimit: ThreadRateLimitUsage | null;
  observedAt: string | null;
};

export const emptyThreadUsage = (): ThreadUsage => ({
  context: null,
  primaryRateLimit: null,
  secondaryRateLimit: null,
  observedAt: null
});

export const threadUsageFromRecords = (records: CodexRecord[]): ThreadUsage => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const usage = threadUsageFromRecord(records[index]);
    if (usage) return usage;
  }
  return emptyThreadUsage();
};

export const threadUsageFromRecord = (record: CodexRecord): ThreadUsage | null => {
  const payload = asRecord(record.payload);
  if (record.type !== "event_msg" || payload?.type !== "token_count") return null;

  const info = asRecord(payload.info);
  const totalTokenUsage = asRecord(info?.total_token_usage);
  const usedTokens = numberValue(totalTokenUsage?.total_tokens);
  const windowTokens = numberValue(info?.model_context_window);
  const rateLimits = asRecord(payload.rate_limits);

  const usage: ThreadUsage = {
    context: usedTokens !== null && windowTokens !== null && windowTokens > 0
      ? { usedTokens, windowTokens }
      : null,
    primaryRateLimit: rateLimitUsage(rateLimits?.primary),
    secondaryRateLimit: rateLimitUsage(rateLimits?.secondary),
    observedAt: record.timestamp ?? null
  };

  return usage.context || usage.primaryRateLimit || usage.secondaryRateLimit ? usage : null;
};

const rateLimitUsage = (value: unknown): ThreadRateLimitUsage | null => {
  const record = asRecord(value);
  if (!record) return null;
  const usedPercent = numberValue(record.used_percent) ?? numberValue(record.usedPercent);
  const windowMinutes = numberValue(record.window_minutes) ?? numberValue(record.windowMinutes);
  const resetsAt = numberValue(record.resets_at) ?? numberValue(record.resetsAt);
  if (usedPercent === null || windowMinutes === null || resetsAt === null) return null;
  return { usedPercent, windowMinutes, resetsAt };
};

const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
