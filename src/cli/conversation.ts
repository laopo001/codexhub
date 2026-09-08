import WebSocket from "ws";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { CodexRecord } from "../shared/recordTypes.js";
import { asRecord } from "../shared/recordTypes.js";
import { messageTextFromPayload } from "../shared/taskNotifications.js";
import type { MachineSummary } from "../shared/machineTypes.js";
import type { ThreadDetail, ThreadQueueItem, ThreadRunOptions } from "../shared/threadTypes.js";
import type { ThreadTurnPayload } from "../shared/apiContract.js";
import type {
  ConversationStreamEvent,
  ConversationThreadTarget
} from "./conversationStreamRenderer.js";

const SHORT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const MAX_ERROR_BODY_LENGTH = 1000;

type RealtimeThreadMessage = {
  type?: string;
  threadId?: string;
  kind?: "thread" | "record" | "record_delta" | "done";
  seq?: number;
  historical?: boolean;
  records?: CodexRecord[];
  record?: CodexRecord;
  delta?: { recordId: string; field: "aggregated_output"; append: string };
  snapshot?: { reset?: boolean };
  lifecycle?: "end";
  message?: string;
  scope?: string;
  queue?: ThreadQueueItem[];
};

export type ConversationRunOptions = {
  baseUrl: string;
  authToken?: string;
  operation: "start" | "send";
  input: string;
  name?: string;
  threadId?: string;
  machineId?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  noWait?: boolean;
  json?: boolean;
  timeoutSeconds?: number;
  persistent?: boolean;
  externalSignal?: AbortSignal;
  onThreadReady?: (target: ConversationThreadTarget) => void;
  onStreamEvent?: (event: ConversationStreamEvent) => void;
  onError?: (error: Error, target?: ConversationThreadTarget) => void;
  onSubscribed?: (threadId: string) => void;
};

export type ConversationResult = {
  threadId: string;
  machineId: string;
  cwd: string;
  waited: boolean;
  submissionId?: string;
  delivery?: "turn" | "steer" | "goal" | "queued";
  queued?: boolean;
  command?: string;
  lastSeq?: number;
  assistant: string[];
};

export class ConversationInterruptedError extends Error {
  readonly exitCode = 130;

  constructor() {
    super("Interrupted; the CodexHub task was left running on the backend.");
    this.name = "ConversationInterruptedError";
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

class RealtimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeError";
  }
}

