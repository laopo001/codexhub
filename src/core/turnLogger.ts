import type { Input, ThreadEvent } from "@openai/codex-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { CodexSessionRecord, CodexSessionSnapshot } from "./codexSession.js";
import { itemText, type ProxyEvent } from "./events.js";

type LoggedEvent = {
  at: string;
  sdk: ThreadEvent | { type: "proxy.logging_error"; message: string };
  proxy: ProxyEvent | null;
};

export type TurnLog = {
  version: 1;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "running" | "completed" | "failed";
  source: "codex-session-jsonl" | "codex-sdk-stream";
  workingDirectory: string;
  threadId: string | null;
  request: {
    input: Input;
  };
  summary?: TurnLogSummary;
  codexSessionPath?: string;
  events: CodexSessionRecord[];
  sdkStreamEvents: LoggedEvent[];
  error?: {
    message: string;
    stack?: string;
  };
};

type TranscriptMessage = {
  role: "user" | "assistant" | "event" | "error";
  at: string;
  text: string;
};

type TurnLogSummary = {
  eventCounts: Record<string, number>;
  finalResponse: string;
  finalResponseEmpty: boolean;
  usage: unknown;
  transcript: TranscriptMessage[];
  items: Array<{
    at: string;
    eventType: string;
    itemType: string;
    id?: string;
    status?: string;
    text?: string;
    raw: unknown;
  }>;
  artifacts: string[];
  warnings: string[];
};

export class TurnLogger {
  private readonly log: TurnLog;

  constructor(input: Input, workingDirectory: string, threadId: string | null) {
    this.log = {
      version: 1,
      createdAt: new Date().toISOString(),
      status: "running",
      source: "codex-sdk-stream",
      workingDirectory,
      threadId,
      request: { input },
      events: [],
      sdkStreamEvents: []
    };
  }

  setThreadId(threadId: string) {
    this.log.threadId = threadId;
  }

  record(sdk: ThreadEvent, proxy: ProxyEvent | null) {
    this.log.sdkStreamEvents.push({
      at: new Date().toISOString(),
      sdk: cloneForYaml(sdk),
      proxy: cloneForYaml(proxy)
    });
  }

  recordLoggingError(error: unknown) {
    this.log.sdkStreamEvents.push({
      at: new Date().toISOString(),
      sdk: {
        type: "proxy.logging_error",
        message: error instanceof Error ? error.message : String(error)
      },
      proxy: null
    });
  }

  attachCodexSession(snapshot: CodexSessionSnapshot | null) {
    if (!snapshot) return;
    this.log.source = "codex-session-jsonl";
    this.log.codexSessionPath = snapshot.path;
    this.log.events = snapshot.records;
  }

  async complete() {
    this.log.status = "completed";
    this.log.completedAt = new Date().toISOString();
    this.log.durationMs = this.durationMs();
    this.log.summary = this.buildSummary();
    await this.flush();
  }

