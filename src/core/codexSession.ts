import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export type CodexSessionRecord = {
  line: number;
  timestamp?: string;
  type: string;
  payload: unknown;
};

export type CodexSessionSnapshot = {
  path: string;
  records: CodexSessionRecord[];
  artifacts: string[];
  finalMessages: string[];
  imageGenerations: Array<{
    callId?: string;
    status?: string;
    revisedPrompt?: string;
    savedPath?: string;
    resultLength?: number;
  }>;
};

export type CodexSessionSummary = {
  threadId: string;
  cwd: string;
  path: string;
  updatedAt: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  artifactCount: number;
  messageCount: number;
};

export const readCodexSessionSnapshotFromFile = async (filePath: string): Promise<CodexSessionSnapshot> => {
  const lines = (await readFile(filePath, "utf8")).trim().split("\n").filter(Boolean);
  const records = lines.map((line, index) => {
    const parsed = JSON.parse(line) as { timestamp?: string; type: string; payload: unknown };
    return {
      line: index + 1,
      timestamp: parsed.timestamp,
      type: parsed.type,
      payload: sanitizePayload(parsed.payload)
    };
  });

  return buildSnapshot(filePath, records);
};

export const readCodexSessionSnapshot = async (threadId: string): Promise<CodexSessionSnapshot | null> => {
  const filePath = await waitForSessionFile(threadId);
  if (!filePath) return null;
  return readCodexSessionSnapshotFromFile(filePath);
};

export const listCodexSessionFiles = async (): Promise<string[]> => {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const files: string[] = [];
  await visitSessionFiles(root, (filePath) => {
    files.push(filePath);
  });
  return files.sort();
};

export const sessionThreadId = (snapshot: CodexSessionSnapshot): string | null => {
  for (const record of snapshot.records) {
    if (record.type !== "session_meta") continue;
    const payload = asRecord(record.payload);
    return typeof payload?.id === "string" ? payload.id : null;
  }
  return null;
};

export const listCodexSessionsForCwd = async (workingDirectory: string): Promise<CodexSessionSummary[]> => {
  const files = await listCodexSessionFiles();
  const summaries = await mapWithConcurrency(files, 16, (filePath) => readSessionSummaryForCwd(filePath, workingDirectory));

  return summaries
    .filter((summary): summary is CodexSessionSummary => Boolean(summary))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
};

export const summarizeCodexSession = async (
  snapshot: CodexSessionSnapshot,
  workingDirectory: string
): Promise<CodexSessionSummary | null> => {
  const cwd = sessionCwd(snapshot);
  const threadId = sessionThreadId(snapshot);
  if (!threadId || cwd !== workingDirectory) return null;
  return buildSummary(snapshot, cwd, threadId);
};

export const sessionCwd = (snapshot: CodexSessionSnapshot): string | null => {
  for (const record of snapshot.records) {
    if (record.type !== "session_meta") continue;
    const payload = asRecord(record.payload);
    return typeof payload?.cwd === "string" ? payload.cwd : null;
  }
  return null;
};

const buildSnapshot = (filePath: string, records: CodexSessionRecord[]): CodexSessionSnapshot => {
  const artifacts = new Set<string>();
  const finalMessages: string[] = [];
  const imageGenerations: CodexSessionSnapshot["imageGenerations"] = [];

  for (const record of records) {
    const payload = asRecord(record.payload);
    if (!payload) continue;

    if (payload.type === "agent_message" && payload.phase === "final_answer" && typeof payload.message === "string") {
      finalMessages.push(payload.message);
    }

    if (payload.type === "image_generation_end") {
      const savedPath = typeof payload.saved_path === "string" ? payload.saved_path : undefined;
      if (savedPath) artifacts.add(savedPath);
      imageGenerations.push({
        callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
        status: typeof payload.status === "string" ? payload.status : undefined,
        revisedPrompt: typeof payload.revised_prompt === "string" ? payload.revised_prompt : undefined,
        savedPath,
        resultLength: typeof payload.result_length === "number" ? payload.result_length : undefined
      });
    }

    for (const artifact of extractPaths(payload)) {
      artifacts.add(artifact);
    }
  }

  return {
    path: filePath,
    records,
    artifacts: [...artifacts],
    finalMessages,
    imageGenerations
  };
};

