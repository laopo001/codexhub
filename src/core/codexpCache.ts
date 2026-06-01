import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { CodexSessionSummary } from "./codexSession.js";

export type CodexpThreadIndex = {
  version: 1;
  workingDirectory: string;
  updatedAt: string;
  threads: CodexpWorkspaceThread[];
};

export type CodexpWorkspaceThread = {
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

export const codexpThreadIndexPath = (workingDirectory: string) => path.join(workingDirectory, ".codexp", "threads.yaml");

export const readCodexpThreadIndex = async (workingDirectory: string): Promise<CodexpThreadIndex | null> => {
  try {
    const parsed = YAML.parse(await readFile(codexpThreadIndexPath(workingDirectory), "utf8")) as Partial<CodexpThreadIndex>;
    if (parsed.version !== 1 || parsed.workingDirectory !== workingDirectory || !Array.isArray(parsed.threads)) return null;
    return parsed as CodexpThreadIndex;
  } catch {
    return null;
  }
};

export const writeCodexpThreadIndex = async (
  workingDirectory: string,
  threads: CodexSessionSummary[]
): Promise<CodexpThreadIndex> => {
  const filePath = codexpThreadIndexPath(workingDirectory);
  const index: CodexpThreadIndex = {
    version: 1,
    workingDirectory,
    updatedAt: new Date().toISOString(),
    threads: sortedUniqueThreads(threads).map(summaryToThread)
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, YAML.stringify(index), "utf8");
  return index;
};

export const upsertCodexpThread = async (
  workingDirectory: string,
  summary: CodexSessionSummary
): Promise<CodexpThreadIndex> => {
  const existing = await readCodexpThreadIndex(workingDirectory);
  const threads = [
    ...(existing?.threads ?? [])
      .map((thread) => threadToSummary(workingDirectory, thread))
      .filter((thread) => thread.threadId !== summary.threadId),
    summary
  ];
  return writeCodexpThreadIndex(workingDirectory, threads);
};

const summaryToThread = (thread: CodexSessionSummary): CodexpWorkspaceThread => ({
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

const threadToSummary = (workingDirectory: string, thread: CodexpWorkspaceThread): CodexSessionSummary => ({
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
