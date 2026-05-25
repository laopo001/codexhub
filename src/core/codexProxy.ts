import { Codex, type CodexOptions, type Input, type Thread, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import { readCodexSessionSnapshot, summarizeCodexSession } from "./codexSession.js";
import { upsertCodexpThread } from "./codexpCache.js";
import { toProxyEvent, type ProxyEvent } from "./events.js";

export type RunRequest = {
  input: Input;
  threadId?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  options?: ThreadOptions;
  signal?: AbortSignal;
};

export type RunResult = {
  threadId: string | null;
  finalResponse: string;
  events: ProxyEvent[];
};

export type ProxyThreadInstance = {
  threadId: string;
  workingDirectory: string;
  running: boolean;
};

export class CodexProxy {
  private readonly codex: Codex;
  private readonly defaultThreadOptions: ThreadOptions;
  private readonly threads = new Map<string, Thread>();
  private readonly runningThreads = new Set<string>();

  constructor(codexOptions: CodexOptions = {}, defaultThreadOptions: ThreadOptions = {}) {
    this.codex = new Codex(codexOptions);
    this.defaultThreadOptions = defaultThreadOptions;
  }

  getThread(id: string, options: ThreadOptions = {}): Thread {
    const mergedOptions = this.mergeThreadOptions(options);
    const key = threadCacheKey(id, mergedOptions.workingDirectory);
    const existing = this.threads.get(key);
    if (existing) return existing;
    const resumed = this.codex.resumeThread(id, mergedOptions);
    this.threads.set(key, resumed);
    return resumed;
  }

  startThread(options: ThreadOptions = {}): Thread {
    return this.codex.startThread(this.mergeThreadOptions(options));
  }

  releaseThread(id: string, options: ThreadOptions = {}): boolean {
    const mergedOptions = this.mergeThreadOptions(options);
    const key = threadCacheKey(id, mergedOptions.workingDirectory);
    const released = this.threads.delete(key);
    this.runningThreads.delete(key);
    return released;
  }

  listThreadInstances(): ProxyThreadInstance[] {
    return [...this.threads.keys()].map((key) => {
      const { threadId, workingDirectory } = parseThreadCacheKey(key);
      return {
        threadId,
        workingDirectory,
        running: this.runningThreads.has(key)
      };
    });
  }

  async run(request: RunRequest): Promise<RunResult> {
    const events: ProxyEvent[] = [];
    let finalResponse = "";
    let threadId: string | null = request.threadId ?? null;

    for await (const event of this.runStream(request)) {
      events.push(event);
      if (event.type === "thread") threadId = event.threadId;
      if (event.type === "final") finalResponse = event.text;
    }

    return { threadId, finalResponse, events };
  }

  async *runStream(request: RunRequest): AsyncGenerator<ProxyEvent> {
    const threadOptions = this.optionsFromRequest(request);
    const workingDirectory = threadOptions.workingDirectory ?? process.cwd();
    const thread = request.threadId ? this.getThread(request.threadId, threadOptions) : this.startThread(threadOptions);
    let threadId = request.threadId ?? thread.id;
    let finalResponse = "";
    let runningKey = request.threadId ? threadCacheKey(request.threadId, workingDirectory) : null;

    if (runningKey && this.runningThreads.has(runningKey)) {
      throw new Error(`Thread is already running: ${request.threadId}`);
    }
    if (runningKey) this.runningThreads.add(runningKey);

    try {
      const turnOptions: TurnOptions = request.signal ? { signal: request.signal } : {};
      const { events } = await thread.runStreamed(request.input, turnOptions);
      for await (const event of events) {
        if (event.type === "thread.started") {
          threadId = event.thread_id;
          runningKey = threadCacheKey(event.thread_id, workingDirectory);
          this.threads.set(runningKey, thread);
          this.runningThreads.add(runningKey);
        }

        if (event.type === "item.completed" && event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }

        const proxyEvent = toProxyEvent(event, finalResponse);
        if (proxyEvent) yield proxyEvent;
      }

      if (threadId && !this.threads.has(threadCacheKey(threadId, workingDirectory))) {
        this.threads.set(threadCacheKey(threadId, workingDirectory), thread);
      }

      if (threadId) {
        const snapshot = await readCodexSessionSnapshot(threadId);
        for (const event of artifactEventsFromSnapshot(snapshot)) {
          yield event;
        }
        const summary = snapshot ? await summarizeCodexSession(snapshot, workingDirectory) : null;
        if (summary) await upsertCodexpThread(workingDirectory, summary);
      }
    } catch (error) {
      throw error;
    } finally {
      if (runningKey) this.runningThreads.delete(runningKey);
    }
  }

  private optionsFromRequest(request: RunRequest): ThreadOptions {
    return this.mergeThreadOptions({
      ...request.options,
      workingDirectory: request.workingDirectory ?? request.options?.workingDirectory,
      skipGitRepoCheck: request.skipGitRepoCheck ?? request.options?.skipGitRepoCheck
    });
  }

  private mergeThreadOptions(options: ThreadOptions): ThreadOptions {
    return {
      ...this.defaultThreadOptions,
      ...options
    };
  }
}

const artifactEventsFromSnapshot = (snapshot: Awaited<ReturnType<typeof readCodexSessionSnapshot>>): ProxyEvent[] => {
  if (!snapshot) return [];

  return snapshot.imageGenerations.map((generation) => ({
    type: "artifact",
    path: generation.savedPath,
    text: [
      "Generated image",
      generation.savedPath ? `Saved to: ${generation.savedPath}` : null,
      generation.revisedPrompt ? `Prompt: ${generation.revisedPrompt}` : null
    ].filter(Boolean).join("\n"),
    metadata: generation
  }));
};

const threadCacheKey = (threadId: string, workingDirectory?: string) => `${workingDirectory ?? ""}::${threadId}`;

const parseThreadCacheKey = (key: string) => {
  const separator = key.lastIndexOf("::");
  return {
    workingDirectory: separator === -1 ? "" : key.slice(0, separator),
    threadId: separator === -1 ? key : key.slice(separator + 2)
  };
};