const buildSummary = async (
  snapshot: CodexSessionSnapshot,
  cwd: string,
  threadId: string
): Promise<CodexSessionSummary> => {
  const fallbackUpdatedAt = await fileUpdatedAt(snapshot.path);
  const updatedAt = [...snapshot.records].reverse().find((record) => record.timestamp)?.timestamp ?? fallbackUpdatedAt;
  return {
    threadId,
    cwd,
    path: snapshot.path,
    updatedAt,
    firstUserMessage: firstPayloadMessage(snapshot, "user_message"),
    lastAssistantMessage: lastAssistantMessage(snapshot),
    artifactCount: snapshot.artifacts.length,
    messageCount: snapshot.records.filter((record) => {
      const payload = asRecord(record.payload);
      return payload?.type === "user_message" || payload?.type === "agent_message";
    }).length
  };
};

const readSessionSummaryForCwd = async (
  filePath: string,
  workingDirectory: string
): Promise<CodexSessionSummary | null> => {
  const artifacts = new Set<string>();
  const reader = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  let threadId = "";
  let cwd = "";
  let firstUserMessage = "";
  let lastAssistant = "";
  let lastTimestamp = "";
  let messageCount = 0;

  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as { timestamp?: string; type: string; payload: unknown };
      if (parsed.timestamp) lastTimestamp = parsed.timestamp;

      if (parsed.type === "session_meta") {
        const payload = asRecord(parsed.payload);
        threadId = typeof payload?.id === "string" ? payload.id : "";
        cwd = typeof payload?.cwd === "string" ? payload.cwd : "";
        if (cwd !== workingDirectory) {
          reader.close();
          return null;
        }
        continue;
      }

      if (!cwd) continue;

      const payload = asRecord(parsed.payload);
      if (!payload) continue;
      if (payload.type === "user_message") {
        messageCount += 1;
        if (!firstUserMessage && typeof payload.message === "string") firstUserMessage = payload.message;
      } else if (payload.type === "agent_message") {
        messageCount += 1;
        if (typeof payload.message === "string") lastAssistant = payload.message;
      } else if (payload.type === "image_generation_end" && typeof payload.saved_path === "string") {
        artifacts.add(payload.saved_path);
      }

      for (const artifact of extractPaths(payload)) artifacts.add(artifact);
    }
  } catch {
    reader.close();
    return null;
  }

  if (!threadId || cwd !== workingDirectory) return null;
  return {
    threadId,
    cwd,
    path: filePath,
    updatedAt: lastTimestamp || await fileUpdatedAt(filePath),
    firstUserMessage,
    lastAssistantMessage: lastAssistant,
    artifactCount: artifacts.size,
    messageCount
  };
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
};

const fileUpdatedAt = async (filePath: string): Promise<string> => {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
};

const firstPayloadMessage = (snapshot: CodexSessionSnapshot, type: string): string => {
  for (const record of snapshot.records) {
    const payload = asRecord(record.payload);
    if (payload?.type === type && typeof payload.message === "string") return payload.message;
  }
  return "";
};

const lastAssistantMessage = (snapshot: CodexSessionSnapshot): string => {
  for (const record of [...snapshot.records].reverse()) {
    const payload = asRecord(record.payload);
    if (payload?.type === "agent_message" && typeof payload.message === "string") return payload.message;
  }
  return snapshot.finalMessages.at(-1) ?? "";
};

const waitForSessionFile = async (threadId: string): Promise<string | null> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const found = await findCodexSessionFile(threadId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
};

export const findCodexSessionFile = async (threadId: string): Promise<string | null> => {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const matches: string[] = [];
  await visitSessionFiles(root, (filePath) => {
    if (path.basename(filePath).includes(threadId)) matches.push(filePath);
  });
  return matches.sort().at(-1) ?? null;
};

const visitSessionFiles = async (root: string, onFile: (filePath: string) => void | Promise<void>) => {
  const visit = async (directory: string) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        await onFile(entryPath);
      }
    }
  };

  await visit(root);
};

const sanitizePayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "base_instructions" && asRecord(child)?.text) {
      const text = asRecord(child)?.text;
      output.base_instructions = {
        text_omitted: true,
        text_length: typeof text === "string" ? text.length : undefined
      };
    } else if (key === "result" && typeof child === "string" && child.length > 4096) {
      output.result_omitted = true;
      output.result_length = child.length;
    } else if (typeof child === "string" && child.length > 4000) {
      output[key] = {
        text_omitted: true,
        text_preview: child.slice(0, 500),
        text_length: child.length
      };
    } else {
      output[key] = sanitizePayload(child);
    }
  }
  return output;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const extractPaths = (value: unknown): string[] => {
  const text = JSON.stringify(value);
  const matches = text.match(/(?:\/[\w .:@%+-]+)+\.(?:png|jpg|jpeg|webp|gif|svg|mp4|yaml|json|txt|md)/g);
  return [...new Set(matches ?? [])];
};
