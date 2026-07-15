import { Telegraf } from "telegraf";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordToView } from "../../src/core/codexRecordView.js";
import type { CodexRecord, CodexRecordView } from "../../src/shared/recordTypes.js";
import type { ProxyInput } from "../../src/shared/inputTypes.js";
import { loadDotEnv } from "../../src/core/dotenv.js";
import { compactRecordView, createCompactRecordViewState, type CompactRecordView } from "../../src/shared/compactRecordViews.js";
import type {
  SessionSummary,
  ThreadDetail,
  ThreadRateLimitUsage,
  ThreadSummary,
  ThreadTurnPayload,
  ThreadUsage
} from "../../src/shared/apiContract.js";

type ChatState = {
  sessionId?: string;
  threadId?: string;
};

type ChatMirror = {
  sessionId: string;
  controller: AbortController;
  threadController?: AbortController;
  threadId?: string;
  knownRecordIds: Set<string>;
  compactState: ReturnType<typeof createCompactRecordViewState>;
  sentMessages: Map<string, { messageId: number; status: string }>;
};

type SessionStreamEvent = {
  seq: number;
  kind: "sessions";
  sessions: SessionSummary[];
};

export type TelegramBotOptions = {
  token: string;
  apiBaseUrl?: string;
  apiAuthToken?: string | null;
  allowedChatIds?: Set<number>;
  logger?: Pick<Console, "error" | "log">;
};

export type TelegramBotHandle = {
  apiBaseUrl: string;
  stop: (reason?: string) => void;
};

let bot: Telegraf;
let apiBaseUrl = "http://127.0.0.1:8788";
let apiAuthToken: string | null = null;
let allowedChatIds = new Set<number>();
let logger: Pick<Console, "error" | "log"> = console;
let startedBot: TelegramBotHandle | null = null;
const chatStates = new Map<number, ChatState>();
const selectionOptions = new Map<string, ChatState>();
const chatMirrors = new Map<number, ChatMirror>();
let selectionSeq = 0;

