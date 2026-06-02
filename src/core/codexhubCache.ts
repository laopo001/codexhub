import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { CodexSessionSummary } from "./codexSession.js";

export type CodexhubThreadIndex = {
  version: 1;
  workingDirectory: string;
  updatedAt: string;
  threads: CodexhubWorkspaceThread[];
};

export type CodexhubWorkspaceThread = {
  threadId: string;
  updatedAt: string;
  path: string;
  summary: {
    firstUserMessage: string;
    lastAssistantMessage: string;
    messageCount: number;
    artifactCount: number;
  };
};

export const codexhubThreadIndexPath = (workingDirectory: string) => path.join(workingDirectory, ".codexp", "threads.yaml");

export const readCodexhubThreadIndex = async (workingDirectory: string): Promise<CodexhubThreadIndex | null> => {
  try {
    const parsed = YAML.parse(await readFile(codexhubThreadIndexPath(workingDirectory), "utf8")) as Partial<CodexhubThreadIndex>;
    if (parsed.version !== 1 || parsed.workingDirectory !== workingDirectory || !Array.isArray(parsed.threads)) return null;
    return parsed as CodexhubThreadIndex;
  } catch {
    return null;
  }
};

export const writeCodexhubThreadIndex = async (
  workingDirectory: string,
  threads: CodexSessionSummary[]
): Promise<CodexhubThreadIndex> => {
  const filePath = codexhubThreadIndexPath(workingDirectory);
  const index: CodexhubThreadIndex = {
    version: 1,
    workingDirectory,
    updatedAt: new Date().toISOString(),
    threads: sortedUniqueThreads(threads).map(summaryToThread)
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, YAML.stringify(index), "utf8");
  return index;
};

export const upsertCodexhubThread = async (
  workingDirectory: string,
  summary: CodexSessionSummary
): Promise<CodexhubThreadIndex> => {
  const existing = await readCodexhubThreadIndex(workingDirectory);
  const threads = [
    ...(existing?.threads ?? [])
      .map((thread) => threadToSummary(workingDirectory, thread))
      .filter((thread) => thread.threadId !== summary.threadId),
    summary
  ];
  return writeCodexhubThreadIndex(workingDirectory, threads);
};

const summaryToThread = (thread: CodexSessionSummary): CodexhubWorkspaceThread => ({
  threadId: thread.threadId,
  updatedAt: thread.updatedAt,
  path: thread.path,
  summary: {
    firstUserMessage: thread.firstUserMessage,
    lastAssistantMessage: thread.lastAssistantMessage,
    messageCount: thread.messageCount,
    artifactCount: thread.artifactCount
  }
});

const threadToSummary = (workingDirectory: string, thread: CodexhubWorkspaceThread): CodexSessionSummary => ({
  threadId: thread.threadId,
  cwd: workingDirectory,
  updatedAt: thread.updatedAt,
  path: thread.path,
  firstUserMessage: thread.summary.firstUserMessage,
  lastAssistantMessage: thread.summary.lastAssistantMessage,
  messageCount: thread.summary.messageCount,
  artifactCount: thread.summary.artifactCount
});

const sortedUniqueThreads = (threads: CodexSessionSummary[]) => {
  const byId = new Map<string, CodexSessionSummary>();
  for (const thread of threads) byId.set(thread.threadId, thread);
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};
