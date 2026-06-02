import { Telegraf } from "telegraf";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexRecord } from "../core/codexRecord.js";
import { recordToView, type CodexRecordView } from "../core/codexRecordView.js";
import { loadDotEnv } from "../core/dotenv.js";
import { compactRecordView, createCompactRecordViewState, type CompactRecordView } from "../shared/compactRecordViews.js";

type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  runtime: ThreadRuntimeSummary;
  status: ThreadStatus;
  running: boolean;
  title: string;
  updatedAt: string;
  messageCount: number;
  codexUsage?: CodexUsageSnapshot;
};

type ThreadRuntimeSummary = {
  workerId?: string;
  name?: string;
  online: boolean;
  runnable: boolean;
};

type ThreadDetail = ThreadSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

type WorkerSummary = {
  workerId: string;
  name?: string;
  workingDirectory: string;
  online: boolean;
  currentThreadId?: string;
  currentThread?: ThreadSummary;
  threads?: ThreadSummary[];
  codexUsage?: CodexUsageSnapshot;
};

type ThreadStatus = "running" | "idle";

type TurnInput = string | Array<
  | { type: "text"; text: string }
  | { type: "image"; url: string }
>;

type RateLimitWindow = {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
};

type CodexUsageSnapshot = {
  rateLimits: {
    primary?: RateLimitWindow | null;
    secondary?: RateLimitWindow | null;
  } | null;
  source: "latest" | "thread";
};

type ChatState = {
  workerId?: string;
};

type ChatMirror = {
  workerId: string;
  controller: AbortController;
  threadController?: AbortController;
  threadId?: string;
  knownRecordIds: Set<string>;
  compactState: ReturnType<typeof createCompactRecordViewState>;
  sentMessages: Map<string, { messageId: number; status: string }>;
};

type WorkerStreamEvent = {
  seq: number;
  kind: "workers";
  workers: WorkerSummary[];
};

export type TelegramBotOptions = {
  token: string;
  apiBaseUrl?: string;
  allowedChatIds?: Set<number>;
  logger?: Pick<Console, "error" | "log">;
};

export type TelegramBotHandle = {
  apiBaseUrl: string;
  stop: (reason?: string) => void;
};

let bot: Telegraf;
let apiBaseUrl = "http://127.0.0.1:8788";
let allowedChatIds = new Set<number>();
let logger: Pick<Console, "error" | "log"> = console;
let startedBot: TelegramBotHandle | null = null;
const chatStates = new Map<number, ChatState>();
const selectionOptions = new Map<string, ChatState>();
const chatMirrors = new Map<number, ChatMirror>();
let selectionSeq = 0;

const botCommands = [
  { command: "start", description: "show help" },
  { command: "workers", description: "select a Codex worker" },
  { command: "status", description: "show current worker" }
];