const botCommands = [
  { command: "start", description: "show help" },
  { command: "sessions", description: "select a Codex session" },
  { command: "detach", description: "clear current session selection" },
  { command: "status", description: "show current session" }
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
      "codexhub ready.",
      "",
      "/sessions 选择在线 Codex session",
      "/detach 取消当前 session 绑定",
	      "/status 查看当前状态",
	      "",
	      "先选择 session，再选择 thread。之后直接发消息会发送给这个 chat 绑定的 thread。"
	    ].join("\n"));
	  });

  const handleSessionsCommand = async (ctx: any) => {
    try {
      const sessions = await listRunnableSessions();

      if (!sessions.length) {
        await ctx.reply("当前没有在线 Codex session。请先在 codexhub 里打开一个 project。");
        return;
      }

      await ctx.reply("选择在线 Codex session：", {
        reply_markup: {
          inline_keyboard: sessions.map((session) => ([{
            text: `${displaySessionId(session)}  ${sessionStatusLabel(session)}  ${sessionThreadCountLabel(session)}  ${shortPath(session.workingDirectory)}`,
            callback_data: `select_session:${rememberSelection(ctx.chat.id, { sessionId: session.sessionId })}`
          }]))
        }
      });
    } catch (error) {
      await ctx.reply(errorText(error));
    }
  };

  bot.command("sessions", handleSessionsCommand);

  bot.command("detach", async (ctx) => {
    const detached = detachSession(ctx.chat.id);
    await ctx.reply(detached
      ? "已取消当前 session 绑定。用 /sessions 重新选择在线 session。"
      : "当前没有绑定 Codex session。用 /sessions 选择在线 session。");
  });

  bot.command("status", async (ctx) => {
    try {
      const state = chatStates.get(ctx.chat.id);
      const current = state ? await resolveSelectedSession(state).catch(() => null) : null;
      const sessions = await listRunnableSessions();
      const thread = state?.threadId ? await getThread(state.threadId).catch(() => null) : null;
      const usage = thread?.threadUsage ?? null;
      await ctx.reply([
        `当前 session：${current ? displaySessionId(current) : "(none)"}`,
        `当前 thread：${thread ? displayThreadId(thread) : "(none)"}`,
        current ? `文件夹：${current.workingDirectory}` : null,
        thread ? `thread：${shortId(thread.threadId)}` : null,
        thread ? `session：${sessionLabel(thread)}` : null,
        `usage：${formatThreadUsage(usage)}`,
        "",
        sessions.length
          ? sessions.map((session) => `${displaySessionId(session)} ${sessionStatusLabel(session)} ${sessionThreadCountLabel(session)}`).join("\n")
          : "当前没有在线 Codex session。"
      ].filter(Boolean).join("\n"));
    } catch (error) {
      await ctx.reply(errorText(error));
    }
  });

  bot.action(/^select_session:(.+)$/, async (ctx) => {
    try {
      const selection = selectionOptions.get(selectionKey(ctx.chat!.id, ctx.match[1]));
      if (!selection?.sessionId) throw new Error("Selection expired. Use /sessions to choose again.");
      const session = await resolveSession(selection.sessionId);
      await ctx.answerCbQuery("Selected");
      await showThreadSelection(ctx, session);
    } catch (error) {
      await ctx.answerCbQuery("Failed");
      await ctx.reply(errorText(error));
    }
  });

  bot.action(/^select_thread:(.+)$/, async (ctx) => {
    try {
      const selection = selectionOptions.get(selectionKey(ctx.chat!.id, ctx.match[1]));
      if (!selection?.sessionId || !selection.threadId) throw new Error("Selection expired. Use /sessions to choose again.");
      const session = await selectThread(ctx.chat!.id, selection.sessionId, selection.threadId);
      const thread = await getThread(selection.threadId);
      await ctx.answerCbQuery("Selected");
      await ctx.editMessageText([
        `已选择 session：${displaySessionId(session)}`,
        `已绑定 thread：${displayThreadId(thread)} ${thread.status}`,
        session.workingDirectory
      ].join("\n"));
    } catch (error) {
      await ctx.answerCbQuery("Failed");
      await ctx.reply(errorText(error));
    }
  });

  bot.action(/^new_thread:(.+)$/, async (ctx) => {
    try {
      const selection = selectionOptions.get(selectionKey(ctx.chat!.id, ctx.match[1]));
      if (!selection?.sessionId) throw new Error("Selection expired. Use /sessions to choose again.");
      const thread = await createSessionThread(selection.sessionId);
      const session = await selectThread(ctx.chat!.id, selection.sessionId, thread.threadId);
      await ctx.answerCbQuery("Created");
      await ctx.editMessageText([
        `已选择 session：${displaySessionId(session)}`,
        `已新建 thread：${displayThreadId(thread)} ${thread.status}`,
        session.workingDirectory
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

const showThreadSelection = async (ctx: any, session: SessionSummary) => {
  const threads = [...(session.threads ?? [])]
    .sort((left, right) => Number(right.running) - Number(left.running) || right.updatedAt.localeCompare(left.updatedAt));
  await ctx.editMessageText([
    `已选择 session：${displaySessionId(session)}`,
    session.workingDirectory,
    "",
    "选择 thread："
  ].join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [{
          text: "New thread",
          callback_data: `new_thread:${rememberSelection(ctx.chat!.id, { sessionId: session.sessionId })}`
        }],
        ...threads.map((thread) => ([{
          text: `${displayThreadId(thread)}  ${thread.status}  ${thread.title || "(untitled)"}`,
          callback_data: `select_thread:${rememberSelection(ctx.chat!.id, { sessionId: session.sessionId, threadId: thread.threadId })}`
        }]))
      ]
    }
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
  const session = state ? await resolveSelectedSession(state).catch(() => null) : null;
  if (!session) {
    await ctx.reply("当前没有选择 Codex session。用 /sessions 选择在线 session。");
    return;
  }
  if (!session.online) {
    await ctx.reply("当前 Codex session 已离线。请用 /sessions 重新选择。");
    return;
  }
  if (!state?.threadId) {
    await ctx.reply("当前 chat 没有绑定 thread。请用 /sessions 选择 session 后再选择 thread。");
    return;
  }
  const threadId = state.threadId;
  startChatMirror(ctx.chat.id, session.sessionId, threadId);
  const statusMessage = await ctx.reply([
    "Codex queued...",
    `folder: ${session.workingDirectory}`,
    `thread: ${shortId(threadId)}`,
    images.length ? `images: ${images.length}` : null
  ].filter(Boolean).join("\n"));

  try {
    let input: ProxyInput = prompt;
    if (images.length) {
      const imageUrls = await Promise.all(images.map((image) => telegramImageUrl(image.fileId)));
      input = [
        ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
        ...imageUrls.map((url) => ({ type: "image" as const, url }))
      ];
    }
    await postThreadTurn(threadId, input);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      [
        "Codex queued.",
        `thread: ${shortId(threadId)}`,
        "output: mirrored below"
      ].join("\n")
    );
  } catch (error) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, clampTelegram(errorText(error)));
  }
};

const selectThread = async (chatId: number, sessionId: string, threadId: string) => {
  const session = await resolveSession(sessionId);
  if (!session.threads?.some((thread) => thread.threadId === threadId)) {
    await getThread(threadId);
  }
  chatStates.set(chatId, { sessionId: session.sessionId, threadId });
  startChatMirror(chatId, session.sessionId, threadId);
  return session;
};

const detachSession = (chatId: number) => {
  const hadState = chatStates.delete(chatId);
  const hadMirror = stopChatMirror(chatId);
  return hadState || hadMirror;
};

const listSessions = async (): Promise<SessionSummary[]> => {
  const data = await apiJson<{ sessions?: SessionSummary[] }>("/api/sessions");
  return normalizeSessions(data.sessions);
};

const listRunnableSessions = async (): Promise<SessionSummary[]> =>
  (await listSessions()).filter((session) => session.online);

const resolveSession = async (sessionId: string) => {
  const session = (await listSessions()).find((item) => item.sessionId === sessionId);
  if (!session) throw new Error("Selected session is no longer online. Use /sessions to choose again.");
  return session;
};

const resolveSelectedSession = async (state: ChatState) => {
  if (!state.sessionId) throw new Error("No selected session.");
  return resolveSession(state.sessionId);
};

const getThread = (threadId: string) => apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`);

const createSessionThread = async (sessionId: string) =>
  apiJson<ThreadDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "new" })
  });

const postThreadTurn = async (threadId: string, input: ProxyInput) => {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, source: "telegram" })
  });
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as ThreadTurnPayload;
};

const telegramImageUrl = async (fileId: string) => {
  const link = await bot.telegram.getFileLink(fileId);
  return link.toString();
};

const startChatMirror = (chatId: number, sessionId: string, threadId: string) => {
  const existing = chatMirrors.get(chatId);
  if (existing?.sessionId === sessionId && existing.threadId === threadId && !existing.controller.signal.aborted) return existing;
  stopChatMirror(chatId);

  const mirror: ChatMirror = {
    sessionId,
    controller: new AbortController(),
    threadId,
    knownRecordIds: new Set(),
    compactState: createCompactRecordViewState(),
    sentMessages: new Map()
  };
  chatMirrors.set(chatId, mirror);
  void switchMirrorThread(chatId, mirror, threadId).catch((error) => {
    if (!isAbortError(error)) logger.error("telegram thread mirror failed", error);
  });
  void runSessionMirror(chatId, mirror).catch((error) => {
    if (!isAbortError(error)) logger.error("telegram session mirror failed", error);
  });
  return mirror;
};

const stopChatMirror = (chatId: number) => {
  const mirror = chatMirrors.get(chatId);
  if (!mirror) return false;
  mirror.controller.abort();
  mirror.threadController?.abort();
  chatMirrors.delete(chatId);
  return true;
};

const runSessionMirror = async (chatId: number, mirror: ChatMirror) => {
  const stream = await openSessionEventStream(0, mirror.controller.signal);
  for await (const event of stream) {
    if (mirror.controller.signal.aborted) return;
    const session = event.sessions.find((item) => item.sessionId === mirror.sessionId && item.online);
    if (!session) {
      await bot.telegram.sendMessage(chatId, "当前 Codex session 已离线。请用 /sessions 重新选择。").catch(() => undefined);
      chatMirrors.delete(chatId);
      mirror.controller.abort();
      return;
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

const openSessionEventStream = async (after: number, signal?: AbortSignal): Promise<AsyncGenerator<SessionStreamEvent>> => {
  const response = await apiFetch(`/api/sessions/events?after=${after}`, { signal });
  if (!response.ok || !response.body) throw new Error(`API HTTP ${response.status}`);

  return streamSseEvents<SessionStreamEvent>(response.body.getReader());
};

const openThreadEventStream = async (threadId: string, after: number, signal?: AbortSignal): Promise<AsyncGenerator<any>> => {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/events?after=${after}`, { signal });
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
  const response = await apiFetch(path, init);
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};

