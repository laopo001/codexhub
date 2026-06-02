import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { findCodexSessionFile } from "./codexSession.js";

type RateLimitWindow = {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
};

export type CodexRateLimits = {
  limit_id?: string | null;
  limit_name?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
};

type TokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

export type CodexUsageSnapshot = {
  rateLimits: CodexRateLimits | null;
  tokenUsage: {
    totalTokenUsage: TokenUsage | null;
    lastTokenUsage: TokenUsage | null;
    modelContextWindow: number | null;
  } | null;
  sourceFile: string | null;
  observedAt: string | null;
  source: "latest" | "thread";
};

const cacheTtlMs = 15_000;
let cachedAt = 0;
let cachedSnapshot: CodexUsageSnapshot | null = null;

export async function readCodexUsage(threadId?: string): Promise<CodexUsageSnapshot> {
  if (threadId) return readCodexUsageForThread(threadId);
  return readLatestCodexUsage();
}

async function readCodexUsageForThread(threadId: string): Promise<CodexUsageSnapshot> {
  const filePath = await findCodexSessionFile(threadId);
  if (!filePath) return emptySnapshot("thread");
  const snapshot = await findLatestRateLimitsInFile(filePath, "thread");
  return snapshot.rateLimits ? snapshot : emptySnapshot("thread");
}

async function readLatestCodexUsage(): Promise<CodexUsageSnapshot> {
  const now = Date.now();
  if (cachedSnapshot && now - cachedAt < cacheTtlMs) return cachedSnapshot;

  const sessionsDir = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "sessions");
  const files = await listRolloutFiles(sessionsDir);
  const snapshot = await findLatestRateLimits(files, "latest");
  cachedAt = now;
  cachedSnapshot = snapshot;
  return snapshot;
}

async function listRolloutFiles(root: string) {
  const files: Array<{ filePath: string; mtimeMs: number }> = [];

  async function visit(directory: string) {
    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      return;
    }

    for await (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      const fileStat = await stat(entryPath);
      files.push({ filePath: entryPath, mtimeMs: fileStat.mtimeMs });
    }
  }

  await visit(root);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function findLatestRateLimits(
  files: Array<{ filePath: string }>,
  source: CodexUsageSnapshot["source"]
): Promise<CodexUsageSnapshot> {
  for (const file of files) {
    const snapshot = await findLatestRateLimitsInFile(file.filePath, source);
    if (snapshot.rateLimits) return snapshot;
  }

  return emptySnapshot(source);
}

async function findLatestRateLimitsInFile(
  filePath: string,
  source: CodexUsageSnapshot["source"]
): Promise<CodexUsageSnapshot> {
  let latest: CodexUsageSnapshot = {
    rateLimits: null,
    tokenUsage: null,
    sourceFile: null,
    observedAt: null,
    source
  };
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.includes("\"token_count\"") || !line.includes("\"rate_limits\"")) continue;
    const parsed = parseJsonLine(line);
    const payload = parsed?.payload;
    if (payload?.type !== "token_count" || !isRateLimits(payload.rate_limits)) continue;
    latest = {
      rateLimits: payload.rate_limits,
      tokenUsage: tokenUsageFromPayload(payload),
      sourceFile: filePath,
      observedAt: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      source
    };
  }

  return latest;
}

function parseJsonLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isRateLimits(value: unknown): value is CodexRateLimits {
  if (!value || typeof value !== "object") return false;
  const rateLimits = value as CodexRateLimits;
  return Boolean(rateLimits.primary || rateLimits.secondary);
}

function tokenUsageFromPayload(payload: any): CodexUsageSnapshot["tokenUsage"] {
  const info = payload.info;
  if (!info || typeof info !== "object") return null;
  return {
    totalTokenUsage: tokenUsageFromValue(info.total_token_usage),
    lastTokenUsage: tokenUsageFromValue(info.last_token_usage),
    modelContextWindow: typeof info.model_context_window === "number" ? info.model_context_window : null
  };
}

function tokenUsageFromValue(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Partial<TokenUsage>;
  if (typeof usage.total_tokens !== "number") return null;
  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    cached_input_tokens: typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : 0,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    reasoning_output_tokens: typeof usage.reasoning_output_tokens === "number" ? usage.reasoning_output_tokens : 0,
    total_tokens: usage.total_tokens
  };
}

function emptySnapshot(source: CodexUsageSnapshot["source"]): CodexUsageSnapshot {
  return {
    rateLimits: null,
    tokenUsage: null,
    sourceFile: null,
    observedAt: null,
    source
  };
}
