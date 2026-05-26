import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { CodexSessionSummary } from "./codexSession.js";
import { readSavedInstances } from "./instanceStore.js";

export type CodexpInstanceIndex = {
  version: 2;
  updatedAt: string;
  workingDirectory: string;
  instances: CodexpWorkspaceInstance[];
};

export type CodexpWorkspaceInstance = {
  instanceId: string;
  title: string;
  status: "idle";
  updatedAt: string;
  source: "codex-session-jsonl";
  codex: {
    threadId: string;
    sessionPath: string;
  };
  summary: {
    firstUserMessage: string;
    lastAssistantMessage: string;
    messageCount: number;
    artifactCount: number;
  };
};

export const codexpInstanceIndexPath = (workingDirectory: string) => path.join(workingDirectory, ".codexp", "instances.yaml");

export const readCodexpInstanceIndex = async (workingDirectory: string): Promise<CodexpInstanceIndex | null> =>
  await readIndexFile(codexpInstanceIndexPath(workingDirectory), workingDirectory);

const readIndexFile = async (filePath: string, workingDirectory: string): Promise<CodexpInstanceIndex | null> => {
  try {
    const parsed = YAML.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const index = parsed as Partial<CodexpInstanceIndex>;
    if (index.version !== 2 || index.workingDirectory !== workingDirectory || !Array.isArray(index.instances)) return null;
    return index as CodexpInstanceIndex;
  } catch {
    return null;
  }
};

export const writeCodexpInstanceIndex = async (
  workingDirectory: string,
  threads: CodexSessionSummary[]
): Promise<string> => {
  const filePath = codexpInstanceIndexPath(workingDirectory);
  await mkdir(path.dirname(filePath), { recursive: true });
  const index: CodexpInstanceIndex = {
    version: 2,
    updatedAt: new Date().toISOString(),
    workingDirectory,
    instances: await summariesToInstances(workingDirectory, sortedUniqueThreads(threads))
  };
  await writeFile(filePath, YAML.stringify(index, { lineWidth: 0 }), "utf8");
  return filePath;
};

export const upsertCodexpInstanceThread = async (
  workingDirectory: string,
  summary: CodexSessionSummary
): Promise<string> => {
  const existing = await readCodexpInstanceIndex(workingDirectory);
  const threads = [
    summary,
    ...(existing?.instances ?? [])
      .map((instance) => workspaceInstanceToSummary(instance, workingDirectory))
      .filter((thread) => thread.threadId !== summary.threadId)
  ];
  return writeCodexpInstanceIndex(workingDirectory, threads);
};

const summariesToInstances = async (workingDirectory: string, threads: CodexSessionSummary[]) => {
  const savedInstances = await readSavedInstances();
  return threads.map((thread): CodexpWorkspaceInstance => {
    const saved = savedInstances.find((instance) =>
      instance.workingDirectory === workingDirectory && instance.threadId === thread.threadId
    );
    const title = saved?.title ?? (thread.firstUserMessage.slice(0, 80) || thread.threadId);
    return {
      instanceId: saved?.instanceId ?? `restored:${thread.threadId}`,
      title,
      status: "idle",
      updatedAt: thread.updatedAt,
      source: "codex-session-jsonl",
      codex: {
        threadId: thread.threadId,
        sessionPath: thread.path
      },
      summary: {
        firstUserMessage: thread.firstUserMessage,
        lastAssistantMessage: thread.lastAssistantMessage,
        messageCount: thread.messageCount,
        artifactCount: thread.artifactCount
      }
    };
  });
};

const workspaceInstanceToSummary = (
  instance: CodexpWorkspaceInstance,
  workingDirectory: string
): CodexSessionSummary => ({
  threadId: instance.codex.threadId,
  cwd: workingDirectory,
  path: instance.codex.sessionPath,
  updatedAt: instance.updatedAt,
  firstUserMessage: instance.summary.firstUserMessage,
  lastAssistantMessage: instance.summary.lastAssistantMessage,
  messageCount: instance.summary.messageCount,
  artifactCount: instance.summary.artifactCount
});

const sortedUniqueThreads = (threads: CodexSessionSummary[]) => {
  const byId = new Map<string, CodexSessionSummary>();
  for (const thread of threads) byId.set(thread.threadId, thread);
  return [...byId.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
};
