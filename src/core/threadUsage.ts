import { asRecord, type CodexRecord } from "../shared/recordTypes.js";
import type { ThreadRateLimits, ThreadRateLimitUsage, ThreadUsage } from "../shared/usageTypes.js";
export type { ThreadRateLimits, ThreadRateLimitUsage, ThreadUsage } from "../shared/usageTypes.js";

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
  const lastTokenUsage = asRecord(info?.last_token_usage);
  const usedTokens = numberValue(lastTokenUsage?.input_tokens)
    ?? numberValue(lastTokenUsage?.total_tokens);
  const windowTokens = numberValue(info?.model_context_window);
  const rateLimits = asRecord(payload.rate_limits);
  const rateLimitUsage = threadRateLimitsFromValue(rateLimits, record.timestamp ?? null);

  const usage: ThreadUsage = {
    context: usedTokens !== null && windowTokens !== null && windowTokens > 0
      ? { usedTokens, windowTokens }
      : null,
    primaryRateLimit: rateLimitUsage?.primaryRateLimit ?? null,
    secondaryRateLimit: rateLimitUsage?.secondaryRateLimit ?? null,
    observedAt: record.timestamp ?? null
  };

  return usage.context || usage.primaryRateLimit || usage.secondaryRateLimit ? usage : null;
};

export const threadRateLimitsFromValue = (value: unknown, observedAt: string | null = null): ThreadRateLimits | null => {
  const record = asRecord(value);
  if (!record) return null;
  const primaryRateLimit = rateLimitWindowUsage(record.primary);
  const secondaryRateLimit = rateLimitWindowUsage(record.secondary);
  if (!primaryRateLimit && !secondaryRateLimit) return null;
  return {
    primaryRateLimit,
    secondaryRateLimit,
    observedAt
  };
};

const rateLimitWindowUsage = (value: unknown): ThreadRateLimitUsage | null => {
  const record = asRecord(value);
  if (!record) return null;
  const usedPercent = numberValue(record.used_percent) ?? numberValue(record.usedPercent);
  const windowMinutes = numberValue(record.window_minutes)
    ?? numberValue(record.windowMinutes)
    ?? numberValue(record.window_duration_mins)
    ?? numberValue(record.windowDurationMins);
  const resetsAt = numberValue(record.resets_at) ?? numberValue(record.resetsAt);
  if (usedPercent === null || windowMinutes === null || resetsAt === null) return null;
  return { usedPercent, windowMinutes, resetsAt };
};

const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