const registerHandlers = () => {
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (allowedChatIds.size && chatId !== undefined && !allowedChatIds.has(chatId)) {
      if (ctx.callbackQuery) await ctx.answerCbQuery("Unauthorized").catch(() => undefined);
      return;
    }
    await next();
  });

  bot.start(async (ctx) => {
    return ctx.reply([
      "codex-proxy ready.",
      "",
      "/workers 选择在线 Codex worker",
      "/status 查看当前状态",
      "",
      "直接发消息会发送给当前 worker 指向的 Codex thread。新 thread 请在本地 codexp 里开始。"
    ].join("\n"));
  });

  bot.command("workers", async (ctx) => {
    try {
      const workers = await listRunnableWorkers();

      if (!workers.length) {
        await ctx.reply("当前没有可运行的 Codex worker。请先在本地 codexp 里打开或 resume 一个 thread。");
        return;
      }

      await ctx.reply("选择在线 Codex worker：", {
        reply_markup: {
          inline_keyboard: workers.map((worker) => ([{
            text: `${displayWorkerId(worker)}  ${worker.currentThread?.status ?? "idle"}  ${worker.currentThread ? displayThreadId(worker.currentThread) : "no thread"}  ${shortPath(worker.workingDirectory)}`,
            callback_data: `select:${rememberSelection(ctx.chat.id, worker.workerId)}`
          }]))
        }
      });
    } catch (error) {
      await ctx.reply(errorText(error));
    }
  });

  bot.command("status", async (ctx) => {
    try {
      const state = chatStates.get(ctx.chat.id);
      const current = state ? await resolveSelectedWorker(state).catch(() => null) : null;
      const workers = await listRunnableWorkers();
      const usage = current?.currentThread?.codexUsage ?? current?.codexUsage ?? null;
      await ctx.reply([
        `当前 worker：${current ? displayWorkerId(current) : "(none)"}`,
        `当前 thread：${current?.currentThread ? displayThreadId(current.currentThread) : "(none)"}`,
        current ? `文件夹：${current.workingDirectory}` : null,
        current?.currentThreadId ? `thread：${shortId(current.currentThreadId)}` : null,
        current?.currentThread ? `runtime：${runtimeLabel(current.currentThread)}` : null,
        `usage：${formatCodexUsage(usage)}`,
        "",
        workers.length
          ? workers.map((worker) => `${displayWorkerId(worker)} ${worker.currentThread ? displayThreadId(worker.currentThread) : "no-thread"} ${worker.currentThread?.status ?? "idle"}`).join("\n")
          : "当前没有可运行的 Codex worker。"
      ].filter(Boolean).join("\n"));
    } catch (error) {
      await ctx.reply(errorText(error));
    }
  });

  bot.action(/^select:(.+)$/, async (ctx) => {
    try {
      const selection = selectionOptions.get(selectionKey(ctx.chat!.id, ctx.match[1]));
      if (!selection?.workerId) throw new Error("Selection expired. Use /workers to choose again.");
      const worker = await selectWorker(ctx.chat!.id, selection.workerId);
      await ctx.answerCbQuery("Selected");
      await ctx.editMessageText([
        `已选择 worker：${displayWorkerId(worker)}`,
        worker.currentThread ? `当前 thread：${displayThreadId(worker.currentThread)} ${worker.currentThread.status}` : "当前 thread：(none)",
        worker.workingDirectory
      ].join("\n"));
    } catch (error) {
      await ctx.answerCbQuery("Failed");
      await ctx.reply(errorText(error));
    }
  });

  bot.on("text", async (ctx) => {
    const prompt = ctx.message.text.trim();
    if (!prompt || prompt.startsWith("/")) return;
    runPromptInBackground(ctx, prompt, []);
  });

  bot.on("photo", async (ctx) => {
    const prompt = ctx.message.caption?.trim() || "请分析这张图片。";
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    runPromptInBackground(ctx, prompt, [{ fileId: photo.file_id, filename: `${photo.file_id}.jpg` }]);
  });

  bot.on("document", async (ctx) => {
    const document = ctx.message.document;
    if (!document.mime_type?.startsWith("image/")) return;
    const prompt = ctx.message.caption?.trim() || "请分析这张图片。";
    runPromptInBackground(ctx, prompt, [{ fileId: document.file_id, filename: document.file_name ?? `${document.file_id}.png` }]);
  });
};

const runPromptInBackground = (
  ctx: any,
  prompt: string,
  images: Array<{ fileId: string; filename: string }>
) => {
  void runPrompt(ctx, prompt, images).catch((error) => {
    logger.error("Unhandled background runPrompt error", error);
  });
};

