import { Telegraf } from "telegraf";
import type { CodexRecord } from "../core/codexRecord.js";
import { recordToView, type CodexRecordView } from "../core/codexRecordView.js";
import { compactRecordView, createCompactRecordViewState, type CompactRecordView } from "../shared/compactRecordViews.js";

type DirectoryListing = {
  path: string;
  parent: string | null;
  children: Array<{ name: string; path: string; hasChildren: boolean }>;
};

type InstanceSummary = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  running: boolean;
  attachCount: number;
  title: string;
  updatedAt: string;
  messageCount: number;
};

type InstanceDetail = InstanceSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

type TurnInput = string | Array<
  | { type: "text"; text: string }
  | { type: "local_image"; path: string }
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
  instanceId?: string;
};

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const apiBaseUrl = process.env.CODEX_PROXY_API_URL ?? "http://127.0.0.1:8788";
const allowedChatIds = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite)
);
const bot = new Telegraf(token);
const chatStates = new Map<number, ChatState>();
const folderPickers = new Map<number, DirectoryListing>();
const lastFolderPaths = new Map<number, string>();

const botCommands = [
  { command: "start", description: "show help" },
  { command: "status", description: "show current instance" },
  { command: "instances", description: "attach a Codex instance" },
  { command: "new", description: "choose a folder and create an instance" },
  { command: "stop", description: "stop the current turn" }
];

const tgClientId = (chatId: number) => `telegram-${chatId}`;

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
    "/instances 打开已有 Codex 实例",
    "/new 选择文件夹并创建 Codex 实例",
    "/stop 停止当前 turn",
    "/status 查看当前状态",
    "",
    "直接发消息会发送给当前 Codex 实例。"
  ].join("\n"));
});