export const runConversation = async (options: ConversationRunOptions): Promise<ConversationResult> => {
  const input = options.input;
  if (!input.trim()) throw new Error("Conversation input must not be empty.");
  if (options.operation === "start" && !options.name?.trim()) {
    throw new Error("start requires a non-empty --name.");
  }

  const persistent = options.persistent === true;
  const wait = !options.noWait && !persistent;
  const timeoutMs = options.noWait
    ? SHORT_REQUEST_TIMEOUT_MS
    : options.timeoutSeconds === undefined && persistent
      ? undefined
      : parseTimeoutSeconds(options.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000;
  const abortController = new AbortController();
  let interrupted = false;
  let timedOut = false;
  const deadlineTimer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);
  const onInterrupt = () => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", onInterrupt);
  const onExternalAbort = () => abortController.abort();
  if (options.externalSignal?.aborted) onExternalAbort();
  else options.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  let subscription: ThreadSubscription | undefined;
  let preparedTarget: ConversationThreadTarget | undefined;
  try {
    const target = options.operation === "start"
      ? await prepareNewThread(options, abortController.signal, (nextTarget) => {
        preparedTarget = nextTarget;
        options.onThreadReady?.(nextTarget);
      })
      : await prepareExistingThread(options, abortController.signal);
    if (!preparedTarget) {
      preparedTarget = target;
      options.onThreadReady?.(target);
    }
    const threadId = target.threadId;
    const machineId = target.machineId;
    const cwd = target.cwd;

    if (!wait && !persistent) {
      const response = await postTurn(options.baseUrl, options.authToken, threadId, input, false, abortController.signal, SHORT_REQUEST_TIMEOUT_MS, turnOptionsFrom(options));
      return {
        threadId,
        machineId,
        cwd,
        waited: false,
        submissionId: response.submissionId,
        delivery: response.delivery,
        queued: response.queued,
        command: response.command,
        assistant: []
      };
    }

    subscription = await ThreadSubscription.open(
      options.baseUrl,
      options.authToken,
      threadId,
      timeoutMs ?? SHORT_REQUEST_TIMEOUT_MS,
      abortController.signal,
      options.onStreamEvent
    );
    options.onSubscribed?.(threadId);
    void subscription.failurePromise().catch(() => abortController.abort());
    const baseline = subscription.captureBaseline();

    const responsePromise = postTurn(
      options.baseUrl,
      options.authToken,
      threadId,
      input,
      !persistent,
      abortController.signal,
      persistent ? SHORT_REQUEST_TIMEOUT_MS : timeoutMs,
      turnOptionsFrom(options)
    );
    const response = await Promise.race([responsePromise, subscription.failurePromise()]);
    if (persistent) {
      const endSeq = await subscription.waitForEnd(abortController.signal);
      await subscription.waitForSeq(endSeq, timeoutMs, abortController.signal);
      return {
        threadId,
        machineId,
        cwd,
        waited: true,
        submissionId: response.submissionId,
        delivery: response.delivery,
        queued: response.queued,
        command: response.command,
        lastSeq: endSeq,
        assistant: subscription.assistantChanges(baseline)
      };
    }
    if (typeof response.lastSeq !== "number") {
      throw new Error("CodexHub wait response did not include a realtime stream barrier.");
    }
    await subscription.waitForSeq(response.lastSeq, timeoutMs, abortController.signal);
    return {
      threadId,
      machineId,
      cwd,
      waited: true,
      submissionId: response.submissionId,
      delivery: response.delivery,
      queued: response.queued,
      command: response.command,
      lastSeq: response.lastSeq,
      assistant: subscription.assistantChanges(baseline)
    };
  } catch (error) {
    const normalized = interrupted
      ? new ConversationInterruptedError()
      : timedOut
        ? new Error(`CodexHub conversation timed out after ${(timeoutMs ?? 0) / 1000}s; execution on the backend was not stopped.`)
        : error instanceof Error ? error : new Error(String(error));
    try {
      options.onError?.(normalized, preparedTarget);
    } catch {
      // A presentation callback must not hide the original delivery error.
    }
    throw normalized;
  } finally {
    clearTimeout(deadlineTimer);
    process.removeListener("SIGINT", onInterrupt);
    options.externalSignal?.removeEventListener("abort", onExternalAbort);
    abortController.abort();
    subscription?.close();
  }
};

const prepareNewThread = async (
  options: ConversationRunOptions,
  signal: AbortSignal,
  onThreadReady: (target: ConversationThreadTarget) => void
): Promise<{ threadId: string; machineId: string; cwd: string }> => {
  const machine = await resolveMachine(options.baseUrl, options.authToken, options.machineId, signal);
  const cwd = resolveCwd(options.baseUrl, options.cwd, machine.type !== "local");
  const machineId = machine.machineId;
  const detail = await requestJson<ThreadDetail>(
    options.baseUrl,
    `/api/machines/${encodeURIComponent(machine.machineId)}/threads`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "new", cwd }),
      signal
    }, SHORT_REQUEST_TIMEOUT_MS, options.authToken
  );
  const threadId = readThreadId(detail);
  const target = { threadId, machineId, cwd };
  onThreadReady(target);
  await requestJson(
    options.baseUrl,
    `/api/threads/${encodeURIComponent(threadId)}/name`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: options.name?.trim() }),
      signal
    }, SHORT_REQUEST_TIMEOUT_MS, options.authToken
  );
  return target;
};

