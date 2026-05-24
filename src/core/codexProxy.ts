import { Codex, type CodexOptions, type Input, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import { readCodexSessionSnapshot, summarizeCodexSession } from "./codexSession.js";
import { upsertCodexpThread } from "./codexpCache.js";
import { toProxyEvent, type ProxyEvent } from "./events.js";

export type RunRequest = {
  input: Input;
  threadId?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  options?: ThreadOptions;
};

export type RunResult = {
  threadId: string | null;
  finalResponse: string;
  events: ProxyEvent[];
};

export class CodexProxy {
  private readonly codex: Codex;
  private readonly defaultThreadOptions: ThreadOptions;
  private readonly threads = new Map<string, Thread>();

  constructor(codexOptions: CodexOptions = {}, defaultThreadOptions: ThreadOptions = {}) {
    this.codex = new Codex(codexOptions);
    this.defaultThreadOptions = defaultThreadOptions;
  }

  getThread(id: string): Thread {
    const existing = this.threads.get(id);
    if (existing) return existing;
    const resumed = this.codex.resumeThread(id, this.defaultThreadOptions);
    this.threads.set(id, resumed);
    return resumed;
  }

  startThread(options: ThreadOptions = {}): Thread {
    return this.codex.startThread(this.mergeThreadOptions(options));
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
    const thread = request.threadId ? this.getThread(request.threadId) : this.startThread(threadOptions);
    let threadId = request.threadId ?? thread.id;
    let finalResponse = "";

    try {
      const { events } = await thread.runStreamed(request.input);
      for await (const event of events) {
        if (event.type === "thread.started") {
          threadId = event.thread_id;
          this.threads.set(event.thread_id, thread);
        }

        if (event.type === "item.completed" && event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }

        const proxyEvent = toProxyEvent(event, finalResponse);
        if (proxyEvent) yield proxyEvent;
      }

      if (threadId && !this.threads.has(threadId)) {
        this.threads.set(threadId, thread);
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