const runPrompt = async (
  ctx: any,
  prompt: string,
  images: Array<{ fileId: string; filename: string }>
) => {
  const state = chatStates.get(ctx.chat.id);
  const worker = state ? await resolveSelectedWorker(state).catch(() => null) : null;
  if (!worker) {
    await ctx.reply("当前没有选择 Codex worker。用 /workers 选择在线 worker。");
    return;
  }
  if (!worker.online) {
    await ctx.reply("当前 Codex worker 已离线。请用 /workers 重新选择。");
    return;
  }
  if (!worker.currentThreadId) {
    await ctx.reply("当前 worker 没有打开 thread。请先在本地 Codex 里开始或 resume 一个 thread。");
    return;
  }
  const mirror = startChatMirror(ctx.chat.id, worker.workerId);
  const thread = await getThread(worker.currentThreadId);
  const statusMessage = await ctx.reply([
    "Codex running...",
    `folder: ${thread.workingDirectory}`,
    `thread: ${displayThreadId(thread)}`,
    images.length ? `images: ${images.length}` : null
  ].filter(Boolean).join("\n"));
  let sentItemCount = 0;
  const forwardRecord = async (record: CodexRecord) => {
    if (await forwardRecordToChat(ctx.chat.id, mirror, record)) sentItemCount += 1;
  };

  try {
    let input: TurnInput = prompt;
    if (images.length) {
      const imageUrls = await Promise.all(images.map((image) => telegramImageUrl(image.fileId)));
      input = [
        ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
        ...imageUrls.map((url) => ({ type: "image" as const, url }))
      ];
    }
    const stream = await openThreadEventStream(thread.threadId, thread.lastSeq);
    await postTurn(thread.threadId, input);

    for await (const event of stream) {
      if (event.kind === "record" && event.record) {
        await forwardRecord(event.record);
      }
      if (event.kind === "done") break;
    }

    const latest = await getThread(thread.threadId).catch(() => null);
    for (const record of latest?.records ?? []) {
      await forwardRecord(record);
    }
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      [
        "Codex completed.",
        `thread: ${latest ? displayThreadId(latest) : shortId(thread.threadId)}`,
        `messages: ${sentItemCount}`
      ].join("\n")
    );
  } catch (error) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, clampTelegram(errorText(error)));
  }
};

const selectWorker = async (chatId: number, workerId: string) => {
  const worker = await resolveWorker(workerId);
  chatStates.set(chatId, { workerId: worker.workerId });
  startChatMirror(chatId, worker.workerId);
  return worker;
};

const listWorkers = async (): Promise<WorkerSummary[]> => {
  const data = await apiJson<{ workers?: WorkerSummary[] }>("/api/workers");
  return normalizeWorkers(data.workers);
};

const listRunnableWorkers = async (): Promise<WorkerSummary[]> =>
  (await listWorkers()).filter((worker) => worker.online);

const resolveWorker = async (workerId: string) => {
  const worker = (await listWorkers()).find((item) => item.workerId === workerId);
  if (!worker) throw new Error("Selected worker is no longer online. Use /workers to choose again.");
  return worker;
};

const resolveSelectedWorker = async (state: ChatState) => {
  if (!state.workerId) throw new Error("No selected worker.");
  return resolveWorker(state.workerId);
};