const prepareExistingThread = async (
  options: ConversationRunOptions,
  signal: AbortSignal
): Promise<{ threadId: string; machineId: string; cwd: string }> => {
  const threadId = options.threadId?.trim();
  if (!threadId) throw new Error("send requires a threadId.");

  let detail: ThreadDetail | undefined;
  try {
    detail = await requestJson<ThreadDetail>(
      options.baseUrl,
      `/api/threads/${encodeURIComponent(threadId)}`,
      { signal },
      SHORT_REQUEST_TIMEOUT_MS,
      options.authToken
    );
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
  }

  const machine = await resolveMachine(
    options.baseUrl,
    options.authToken,
    options.machineId ?? detail?.runtime?.machineId,
    signal
  );
  const cwd = options.cwd ?? detail?.workingDirectory ?? resolveCwd(options.baseUrl, undefined, machine.type !== "local");
  const resumed = await requestJson<ThreadDetail>(
    options.baseUrl,
    `/api/machines/${encodeURIComponent(machine.machineId)}/threads`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume", threadId, ...(cwd ? { cwd } : {}) }),
      signal
    }, SHORT_REQUEST_TIMEOUT_MS, options.authToken
  );
  return {
    threadId: readThreadId(resumed, threadId),
    machineId: machine.machineId,
    cwd: resumed.workingDirectory ?? cwd
  };
};

const resolveMachine = async (
  baseUrl: string,
  authToken: string | undefined,
  requestedMachineId: string | undefined,
  signal: AbortSignal
) => {
  const payload = await requestJson<{ machines?: MachineSummary[] }>(
    baseUrl,
    "/api/machines",
    { signal },
    SHORT_REQUEST_TIMEOUT_MS,
    authToken
  );
  const machines = (payload.machines ?? []).filter((machine) =>
    machine.online && machine.capabilities?.projectLauncher !== false
  );
  if (requestedMachineId) {
    const machine = machines.find((candidate) => candidate.machineId === requestedMachineId);
    if (!machine) throw new Error(`Machine is not online or cannot launch projects: ${requestedMachineId}`);
    return machine;
  }

  const localMachines = machines.filter((machine) => machine.type === "local");
  if (localMachines.length !== 1) {
    if (!localMachines.length) {
      throw new Error("No unique online local machine is available; specify --machine <id>.");
    }
    throw new Error("Multiple online local machines are available; specify --machine <id>.");
  }
  return localMachines[0];
};

const postTurn = async (
  baseUrl: string,
  authToken: string | undefined,
  threadId: string,
  input: string,
  wait: boolean,
  signal: AbortSignal,
  timeoutMs = SHORT_REQUEST_TIMEOUT_MS,
  options?: Pick<ThreadRunOptions, "model" | "modelReasoningEffort">
) => requestJson<ThreadTurnPayload>(
  baseUrl,
  `/api/threads/${encodeURIComponent(threadId)}/turn${wait ? "?wait=true" : ""}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, source: "cli", ...(options ? { options } : {}) }),
    signal
  },
  timeoutMs,
  authToken
);

const turnOptionsFrom = (options: ConversationRunOptions): Pick<ThreadRunOptions, "model" | "modelReasoningEffort"> | undefined => {
  if (options.model === undefined && options.effort === undefined) return undefined;
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { modelReasoningEffort: options.effort })
  };
};

export const requestJson = async <T>(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = SHORT_REQUEST_TIMEOUT_MS,
  explicitAuthToken?: string
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortInput = init.signal;
  const onAbort = () => controller.abort();
  if (abortInput?.aborted) onAbort();
  else abortInput?.addEventListener("abort", onAbort, { once: true });
  try {
    const url = new URL(pathname, baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("CodexHub URL must be HTTP(S) without embedded credentials.");
    }
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new Error("CodexHub JSON request body must be text.");
    }
    // Long turns can legitimately exceed fetch's independent headers timeout.
    // The caller's AbortSignal and deadline are the only request time limits.
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: init.method ?? "GET",
        agent: false,
        headers: Object.fromEntries(withAuth(init.headers, explicitAuthToken)),
        signal: controller.signal
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        incoming.once("error", reject);
        incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.once("error", reject);
      request.end(init.body ?? undefined);
    });
    const body = response.body;
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(response.status, `CodexHub HTTP ${response.status}: ${redact(body, explicitAuthToken)}`);
    }
    if (!body) return {} as T;
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error("CodexHub returned invalid JSON.");
    }
  } catch (error) {
    if (error instanceof HttpError || error instanceof RealtimeError) throw error;
    if (controller.signal.aborted) {
      throw new Error(`CodexHub request timed out or was interrupted after ${Math.ceil(timeoutMs / 1000)}s.`);
    }
    throw new Error(`CodexHub request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    abortInput?.removeEventListener("abort", onAbort);
  }
};