  async fail(error: unknown) {
    this.log.status = "failed";
    this.log.completedAt = new Date().toISOString();
    this.log.durationMs = this.durationMs();
    this.log.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    };
    this.log.summary = this.buildSummary();
    await this.flush();
  }

  private buildSummary(): TurnLogSummary {
    const transcript: TranscriptMessage[] = [];
    const items: TurnLogSummary["items"] = [];
    const artifacts = new Set<string>();
    const warnings: string[] = [];
    const eventCounts: Record<string, number> = {};
    let finalResponse = "";
    let usage: unknown = null;

    transcript.push({
      role: "user",
      at: this.log.createdAt,
      text: inputToText(this.log.request.input)
    });

    for (const event of this.log.events) {
      const payload = asRecord(event.payload);
      const eventKey = payload?.type ? `${event.type}:${payload.type}` : event.type;
      eventCounts[eventKey] = (eventCounts[eventKey] ?? 0) + 1;

      if (event.type === "event_msg" && payload?.type === "token_count") {
        usage = asRecord(asRecord(payload.info)?.last_token_usage) ?? payload.info ?? null;
      }

      if (event.type === "event_msg" && payload?.type === "agent_message" && payload.phase === "final_answer") {
        const message = typeof payload.message === "string" ? payload.message : "";
        finalResponse = message;
        if (message) {
          transcript.push({ role: "assistant", at: event.timestamp ?? this.log.createdAt, text: message });
        }
      }

      if (event.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string") {
        transcript.push({ role: "user", at: event.timestamp ?? this.log.createdAt, text: payload.message });
      }

      if (event.type === "event_msg" && payload?.type === "image_generation_end") {
        const text = [
          "Generated image",
          typeof payload.saved_path === "string" ? `Saved to: ${payload.saved_path}` : null,
          typeof payload.revised_prompt === "string" ? `Prompt: ${payload.revised_prompt}` : null
        ].filter(Boolean).join("\n");
        transcript.push({ role: "event", at: event.timestamp ?? this.log.createdAt, text });
      }

      items.push({
        at: event.timestamp ?? this.log.createdAt,
        eventType: event.type,
        itemType: typeof payload?.type === "string" ? payload.type : event.type,
        id: typeof payload?.id === "string" ? payload.id : typeof payload?.call_id === "string" ? payload.call_id : undefined,
        status: typeof payload?.status === "string" ? payload.status : undefined,
        text: recordText(event),
        raw: event.payload
      });

      for (const artifact of extractArtifacts(event.payload)) {
        artifacts.add(artifact);
      }
    }

    for (const event of this.log.sdkStreamEvents) {
      if (this.log.events.length > 0) break;
      eventCounts[event.sdk.type] = (eventCounts[event.sdk.type] ?? 0) + 1;
      if ("type" in event.sdk && event.sdk.type === "turn.completed") {
        usage = (event.sdk as Extract<ThreadEvent, { type: "turn.completed" }>).usage;
      }
      if (event.proxy?.type === "final") finalResponse = event.proxy.text;
    }

    if (!finalResponse.trim()) {
      warnings.push("final_response_empty");
    }
    if (!this.log.codexSessionPath) {
      warnings.push("codex_session_jsonl_not_found");
    }
    if (artifacts.size === 0) {
      warnings.push("no_artifacts_detected");
    }

    return {
      eventCounts,
      finalResponse,
      finalResponseEmpty: !finalResponse.trim(),
      usage,
      transcript,
      items,
      artifacts: [...artifacts],
      warnings
    };
  }

  private durationMs(): number {
    const completedAt = this.log.completedAt ? Date.parse(this.log.completedAt) : Date.now();
    return completedAt - Date.parse(this.log.createdAt);
  }

  private async flush() {
    const logsDirectory = path.join(this.log.workingDirectory, ".codexp", "logs");
    await mkdir(logsDirectory, { recursive: true });
    const safeThreadId = this.log.threadId?.replaceAll(/[^a-zA-Z0-9_-]/g, "_") ?? "new";
    const timestamp = this.log.createdAt.replaceAll(/[:.]/g, "-");
    const filePath = path.join(logsDirectory, `${timestamp}-${safeThreadId}.yaml`);
    const log = cloneForYaml({
      version: this.log.version,
      createdAt: this.log.createdAt,
      completedAt: this.log.completedAt,
      durationMs: this.log.durationMs,
      status: this.log.status,
      source: this.log.source,
      workingDirectory: this.log.workingDirectory,
      threadId: this.log.threadId,
      request: this.log.request,
      summary: this.log.summary,
      codexSessionPath: this.log.codexSessionPath,
      events: this.log.events,
      sdkStreamEvents: this.log.sdkStreamEvents,
      error: this.log.error
    });

    await writeFile(
      filePath,
      YAML.stringify(log, {
        lineWidth: 0
      }),
      "utf8"
    );
  }
}

const cloneForYaml = <T>(value: T): T => {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const recordText = (event: CodexSessionRecord): string | undefined => {
  const payload = asRecord(event.payload);
  if (!payload) return undefined;

  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.revised_prompt === "string") return payload.revised_prompt;

  if (payload.type === "message" && Array.isArray(payload.content)) {
    return payload.content
      .map((content) => asRecord(content))
      .map((content) => typeof content?.text === "string" ? content.text : null)
      .filter((text): text is string => Boolean(text))
      .join("\n");
  }

  return undefined;
};

const inputToText = (input: Input): string => {
  if (typeof input === "string") return input;
  return input
    .map((entry) => {
      if (entry.type === "text") return entry.text;
      return `[local_image: ${entry.path}]`;
    })
    .join("\n");
};

const extractArtifacts = (value: unknown): string[] => {
  const text = JSON.stringify(value);
  const matches = text.match(/(?:file:\/\/)?(?:\/[\w .:@%+-]+)+\.[a-zA-Z0-9]{2,8}/g);
  return [...new Set(matches ?? [])];
};