const apiUrl = (path: string) => new URL(path, apiBaseUrl).toString();
const apiFetch = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (apiAuthToken && !headers.has("authorization")) headers.set("authorization", `Bearer ${apiAuthToken}`);
  return fetch(apiUrl(path), { ...init, headers });
};
const shortId = (id: string) => id.slice(0, 8);
const selectionKey = (chatId: number, token: string) => `${chatId}:${token}`;
const rememberSelection = (chatId: number, state: ChatState) => {
  const token = (++selectionSeq).toString(36);
  selectionOptions.set(selectionKey(chatId, token), state);
  return token;
};
const normalizeSessions = (sessions: SessionSummary[] | undefined) =>
  Array.isArray(sessions) ? sessions.filter((session) => session.online) : [];
const displayThreadId = (thread: Pick<ThreadSummary, "threadId">) => shortId(thread.threadId);
const displaySessionId = (session: Pick<SessionSummary, "sessionId" | "name">) => session.name ?? shortId(session.sessionId);
const sessionThreads = (session: Pick<SessionSummary, "threads">) => session.threads ?? [];
const sessionStatusLabel = (session: Pick<SessionSummary, "threads">) =>
  sessionThreads(session).some((thread) => thread.running || thread.status === "running") ? "running" : "idle";
const sessionThreadCountLabel = (session: Pick<SessionSummary, "threads">) => {
  const count = sessionThreads(session).length;
  return `${count} thread${count === 1 ? "" : "s"}`;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const isAbortError = (error: unknown) => error instanceof Error && error.name === "AbortError";
const sessionLabel = (thread: Pick<ThreadSummary, "session">) => {
  const state = thread.session.runnable ? "runnable" : "unavailable";
  const session = thread.session.sessionId;
  return `${state}${session ? `:${thread.session.name ?? shortId(session)}` : ""}`;
};
const shortPath = (value: string) => {
  const home = process.env.HOME;
  if (home && value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
};
const formatThreadUsage = (usage: ThreadUsage | null) => [
  `context ${formatContextUsage(usage)}`,
  `5h ${formatRateLimitRemaining(usage?.primaryRateLimit)}`,
  `weekly ${formatRateLimitRemaining(usage?.secondaryRateLimit)}`
].filter(Boolean).join(" · ");
const formatContextUsage = (usage: ThreadUsage | null) => {
  const context = usage?.context;
  if (!context) return "--";
  return `${formatPercent((context.usedTokens / context.windowTokens) * 100)}`;
};
const formatRateLimitRemaining = (window: ThreadRateLimitUsage | null | undefined) => {
  if (!window) return "--";
  return formatPercent(100 - window.usedPercent);
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
  apiAuthToken = options.apiAuthToken ?? process.env.CODEX_HUB_AUTH_TOKEN?.trim() ?? null;
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
      logger.error("codexhub telegram bot stopped", error);
    });
  logger.log(`codexhub telegram bot started, api=${apiBaseUrl}`);
  return startedBot;
};

export const startTelegramBotFromEnv = async (options: {
  apiBaseUrl?: string;
  apiAuthToken?: string | null;
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
    apiBaseUrl: process.env.CODEX_HUB_SERVER_URL ?? options.apiBaseUrl,
    apiAuthToken: options.apiAuthToken ?? process.env.CODEX_HUB_AUTH_TOKEN,
    allowedChatIds: parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    logger: options.logger
  });
};

const isCliEntrypoint = () => {
  const entrypoint = process.argv[1];
  const modulePath = moduleFilePath();
  return Boolean(entrypoint && modulePath && path.resolve(entrypoint) === modulePath);
};

const moduleFilePath = () => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
};

if (isCliEntrypoint()) {
  void (async () => {
    await loadDotEnv();
    const handle = await startTelegramBotFromEnv();
    process.once("SIGINT", () => handle?.stop("SIGINT"));
    process.once("SIGTERM", () => handle?.stop("SIGTERM"));
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
