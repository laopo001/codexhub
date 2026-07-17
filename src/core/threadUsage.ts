import { asRecord, type CodexRecord } from "../shared/recordTypes.js";
import type { ThreadRateLimits, ThreadRateLimitUsage, ThreadUsage } from "../shared/usageTypes.js";
export type { ThreadRateLimits, ThreadRateLimitUsage, ThreadUsage } from "../shared/usageTypes.js";

export const fiveHourRateLimitWindowMinutes = 5 * 60;
export const sevenDayRateLimitWindowMinutes = 7 * 24 * 60;

type RateLimitWindows = Pick<ThreadRateLimits, "primaryRateLimit" | "secondaryRateLimit">;

export const rateLimitUsageForWindowMinutes = (
  rateLimits: RateLimitWindows | null | undefined,
  windowMinutes: number
): ThreadRateLimitUsage | null => {
  const windows = [rateLimits?.primaryRateLimit, rateLimits?.secondaryRateLimit];
  return windows.find((window) => window?.windowMinutes === windowMinutes) ?? null;
};

export const emptyThreadUsage = (): ThreadUsage => ({
  context: null,
  primaryRateLimit: null,
  secondaryRateLimit: null,
  observedAt: null
});

export const threadUsageFromRecords = (records: CodexRecord[]): ThreadUsage => {
  let merged = emptyThreadUsage();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const usage = threadUsageFromRecord(records[index]);
    if (!usage) continue;
    merged = {
      context: merged.context ?? usage.context,
      primaryRateLimit: merged.primaryRateLimit ?? usage.primaryRateLimit,
      secondaryRateLimit: merged.secondaryRateLimit ?? usage.secondaryRateLimit,
      observedAt: merged.observedAt ?? usage.observedAt
    };
    if (merged.context && merged.primaryRateLimit && merged.secondaryRateLimit) return merged;
  }
  return merged;
};

export const threadUsageFromRecord = (record: CodexRecord): ThreadUsage | null => {
  const payload = asRecord(record.payload);
  if (record.type !== "event_msg" || payload?.type !== "token_count") return null;

  const info = asRecord(payload.info);
  const lastTokenUsage = asRecord(info?.last_token_usage);
  const usedTokens = numberValue(lastTokenUsage?.input_tokens);
  const windowTokens = numberValue(info?.model_context_window);

  const usage: ThreadUsage = {
    context: usedTokens !== null && windowTokens !== null && windowTokens > 0
      ? { usedTokens, windowTokens }
      : null,
    primaryRateLimit: null,
    secondaryRateLimit: null,
    observedAt: record.timestamp ?? null
  };

  return usage.context || usage.primaryRateLimit || usage.secondaryRateLimit ? usage : null;
};

export const appServerThreadRateLimitsFromValue = (
  value: unknown,
  observedAt: string | null = null
): ThreadRateLimits | null => {
  const record = asRecord(value);
  if (!record) return null;
  const primaryRateLimit = appServerRateLimitWindowUsage(record.primary);
  const secondaryRateLimit = appServerRateLimitWindowUsage(record.secondary);
  if (!primaryRateLimit && !secondaryRateLimit) return null;
  return {
    primaryRateLimit,
    secondaryRateLimit,
    observedAt
  };
};

export const mergeAppServerThreadRateLimits = (
  previous: ThreadRateLimits | null | undefined,
  value: unknown,
  observedAt: string | null = null
): ThreadRateLimits | null => {
  const record = asRecord(value);
  if (!record) return previous ?? null;
  const primaryUpdate = asRecord(record.primary);
  const secondaryUpdate = asRecord(record.secondary);
  if (!primaryUpdate && !secondaryUpdate) return previous ?? null;
  const primaryRateLimit = mergeAppServerRateLimitWindow(previous?.primaryRateLimit, primaryUpdate);
  const secondaryRateLimit = mergeAppServerRateLimitWindow(previous?.secondaryRateLimit, secondaryUpdate);
  if (!primaryRateLimit && !secondaryRateLimit) return previous ?? null;
  return {
    primaryRateLimit,
    secondaryRateLimit,
    observedAt
  };
};

export const accountRateLimitsPayloadFromValue = (value: unknown): Record<string, unknown> | null => {
  const record = asRecord(value);
  if (!record) return null;
  const result = asRecord(record.result);
  if (result) return accountRateLimitsPayloadFromValue(result);
  const params = asRecord(record.params);
  if (params) return accountRateLimitsPayloadFromValue(params);

  const byLimitId = asRecord(record.rateLimitsByLimitId);
  const codexLimit = rateLimitPayloadById(byLimitId, "codex");
  if (codexLimit) return codexLimit;

  const direct = asRecord(record.rateLimits);
  if (direct) return direct;

  return null;
};

const appServerRateLimitWindowUsage = (value: unknown): ThreadRateLimitUsage | null => {
  const record = asRecord(value);
  if (!record) return null;
  const usedPercent = numberValue(record.usedPercent);
  const windowMinutes = numberValue(record.windowDurationMins);
  const resetsAt = numberValue(record.resetsAt);
  if (usedPercent === null) return null;
  return { usedPercent, windowMinutes, resetsAt };
};

const mergeAppServerRateLimitWindow = (
  previous: ThreadRateLimitUsage | null | undefined,
  update: Record<string, unknown> | null
): ThreadRateLimitUsage | null => {
  if (!update) return previous ?? null;
  const usedPercent = numberValue(update.usedPercent) ?? previous?.usedPercent ?? null;
  const windowMinutes = numberValue(update.windowDurationMins) ?? previous?.windowMinutes ?? null;
  const resetsAt = numberValue(update.resetsAt) ?? previous?.resetsAt ?? null;
  if (usedPercent === null) return previous ?? null;
  return { usedPercent, windowMinutes, resetsAt };
};

const rateLimitPayloadById = (byLimitId: Record<string, unknown> | null, limitId: string) => {
  const direct = asRecord(byLimitId?.[limitId]);
  if (isRateLimitPayload(direct)) return direct;
  for (const value of Object.values(byLimitId ?? {})) {
    const record = asRecord(value);
    const recordLimitId = typeof record?.limitId === "string" ? record.limitId : undefined;
    if (recordLimitId === limitId && isRateLimitPayload(record)) return record;
  }
  return null;
};

const isRateLimitPayload = (value: Record<string, unknown> | null | undefined) =>
  Boolean(value && (asRecord(value.primary) || asRecord(value.secondary)));

const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