const getThread = (threadId: string) => apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`);

const postTurn = async (threadId: string, input: TurnInput) => {
  const response = await fetch(apiUrl(`/api/threads/${encodeURIComponent(threadId)}/turn`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, source: "telegram" })
  });
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
};

const telegramImageUrl = async (fileId: string) => {
  const link = await bot.telegram.getFileLink(fileId);
  return link.toString();
};

const startChatMirror = (chatId: number, workerId: string) => {
  const existing = chatMirrors.get(chatId);
  if (existing?.workerId === workerId && !existing.controller.signal.aborted) return existing;
  existing?.controller.abort();

  const mirror: ChatMirror = {
    workerId,
    controller: new AbortController(),
    knownRecordIds: new Set(),
    compactState: createCompactRecordViewState(),
    sentMessages: new Map()
  };
  chatMirrors.set(chatId, mirror);
  void runWorkerMirror(chatId, mirror).catch((error) => {
    if (!isAbortError(error)) logger.error("telegram worker mirror failed", error);
  });
  return mirror;
};

const runWorkerMirror = async (chatId: number, mirror: ChatMirror) => {
  const stream = await openWorkerEventStream(0, mirror.controller.signal);
  for await (const event of stream) {
    if (mirror.controller.signal.aborted) return;
    const worker = event.workers.find((item) => item.workerId === mirror.workerId && item.online);
    if (!worker) {
      await bot.telegram.sendMessage(chatId, "当前 Codex worker 已离线。请用 /workers 重新选择。").catch(() => undefined);
      chatMirrors.delete(chatId);
      mirror.controller.abort();
      return;
    }
    if (worker.currentThreadId && worker.currentThreadId !== mirror.threadId) {
      await switchMirrorThread(chatId, mirror, worker.currentThreadId);
    }
  }
};

const switchMirrorThread = async (chatId: number, mirror: ChatMirror, threadId: string) => {
  mirror.threadController?.abort();
  const threadController = new AbortController();
  mirror.threadController = threadController;
  mirror.threadId = threadId;
  mirror.compactState = createCompactRecordViewState();
  mirror.sentMessages.clear();

  const thread = await getThread(threadId);
  mirror.knownRecordIds = new Set(thread.records.map((record) => record.id));
  const stream = await openThreadEventStream(thread.threadId, thread.lastSeq, threadController.signal);
  void (async () => {
    try {
      for await (const event of stream) {
        if (threadController.signal.aborted || mirror.controller.signal.aborted) return;
        if (event.kind === "record" && event.record) await forwardRecordToChat(chatId, mirror, event.record);
      }
    } catch (error) {
      if (!isAbortError(error)) logger.error("telegram thread mirror failed", error);
    }
  })();
};

const forwardRecordToChat = async (chatId: number, mirror: ChatMirror, record: CodexRecord) => {
  if (mirror.knownRecordIds.has(record.id)) return false;
  mirror.knownRecordIds.add(record.id);

  const view = recordToView(record);
  if (!view) return false;
  const change = compactRecordView(mirror.compactState, view);
  if (!shouldForwardView(change.view, mirror.sentMessages)) return false;

  const text = clampTelegram(formatBlock(change.view.label ?? change.view.role, change.view.text, change.view.status));
  const existing = mirror.sentMessages.get(change.previousId ?? change.view.id);
  if (!change.appended && existing) {
    await bot.telegram.editMessageText(chatId, existing.messageId, undefined, text);
    mirror.sentMessages.delete(change.previousId ?? change.view.id);
    mirror.sentMessages.set(change.view.id, { messageId: existing.messageId, status: change.view.status ?? "final" });
    return false;
  }

  const message = await bot.telegram.sendMessage(chatId, text);
  mirror.sentMessages.set(change.view.id, { messageId: message.message_id, status: change.view.status ?? "final" });
  return true;
};

const openWorkerEventStream = async (after: number, signal?: AbortSignal): Promise<AsyncGenerator<WorkerStreamEvent>> => {
  const response = await fetch(apiUrl(`/api/workers/events?after=${after}`), { signal });
  if (!response.ok || !response.body) throw new Error(`API HTTP ${response.status}`);

  return streamSseEvents<WorkerStreamEvent>(response.body.getReader());
};

const openThreadEventStream = async (threadId: string, after: number, signal?: AbortSignal): Promise<AsyncGenerator<any>> => {
  const response = await fetch(apiUrl(`/api/threads/${encodeURIComponent(threadId)}/events?after=${after}`), { signal });
  if (!response.ok || !response.body) throw new Error(`API HTTP ${response.status}`);

  return streamSseEvents(response.body.getReader());
};

const streamSseEvents = async function* <T>(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        yield JSON.parse(dataLine.slice(6)) as T;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

const apiJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), init);
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};

const apiUrl = (path: string) => new URL(path, apiBaseUrl).toString();
const shortId = (id: string) => id.slice(0, 8);
const selectionKey = (chatId: number, token: string) => `${chatId}:${token}`;
const rememberSelection = (chatId: number, workerId: string) => {
  const token = (++selectionSeq).toString(36);
  selectionOptions.set(selectionKey(chatId, token), { workerId });
  return token;
};
const normalizeWorkers = (workers: WorkerSummary[] | undefined) =>
  Array.isArray(workers) ? workers.filter((worker) => worker.online) : [];
const displayThreadId = (thread: Pick<ThreadSummary, "threadId">) => shortId(thread.threadId);
const displayWorkerId = (worker: Pick<WorkerSummary, "workerId" | "name">) => worker.name ?? shortId(worker.workerId);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const isAbortError = (error: unknown) => error instanceof Error && error.name === "AbortError";
const runtimeLabel = (thread: Pick<ThreadSummary, "runtime">) => {
  const state = thread.runtime.runnable ? "runnable" : "unavailable";
  const worker = thread.runtime.workerId ? `:${thread.runtime.name ?? shortId(thread.runtime.workerId)}` : "";
  return `${state}${worker}`;
};
const shortPath = (value: string) => {
  const home = process.env.HOME;
  if (home && value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
};
const formatCodexUsage = (usage: CodexUsageSnapshot | null) => [
  `5h ${formatRateLimitRemaining(usage?.rateLimits?.primary)}`,
  `weekly ${formatRateLimitRemaining(usage?.rateLimits?.secondary)}`,
  usage ? `source ${usage.source}` : null
].filter(Boolean).join(" · ");
const formatRateLimitRemaining = (window: RateLimitWindow | null | undefined) => {
  if (!window) return "--";
  return formatPercent(100 - window.used_percent);
};
const formatPercent = (value: number) => {
  if (!Number.isFinite(value)) return "--";
  const normalized = Math.max(0, Math.min(100, value));
  return `${Number.isInteger(normalized) ? normalized : normalized.toFixed(1)}%`;
};
const formatBlock = (label: string, text: string, status?: CodexRecordView["status"]) =>
  `[${[label, status].filter(Boolean).join(" · ")}]\n${text}`;

const shouldForwardView = (view: CompactRecordView, sentMessages: Map<string, { status: string }>) => {
  if (view.role === "user") return false;
  const status = view.status ?? "final";
  const previousStatus = sentMessages.get(view.id)?.status;
  if (view.role !== "tool") {
    if (previousStatus) return false;
    return true;
  }

  if (status === "pending") {
    if (previousStatus) return false;
    return true;
  }

  if (previousStatus === status) return false;
  return true;
};

const clampTelegram = (text: string) => {
  if (text.length <= 3900) return text;
  return `${text.slice(0, 3900)}\n\n[truncated]`;
};

export const parseAllowedChatIds = (value: string | undefined) => new Set(
  (value ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter(Number.isFinite)
);

export const startTelegramBot = async (options: TelegramBotOptions): Promise<TelegramBotHandle> => {
  if (startedBot) return startedBot;
  const currentBot = new Telegraf(options.token);
  bot = currentBot;
  apiBaseUrl = options.apiBaseUrl ?? "http://127.0.0.1:8788";
  allowedChatIds = options.allowedChatIds ?? new Set<number>();
  logger = options.logger ?? console;
  chatStates.clear();
  selectionOptions.clear();
  for (const mirror of chatMirrors.values()) mirror.controller.abort();
  chatMirrors.clear();
  selectionSeq = 0;
  registerHandlers();

  await bot.telegram.setMyCommands(botCommands);
  startedBot = {
    apiBaseUrl,
    stop: (reason = "shutdown") => {
      currentBot.stop(reason);
      if (bot === currentBot) startedBot = null;
    }
  };
  void currentBot.launch()
    .then(() => {
      if (bot === currentBot) startedBot = null;
    })
    .catch((error: unknown) => {
      if (bot === currentBot) startedBot = null;
      logger.error("codex-proxy telegram bot stopped", error);
    });
  logger.log(`codex-proxy telegram bot started, api=${apiBaseUrl}`);
  return startedBot;
};

export const startTelegramBotFromEnv = async (options: {
  apiBaseUrl?: string;
  requireToken?: boolean;
  logger?: Pick<Console, "error" | "log">;
} = {}): Promise<TelegramBotHandle | null> => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const requireToken = options.requireToken ?? true;
  if (!token) {
    if (requireToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
    return null;
  }
  return startTelegramBot({
    token,
    apiBaseUrl: process.env.CODEX_PROXY_SERVER_URL ?? options.apiBaseUrl,
    allowedChatIds: parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    logger: options.logger
  });
};

const isCliEntrypoint = () => {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && path.resolve(entrypoint) === fileURLToPath(import.meta.url));
};

if (isCliEntrypoint()) {
  await loadDotEnv();
  const handle = await startTelegramBotFromEnv();
  process.once("SIGINT", () => handle?.stop("SIGINT"));
  process.once("SIGTERM", () => handle?.stop("SIGTERM"));
}
