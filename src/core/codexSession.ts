import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export const readCodexSessionSnapshot = async (threadId: string): Promise<CodexSessionSnapshot | null> => {
  const filePath = await waitForSessionFile(threadId);
  if (!filePath) return null;

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

const waitForSessionFile = async (threadId: string): Promise<string | null> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const found = await findSessionFile(threadId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
};

const findSessionFile = async (threadId: string): Promise<string | null> => {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const matches: string[] = [];

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
      } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
        matches.push(entryPath);
      }
    }
  };

  await visit(root);
  return matches.sort().at(-1) ?? null;
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