const withAuth = (headersInit: HeadersInit | undefined, explicitAuthToken: string | undefined) => {
  const headers = new Headers(headersInit);
  const token = explicitAuthToken ?? process.env.CODEX_HUB_AUTH_TOKEN;
  if (token?.trim() && !headers.has("authorization")) headers.set("authorization", `Bearer ${token.trim()}`);
  return headers;
};

const redact = (value: string, token: string | undefined) => {
  const trimmed = token?.trim();
  const redacted = trimmed ? value.replaceAll(trimmed, "[REDACTED_SECRET]") : value;
  return redacted.length > MAX_ERROR_BODY_LENGTH ? `${redacted.slice(0, MAX_ERROR_BODY_LENGTH)}…` : redacted;
};

const readThreadId = (value: ThreadDetail, fallback?: string) => {
  const threadId = typeof value.threadId === "string" && value.threadId.trim() ? value.threadId : fallback;
  if (!threadId) throw new Error("CodexHub did not return a threadId.");
  return threadId;
};

const resolveCwd = (baseUrl: string, requestedCwd: string | undefined, requireExplicit = false) => {
  if (requestedCwd?.trim()) return requestedCwd.trim();
  if (requireExplicit || isRemoteUrl(baseUrl)) {
    throw new Error("The target machine or backend is remote; specify --cwd instead of sending the CLI machine's local path.");
  }
  return process.cwd();
};

const isRemoteUrl = (baseUrl: string) => {
  const url = new URL(baseUrl);
  return !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
};

const parseTimeoutSeconds = (value: number) => {
  if (!Number.isFinite(value) || value <= 0 || value > 86_400) {
    throw new Error("--timeout must be greater than 0 and no more than 86400 seconds.");
  }
  return value;
};

class ThreadSubscription {
  private readonly records = new Map<string, CodexRecord>();
  private readonly recordOrder: string[] = [];
  private readonly liveChangedRecordIds = new Set<string>();
  private readonly liveSeqWaiters = new Set<{
    target: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
    signal: AbortSignal;
    onAbort: () => void;
  }>();
  private readonly ready: Promise<void>;
  private readonly readyResolve: () => void;
  private readonly readyReject: (error: Error) => void;
  private readonly failure: Promise<never>;
  private readonly failureReject: (error: Error) => void;
  private readonly end: Promise<number>;
  private readonly endResolve: (seq: number) => void;
  private socket: WebSocket | undefined;
  private subscribed = false;
  private historical = false;
  private intentionallyClosed = false;
  private readySettled = false;
  private failureSettled = false;
  private failureError: Error | undefined;
  private maxLiveSeq = 0;
  private baselineCaptured = false;
  private queue: ThreadQueueItem[] = [];
  private queueObserved = false;

  private constructor(
    private readonly baseUrl: string,
    private readonly authToken: string | undefined,
    private readonly threadId: string,
    private readonly onLiveEvent?: (event: ConversationStreamEvent) => void
  ) {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.readyResolve = resolveReady;
    this.readyReject = rejectReady;
    void this.ready.catch(() => undefined);
    let rejectFailure!: (error: Error) => void;
    this.failure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    this.failureReject = rejectFailure;
    void this.failure.catch(() => undefined);
    let resolveEnd!: (seq: number) => void;
    this.end = new Promise<number>((resolve) => { resolveEnd = resolve; });
    this.endResolve = resolveEnd;
  }

  static async open(
    baseUrl: string,
    authToken: string | undefined,
    threadId: string,
    timeoutMs: number,
    signal: AbortSignal,
    onLiveEvent?: (event: ConversationStreamEvent) => void
  ) {
    const subscription = new ThreadSubscription(baseUrl, authToken, threadId, onLiveEvent);
    if (signal.aborted) {
      subscription.fail(new RealtimeError("CodexHub realtime subscription was interrupted."));
      subscription.close();
      throw new RealtimeError("CodexHub realtime subscription was interrupted.");
    }
    try {
      await subscription.connect(timeoutMs, signal);
      return subscription;
    } catch (error) {
      subscription.close();
      throw error;
    }
  }