bot.command("instances", async (ctx) => {
  try {
    const instances = await listInstances();

    if (!instances.length) {
      await ctx.reply("当前没有可打开的 Codex 实例。使用 /new 选择文件夹并创建。");
      return;
    }

    await ctx.reply("选择要打开的 Codex 实例：", {
      reply_markup: {
        inline_keyboard: instances.map((instance) => ([{
          text: `${displayInstanceId(instance)}  ${instance.running ? "running" : "idle"}  ${shortPath(instance.workingDirectory)}`,
          callback_data: `attach:${instance.instanceId}`
        }]))
      }
    });
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

bot.command("new", async (ctx) => {
  const requestedPath = ctx.message.text.replace(/^\/new(@\w+)?\s*/, "").trim();
  try {
    if (requestedPath) {
      const instance = await createInstance(requestedPath);
      await attachInstance(ctx.chat.id, instance.instanceId);
      lastFolderPaths.set(ctx.chat.id, instance.workingDirectory);
      await ctx.reply(`已创建并打开 Codex 实例：${shortId(instance.instanceId)}\n文件夹：${instance.workingDirectory}`);
      return;
    }

    const listing = await loadDirectory(lastFolderPaths.get(ctx.chat.id));
    lastFolderPaths.set(ctx.chat.id, listing.path);
    folderPickers.set(ctx.chat.id, listing);
    await ctx.reply(newPickerText(listing), newPickerMarkup(listing));
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

bot.command("status", async (ctx) => {
  try {
    const state = chatStates.get(ctx.chat.id);
    const current = state?.instanceId ? await getInstance(state.instanceId).catch(() => null) : null;
    const usage = await getCodexUsage(current?.threadId).catch(() => null);
    const instances = await listInstances();
    await ctx.reply([
      `当前 instance：${current ? displayInstanceId(current) : "(none)"}`,
      current ? `文件夹：${current.workingDirectory}` : null,
      current?.threadId ? `thread：${shortId(current.threadId)}` : null,
      `usage：${formatCodexUsage(usage)}`,
      "",
      instances.length
        ? instances.map((instance) => `${displayInstanceId(instance)} ${instance.running ? "running" : "idle"} ${instance.attachCount} attached`).join("\n")
        : "当前没有 Codex 实例。"
    ].filter(Boolean).join("\n"));
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

const handleStopCommand = async (ctx: any) => {
  try {
    const state = chatStates.get(ctx.chat.id);
    const current = state?.instanceId ? await getInstance(state.instanceId).catch(() => null) : null;
    if (!current) {
      await ctx.reply("当前没有打开的 Codex 实例。");
      return;
    }
    if (!current.running) {
      await ctx.reply("No running turn.");
      return;
    }

    const result = await stopInstance(current.instanceId);
    await ctx.reply(result.stopped ? "Stopped current turn." : "No running turn.");
  } catch (error) {
    await ctx.reply(errorText(error));
  }
};

bot.command("stop", handleStopCommand);
bot.hears(/^\/stop(?:@\w+)?(?:\s|$)/i, handleStopCommand);

bot.action(/^new:child:(\d+)$/, async (ctx) => {
  try {
    const index = Number(ctx.match[1]);
    const current = folderPickers.get(ctx.chat!.id);
    const selected = current?.children[index];
    if (!selected) throw new Error("Folder selection expired. Run /new again.");
    const listing = await loadDirectory(selected.path);
    folderPickers.set(ctx.chat!.id, listing);
    lastFolderPaths.set(ctx.chat!.id, listing.path);
    await ctx.answerCbQuery("Opened");
    await ctx.editMessageText(newPickerText(listing), newPickerMarkup(listing));
  } catch (error) {
    await ctx.answerCbQuery("Failed");
    await ctx.reply(errorText(error));
  }
});

bot.action("new:parent", async (ctx) => {
  try {
    const current = folderPickers.get(ctx.chat!.id);
    if (!current?.parent) throw new Error("No parent folder.");
    const listing = await loadDirectory(current.parent);
    folderPickers.set(ctx.chat!.id, listing);
    lastFolderPaths.set(ctx.chat!.id, listing.path);
    await ctx.answerCbQuery("Opened");
    await ctx.editMessageText(newPickerText(listing), newPickerMarkup(listing));
  } catch (error) {
    await ctx.answerCbQuery("Failed");
    await ctx.reply(errorText(error));
  }
});

bot.action("new:create", async (ctx) => {
  try {
    const listing = folderPickers.get(ctx.chat!.id);
    if (!listing) throw new Error("Folder selection expired. Run /new again.");
    const instance = await createInstance(listing.path);
    await attachInstance(ctx.chat!.id, instance.instanceId);
    folderPickers.delete(ctx.chat!.id);
    lastFolderPaths.set(ctx.chat!.id, instance.workingDirectory);
    await ctx.answerCbQuery("Created");
    await ctx.editMessageText(`已创建并打开 Codex 实例：${displayInstanceId(instance)}\n文件夹：${instance.workingDirectory}`);
  } catch (error) {
    await ctx.answerCbQuery("Failed");
    await ctx.reply(errorText(error));
  }
});

bot.action("new:cancel", async (ctx) => {
  folderPickers.delete(ctx.chat!.id);
  await ctx.answerCbQuery("Canceled");
  await ctx.editMessageText("已取消创建实例。");
});

bot.action(/^attach:(.+)$/, async (ctx) => {
  try {
    const instanceId = ctx.match[1];
    const instance = await attachInstance(ctx.chat!.id, instanceId);
    await ctx.answerCbQuery("Attached");
    await ctx.editMessageText([
      `已打开：${displayInstanceId(instance)} ${instance.running ? "running" : "idle"}`,
      instance.workingDirectory
    ].join("\n"));
  } catch (error) {
    await ctx.answerCbQuery("Failed");
    await ctx.reply(errorText(error));
  }
});

bot.on("text", async (ctx) => {
  const prompt = ctx.message.text.trim();
  if (!prompt || prompt.startsWith("/")) return;
  await runPrompt(ctx, prompt, []);
});

bot.on("photo", async (ctx) => {
  const prompt = ctx.message.caption?.trim() || "请分析这张图片。";
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;
  await runPrompt(ctx, prompt, [{ fileId: photo.file_id, filename: `${photo.file_id}.jpg` }]);
});

bot.on("document", async (ctx) => {
  const document = ctx.message.document;
  if (!document.mime_type?.startsWith("image/")) return;
  const prompt = ctx.message.caption?.trim() || "请分析这张图片。";
  await runPrompt(ctx, prompt, [{ fileId: document.file_id, filename: document.file_name ?? `${document.file_id}.png` }]);
});

const runPrompt = async (
  ctx: any,
  prompt: string,
  images: Array<{ fileId: string; filename: string }>
) => {
  const state = chatStates.get(ctx.chat.id);
  const existingInstance = state?.instanceId ? await getInstance(state.instanceId).catch(() => null) : null;
  if (!existingInstance) {
    await ctx.reply("当前没有打开的 Codex 实例。使用 /new 选择文件夹并创建，或用 /instances 打开已有实例。");
    return;
  }
  const instance = existingInstance;
  const statusMessage = await ctx.reply([
    "Codex running...",
    `folder: ${instance.workingDirectory}`,
    `instance: ${displayInstanceId(instance)}`,
    images.length ? `images: ${images.length}` : null
  ].filter(Boolean).join("\n"));
  const knownRecordIds = new Set(instance.records.map((record) => record.id));
  let sentItemCount = 0;
  let stopped = false;
  const compactState = createCompactRecordViewState();
  const sentMessages = new Map<string, { messageId: number; status: string }>();
  const forwardRecord = async (record: CodexRecord) => {
    const view = recordToView(record);
    if (!view) return;
    const change = compactRecordView(compactState, view);
    if (!shouldForwardView(change.view, sentMessages)) return;

    const text = clampTelegram(formatBlock(change.view.label ?? change.view.role, change.view.text, change.view.status));
    const existing = sentMessages.get(change.previousId ?? change.view.id);
    if (!change.appended && existing) {
      await ctx.telegram.editMessageText(ctx.chat.id, existing.messageId, undefined, text);
      sentMessages.delete(change.previousId ?? change.view.id);
      sentMessages.set(change.view.id, { messageId: existing.messageId, status: change.view.status ?? "final" });
      return;
    }

    const message = await ctx.reply(text);
    sentItemCount += 1;
    sentMessages.set(change.view.id, { messageId: message.message_id, status: change.view.status ?? "final" });
  };

  try {
    let input: TurnInput = prompt;
    if (images.length) {
      const uploadedImages = await Promise.all(images.map((image) => uploadTelegramImage(instance.workingDirectory, image.fileId, image.filename)));
      input = [
        ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
        ...uploadedImages.map((image) => ({ type: "local_image" as const, path: image.path }))
      ];
    }
    const stream = streamInstanceEvents(instance.instanceId, instance.lastSeq);
    await postTurn(instance.instanceId, input);

    for await (const event of stream) {
      if (event.kind === "record" && event.record) {
        await forwardRecord(event.record);
      }
      if (event.kind === "done") break;
    }

    const latest = await getInstance(instance.instanceId).catch(() => null);
    for (const record of latest?.records ?? []) {
      if (!knownRecordIds.has(record.id)) await forwardRecord(record);
    }
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      [
        stopped ? "Codex stopped." : "Codex completed.",
        `instance: ${latest ? displayInstanceId(latest) : shortId(instance.instanceId)}`,
        `messages: ${sentItemCount}`
      ].join("\n")
    );
  } catch (error) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, clampTelegram(errorText(error)));
  }
};

const attachInstance = async (chatId: number, instanceId: string) => {
  const current = chatStates.get(chatId);
  if (current?.instanceId && current.instanceId !== instanceId) {
    await detachCurrent(chatId);
  }
  const instance = await apiJson<InstanceDetail>(`/api/instances/${encodeURIComponent(instanceId)}/attach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: tgClientId(chatId) })
  });
  chatStates.set(chatId, { instanceId: instance.instanceId });
  return instance;
};

const detachCurrent = async (chatId: number) => {
  const current = chatStates.get(chatId);
  if (!current?.instanceId) return;
  await fetch(apiUrl(`/api/instances/${encodeURIComponent(current.instanceId)}?clientId=${encodeURIComponent(tgClientId(chatId))}`), {
    method: "DELETE"
  }).catch(() => undefined);
  chatStates.delete(chatId);
};

const listInstances = async (): Promise<InstanceSummary[]> => {
  const data = await apiJson<{ instances?: InstanceSummary[] }>("/api/instances");
  return Array.isArray(data.instances) ? data.instances : [];
};

const loadDirectory = async (directoryPath?: string) => {
  const query = directoryPath ? `?${new URLSearchParams({ path: directoryPath }).toString()}` : "";
  return apiJson<DirectoryListing>(`/api/fs/children${query}`);
};

const getInstance = (instanceId: string) => apiJson<InstanceDetail>(`/api/instances/${encodeURIComponent(instanceId)}`);

const getCodexUsage = (threadId?: string) => {
  const query = threadId ? `?${new URLSearchParams({ threadId }).toString()}` : "";
  return apiJson<CodexUsageSnapshot>(`/api/codex-usage${query}`);
};

const createInstance = (workingDirectory: string) => apiJson<InstanceDetail>("/api/instances", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workingDirectory })
});

const postTurn = async (instanceId: string, input: TurnInput) => {
  const response = await fetch(apiUrl(`/api/instances/${encodeURIComponent(instanceId)}/turn`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, source: "telegram" })
  });
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
};

const stopInstance = async (instanceId: string) => apiJson<{ stopped: boolean }>(`/api/instances/${encodeURIComponent(instanceId)}/stop`, {
  method: "POST"
});

const uploadTelegramImage = async (workingDirectory: string, fileId: string, filename: string) => {
  const link = await bot.telegram.getFileLink(fileId);
  const response = await fetch(link);
  if (!response.ok) throw new Error(`Telegram file HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return apiJson<{ path: string }>("/api/uploads/images", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workingDirectory,
      filename,
      contentBase64: buffer.toString("base64")
    })
  });
};

const streamInstanceEvents = async function* (instanceId: string, after: number): AsyncGenerator<any> {
  const response = await fetch(apiUrl(`/api/instances/${encodeURIComponent(instanceId)}/events?after=${after}`));
  if (!response.ok || !response.body) throw new Error(`API HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      yield JSON.parse(dataLine.slice(6));
    }
  }
};

const apiJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), init);
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};

const apiUrl = (path: string) => new URL(path, apiBaseUrl).toString();
const shortId = (id: string) => id.slice(0, 8);
const displayInstanceId = (instance: Pick<InstanceSummary, "instanceId" | "threadId">) => shortId(instance.threadId ?? instance.instanceId);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const newPickerText = (listing: DirectoryListing) => [
  "选择文件夹创建 Codex 实例：",
  listing.path,
  "",
  "可以进入子目录，也可以直接在当前目录创建。"
].join("\n");
const newPickerMarkup = (listing: DirectoryListing) => {
  const childRows = listing.children.slice(0, 20).map((child, index) => ([{
    text: child.hasChildren ? `${child.name}/` : child.name,
    callback_data: `new:child:${index}`
  }]));
  const parentRow = listing.parent ? [[{ text: "..", callback_data: "new:parent" }]] : [];

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Create Instance Here", callback_data: "new:create" }],
        ...parentRow,
        ...childRows,
        [{ text: "Cancel", callback_data: "new:cancel" }]
      ]
    }
  };
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

await bot.telegram.setMyCommands(botCommands);
await bot.launch();
console.log(`codex-proxy telegram bot started, api=${apiBaseUrl}`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
