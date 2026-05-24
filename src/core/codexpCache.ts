import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { CodexSessionSummary } from "./codexSession.js";

export type CodexpIndex = {
  version: 1;
  updatedAt: string;
  workingDirectory: string;
  source: "codex-session-jsonl";
  threads: CodexSessionSummary[];
};

export const codexpIndexPath = (workingDirectory: string) => path.join(workingDirectory, ".codexp", "index.yaml");

export const readCodexpIndex = async (workingDirectory: string): Promise<CodexpIndex | null> => {
  try {
    const parsed = YAML.parse(await readFile(codexpIndexPath(workingDirectory), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const index = parsed as Partial<CodexpIndex>;
    if (index.version !== 1 || index.workingDirectory !== workingDirectory || !Array.isArray(index.threads)) return null;
    return index as CodexpIndex;
  } catch {
    return null;
  }
};

export const writeCodexpIndex = async (
  workingDirectory: string,
  threads: CodexSessionSummary[]
): Promise<string> => {
  const filePath = codexpIndexPath(workingDirectory);
  await mkdir(path.dirname(filePath), { recursive: true });
  const index: CodexpIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    workingDirectory,
    source: "codex-session-jsonl",
    threads: sortedUniqueThreads(threads)
  };
  await writeFile(filePath, YAML.stringify(index, { lineWidth: 0 }), "utf8");
  return filePath;
};

export const upsertCodexpThread = async (
  workingDirectory: string,
  summary: CodexSessionSummary
): Promise<string> => {
  const existing = await readCodexpIndex(workingDirectory);
  const threads = [
    summary,
    ...(existing?.threads ?? []).filter((thread) => thread.threadId !== summary.threadId)
  ];
  return writeCodexpIndex(workingDirectory, threads);
};

const sortedUniqueThreads = (threads: CodexSessionSummary[]) => {
  const byId = new Map<string, CodexSessionSummary>();
  for (const thread of threads) byId.set(thread.threadId, thread);
  return [...byId.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
};