  private async connect(timeoutMs: number, signal: AbortSignal) {
    const url = new URL("/api/events/ws", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.authToken?.trim()) url.searchParams.set("codexhub_token", this.authToken.trim());
    const timeout = setTimeout(() => this.fail(new RealtimeError("CodexHub realtime subscription timed out.")), timeoutMs);
    const onAbort = () => {
      this.fail(new RealtimeError("CodexHub realtime subscription was interrupted."));
      this.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url.toString());
        this.socket = socket;
        socket.on("open", () => {
          socket.send(JSON.stringify({ type: "subscribe_thread", threadId: this.threadId, after: 0 }));
        });
        socket.on("message", (data) => this.handleMessage(String(data)));
        socket.once("error", (error) => {
          const normalized = new RealtimeError(`CodexHub realtime connection failed: ${error.message}`);
          this.fail(normalized);
          reject(normalized);
        });
        socket.once("close", () => {
          if (!this.intentionallyClosed) {
            const normalized = new RealtimeError("CodexHub realtime connection closed.");
            this.fail(normalized);
            reject(normalized);
          }
        });
        this.ready.then(resolve, reject);
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private handleMessage(raw: string) {
    let message: RealtimeThreadMessage;
    try {
      message = JSON.parse(raw) as RealtimeThreadMessage;
    } catch {
      return;
    }
    if (message.type === "error" && (!message.threadId || message.threadId === this.threadId)) {
      this.fail(new RealtimeError(message.message || "CodexHub realtime subscription failed."));
      return;
    }
    if (message.type === "thread_subscribed" && message.threadId === this.threadId) {
      this.subscribed = true;
      this.maybeReady();
      return;
    }
    if (message.threadId !== this.threadId) return;
    if (Array.isArray(message.queue)) {
      this.queue = message.queue;
      this.queueObserved = true;
    }
    if (!message.historical && typeof message.seq === "number") {
      this.maxLiveSeq = Math.max(this.maxLiveSeq, message.seq);
      this.resolveLiveSeqWaiters();
    }
    if (!message.historical && message.lifecycle === "end") {
      if (typeof message.seq === "number") this.endResolve(message.seq);
      return;
    }
    if (message.kind === "thread") {
      if (message.historical) {
        this.historical = true;
        if (message.snapshot?.reset && !this.baselineCaptured) this.clearRecords();
      }
      this.mergeRecords(message.records, message.historical === true);
      if (!message.historical) {
        for (const record of message.records ?? []) {
          this.onLiveEvent?.({ kind: "record", threadId: this.threadId, seq: message.seq, record });
        }
      }
    } else if (message.kind === "record" && message.record) {
      this.mergeRecords([message.record], message.historical === true);
      if (!message.historical) {
        this.onLiveEvent?.({ kind: "record", threadId: this.threadId, seq: message.seq, record: message.record });
      }
    } else if (message.kind === "record_delta" && message.delta) {
      const record = this.applyDelta(message.delta, message.historical === true);
      if (!message.historical) {
        this.onLiveEvent?.({ kind: "record_delta", threadId: this.threadId, seq: message.seq, delta: message.delta, record });
      }
    }
    this.maybeReady();
  }

  private maybeReady() {
    if (!this.subscribed || !this.historical || this.readySettled) return;
    this.readySettled = true;
    this.readyResolve();
  }

  private clearRecords() {
    this.records.clear();
    this.recordOrder.length = 0;
  }

  private mergeRecords(records: CodexRecord[] | undefined, historical: boolean) {
    for (const record of records ?? []) {
      if (!record || typeof record.id !== "string") continue;
      if (historical && this.liveChangedRecordIds.has(record.id)) continue;
      if (!this.records.has(record.id)) this.recordOrder.push(record.id);
      this.records.set(record.id, record);
      if (!historical && this.baselineCaptured) this.liveChangedRecordIds.add(record.id);
    }
  }

  private applyDelta(delta: NonNullable<RealtimeThreadMessage["delta"]>, historical: boolean) {
    const record = this.records.get(delta.recordId);
    const payload = record ? asRecord(record.payload) : null;
    if (!record || !payload || typeof payload[delta.field] !== "string") return undefined;
    const updated = {
      ...record,
      payload: { ...payload, [delta.field]: `${payload[delta.field]}${delta.append}` }
    } satisfies CodexRecord;
    this.records.set(record.id, updated);
    if (!historical && this.baselineCaptured) this.liveChangedRecordIds.add(record.id);
    return updated;
  }

  captureBaseline() {
    this.baselineCaptured = true;
    this.liveChangedRecordIds.clear();
    return new Map(this.records);
  }

  queuedSubmissionIds() {
    if (!this.queueObserved) {
      throw new RealtimeError("CodexHub realtime thread snapshot did not include a queue field.");
    }
    return this.queue.map((item) => item.submissionId);
  }

  assistantChanges(baseline: Map<string, CodexRecord>) {
    const output: string[] = [];
    for (const id of this.recordOrder) {
      if (!this.liveChangedRecordIds.has(id)) continue;
      const current = this.records.get(id);
      if (!current) continue;
      const currentText = assistantText(current);
      const previousText = assistantText(baseline.get(id));
      if (currentText && currentText !== previousText) output.push(currentText);
    }
    return output;
  }

  async waitForSeq(target: number, timeoutMs: number | undefined, signal: AbortSignal) {
    if (this.maxLiveSeq >= target) return;
    if (this.failureError) throw this.failureError;
    await new Promise<void>((resolve, reject) => {
      let waiter!: {
        target: number;
        resolve: () => void;
        reject: (error: Error) => void;
        timer?: NodeJS.Timeout;
        signal: AbortSignal;
        onAbort: () => void;
      };
      const onAbort = () => {
        clearTimeout(waiter.timer);
        this.liveSeqWaiters.delete(waiter);
        reject(new RealtimeError("CodexHub realtime wait was interrupted."));
      };
      waiter = {
        target,
        resolve,
        reject,
        signal,
        onAbort,
        ...(timeoutMs === undefined ? {} : {
          timer: setTimeout(() => {
            this.liveSeqWaiters.delete(waiter);
            signal.removeEventListener("abort", onAbort);
            reject(new RealtimeError(`CodexHub realtime stream did not reach seq ${target} within ${Math.ceil(timeoutMs / 1000)}s.`));
          }, timeoutMs)
        })
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.liveSeqWaiters.add(waiter);
      this.resolveLiveSeqWaiters();
    });
  }

  async waitForEnd(signal: AbortSignal) {
    if (this.failureError) throw this.failureError;
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const finish = (error?: Error, seq?: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(seq as number);
      };
      const onAbort = () => finish(new RealtimeError("CodexHub realtime end wait was interrupted."));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void this.end.then((seq) => finish(undefined, seq), (error) => finish(error instanceof Error ? error : new Error(String(error))));
      void this.failurePromise().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private resolveLiveSeqWaiters() {
    for (const waiter of [...this.liveSeqWaiters]) {
      if (this.failureError) {
        clearTimeout(waiter.timer);
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        this.liveSeqWaiters.delete(waiter);
        waiter.reject(this.failureError);
        continue;
      }
      if (this.maxLiveSeq < waiter.target) continue;
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.liveSeqWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  failurePromise() {
    return this.failure;
  }

  private fail(error: Error) {
    if (this.failureSettled || this.intentionallyClosed) return;
    this.failureSettled = true;
    this.failureError = error;
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyReject(error);
    }
    this.failureReject(error);
    this.resolveLiveSeqWaiters();
  }

  close() {
    this.intentionallyClosed = true;
    this.socket?.terminate();
  }
}

export const loadQueuedSubmissionIds = async (
  baseUrl: string,
  authToken: string | undefined,
  threadId: string,
  timeoutMs: number,
  signal: AbortSignal
) => {
  const subscription = await ThreadSubscription.open(baseUrl, authToken, threadId, timeoutMs, signal);
  try {
    return subscription.queuedSubmissionIds();
  } finally {
    subscription.close();
  }
};

const assistantText = (record: CodexRecord | undefined) => {
  if (!record) return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;
  if (record.type === "event_msg" && payload.type === "agent_message") {
    return typeof payload.message === "string" && payload.message.trim() ? payload.message : null;
  }
  if (record.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
    return messageTextFromPayload(payload);
  }
  return null;
};
