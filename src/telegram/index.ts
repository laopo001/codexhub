import { Telegraf } from "telegraf";

type WorkspaceEntry = {
  path: string;
  name: string;
  lastOpenedAt: string;
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
  messages: Array<{ id: string; role: string; label?: string; text: string; source?: string }>;
  lastSeq: number;
};

type ChatState = {
  workingDirectory?: string;
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

const botCommands = [
  { command: "start", description: "show help" },
  { command: "status", description: "show current folder and instance" },
  { command: "folders", description: "choose workspace folder" },
  { command: "addfolder", description: "add and choose a folder" },
  { command: "instances", description: "attach a Codex instance" },
  { command: "new", description: "create a new Codex instance" }
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
  await ensureChatState(ctx.chat.id);
  return ctx.reply([
    "codex-proxy ready.",
    "",
    "/folders 选择文件夹",
    "/instances attach 当前文件夹的 Codex 实例",
    "/new 创建并 attach 新 Codex 实例",
    "/status 查看当前状态",
    "",
    "直接发消息会发送给当前 Codex 实例。"
  ].join("\n"));
});

bot.command("folders", async (ctx) => {
  try {
    const workspaces = await listWorkspaces();
    if (!workspaces.length) {
      await ctx.reply("没有可选文件夹。请先启动 API server，或使用 /addfolder <path> 添加。");
      return;
    }
    await ctx.reply("选择当前文件夹：", {
      reply_markup: {
        inline_keyboard: workspaces.map((workspace, index) => ([{
          text: `${workspace.name}  ${workspace.path}`,
          callback_data: `folder:${index}`
        }]))
      }
    });
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

bot.command("addfolder", async (ctx) => {
  const workspacePath = ctx.message.text.replace(/^\/addfolder(@\w+)?\s*/, "").trim();
  if (!workspacePath) {
    await ctx.reply("用法：/addfolder /home/laop/projects/codex-proxy");
    return;
  }

  try {
    const workspaces = await addWorkspace(workspacePath);
    const selected = workspaces[0];
    if (!selected) throw new Error("Folder was added but API returned no workspace.");
    await detachCurrent(ctx.chat.id);
    chatStates.set(ctx.chat.id, { workingDirectory: selected.path });
    await ctx.reply(`已选择文件夹：\n${selected.path}`);
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

bot.command("instances", async (ctx) => {
  try {
    const state = await ensureChatState(ctx.chat.id);
    const instances = (await listInstances()).filter((instance) => instance.workingDirectory === state.workingDirectory);

    if (!instances.length) {
      await ctx.reply(`当前文件夹没有可 attach 的 Codex 实例。\n${state.workingDirectory}`);
      return;
    }

    await ctx.reply("选择要 attach 的 Codex 实例：", {
      reply_markup: {
        inline_keyboard: instances.map((instance) => ([{
          text: `${displayInstanceId(instance)}  ${instance.running ? "running" : "idle"}  ${instance.attachCount} attached`,
          callback_data: `attach:${instance.instanceId}`
        }]))
      }
    });
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

bot.command("new", async (ctx) => {
  try {
    const state = await ensureChatState(ctx.chat.id);
    const instance = await createInstance(state.workingDirectory!);
    await attachInstance(ctx.chat.id, instance.instanceId);
    await ctx.reply(`已创建并 attach 新 Codex 实例：${shortId(instance.instanceId)}\n文件夹：${instance.workingDirectory}`);
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

bot.command("status", async (ctx) => {
  try {
    const state = await ensureChatState(ctx.chat.id);
    const current = state.instanceId ? await getInstance(state.instanceId).catch(() => null) : null;
    const instances = (await listInstances()).filter((instance) => instance.workingDirectory === state.workingDirectory);
    await ctx.reply([
      `文件夹：${state.workingDirectory}`,
      `当前 instance：${current ? displayInstanceId(current) : "(none)"}`,
      current?.threadId ? `thread：${shortId(current.threadId)}` : null,
      "",
      instances.length
        ? instances.map((instance) => `${displayInstanceId(instance)} ${instance.running ? "running" : "idle"} ${instance.attachCount} attached`).join("\n")
        : "当前文件夹没有 Codex 实例。"
    ].filter(Boolean).join("\n"));
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

bot.action(/^folder:(\d+)$/, async (ctx) => {
  try {
    const index = Number(ctx.match[1]);
    const workspaces = await listWorkspaces();
    const selected = workspaces[index];
    if (!selected) throw new Error("Folder selection expired. Run /folders again.");
    await detachCurrent(ctx.chat!.id);
    chatStates.set(ctx.chat!.id, { workingDirectory: selected.path });
    await ctx.answerCbQuery("Folder selected");
    await ctx.editMessageText(`已选择文件夹：\n${selected.path}`);
  } catch (error) {
    await ctx.answerCbQuery("Failed");
    await ctx.reply(errorText(error));
  }
});

bot.action(/^attach:(.+)$/, async (ctx) => {
  try {
    const instanceId = ctx.match[1];
    const instance = await attachInstance(ctx.chat!.id, instanceId);
    await ctx.answerCbQuery("Attached");
    await ctx.editMessageText([
      `已 attach：${displayInstanceId(instance)} ${instance.running ? "running" : "idle"}`,
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

  const state = await ensureChatState(ctx.chat.id);
  const existingInstance = state.instanceId ? await getInstance(state.instanceId).catch(() => null) : null;
  const instance = existingInstance ?? await createAndAttach(ctx.chat.id, state.workingDirectory!);
  const statusMessage = await ctx.reply([
    "Codex running...",
    `folder: ${instance.workingDirectory}`,
    `instance: ${displayInstanceId(instance)}`
  ].join("\n"));
  let sentItemCount = 0;

  try {
    const stream = streamInstanceEvents(instance.instanceId, instance.lastSeq);
    await postTurn(instance.instanceId, prompt);

    for await (const event of stream) {
      if (event.kind === "message" && event.message?.source === "codex") {
        sentItemCount += 1;
        await ctx.reply(clampTelegram(formatBlock(event.message.label ?? event.message.role, event.message.text)));
      }
      if (event.kind === "done") break;
    }

    const latest = await getInstance(instance.instanceId).catch(() => null);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      [
        "Codex completed.",
        `instance: ${latest ? displayInstanceId(latest) : shortId(instance.instanceId)}`,
        `messages: ${sentItemCount}`
      ].join("\n")
    );
  } catch (error) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, clampTelegram(errorText(error)));
  }
});

const ensureChatState = async (chatId: number): Promise<ChatState> => {
  const existing = chatStates.get(chatId);
  if (existing?.workingDirectory) return existing;

  const workspaces = await listWorkspaces();
  const first = workspaces[0];
  if (!first) throw new Error("No workspace available. Start the API server first.");

  const state: ChatState = { workingDirectory: first.path };
  chatStates.set(chatId, state);
  return state;
};

const createAndAttach = async (chatId: number, workingDirectory: string) => {
  const instance = await createInstance(workingDirectory);
  return attachInstance(chatId, instance.instanceId);
};

const attachInstance = async (chatId: number, instanceId: string) => {
  await detachCurrent(chatId);
  const instance = await apiJson<InstanceDetail>(`/api/instances/${encodeURIComponent(instanceId)}/attach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: tgClientId(chatId) })
  });
  chatStates.set(chatId, { workingDirectory: instance.workingDirectory, instanceId: instance.instanceId });
  return instance;
};

const detachCurrent = async (chatId: number) => {
  const current = chatStates.get(chatId);
  if (!current?.instanceId) return;
  await fetch(apiUrl(`/api/instances/${encodeURIComponent(current.instanceId)}?clientId=${encodeURIComponent(tgClientId(chatId))}`), {
    method: "DELETE"
  }).catch(() => undefined);
};

const listWorkspaces = async (): Promise<WorkspaceEntry[]> => {
  const data = await apiJson<{ workspaces?: WorkspaceEntry[] }>("/api/workspaces");
  return Array.isArray(data.workspaces) ? data.workspaces : [];
};

const addWorkspace = async (workspacePath: string): Promise<WorkspaceEntry[]> => {
  const data = await apiJson<{ workspaces?: WorkspaceEntry[] }>("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: workspacePath })
  });
  return Array.isArray(data.workspaces) ? data.workspaces : [];
};

const listInstances = async (): Promise<InstanceSummary[]> => {
  const data = await apiJson<{ instances?: InstanceSummary[] }>("/api/instances");
  return Array.isArray(data.instances) ? data.instances : [];
};

const getInstance = (instanceId: string) => apiJson<InstanceDetail>(`/api/instances/${encodeURIComponent(instanceId)}`);

const createInstance = (workingDirectory: string) => apiJson<InstanceDetail>("/api/instances", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workingDirectory })
});

const postTurn = async (instanceId: string, input: string) => {
  const response = await fetch(apiUrl(`/api/instances/${encodeURIComponent(instanceId)}/turn`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, source: "telegram" })
  });
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
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
const formatBlock = (label: string, text: string) => `[${label}]\n${text}`;

const clampTelegram = (text: string) => {
  if (text.length <= 3900) return text;
  return `${text.slice(0, 3900)}\n\n[truncated]`;
};

await bot.telegram.setMyCommands(botCommands);
await bot.launch();
console.log(`codex-proxy telegram bot started, api=${apiBaseUrl}`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
