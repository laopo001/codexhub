import { Telegraf } from "telegraf";
import { itemText } from "../core/events.js";

type WorkspaceEntry = {
  path: string;
  name: string;
  lastOpenedAt: string;
};

type ProxyThreadInstance = {
  threadId: string;
  workingDirectory: string;
  running: boolean;
};

type ChatState = {
  workingDirectory?: string;
  threadId?: string;
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
  { command: "status", description: "show current folder and thread" },
  { command: "folders", description: "choose workspace folder" },
  { command: "addfolder", description: "add and choose a folder" },
  { command: "instances", description: "attach a Codex instance" },
  { command: "new", description: "create a new instance draft" },
  { command: "thread", description: "show current thread id" }
];

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
    "/new 在当前文件夹创建新实例草稿",
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
    chatStates.set(ctx.chat.id, { workingDirectory: selected.path });
    await ctx.reply(`已选择文件夹：\n${selected.path}`);
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

bot.command("instances", async (ctx) => {
  try {
    const state = await ensureChatState(ctx.chat.id);
    const instances = (await listProxyInstances())
      .filter((instance) => instance.workingDirectory === state.workingDirectory);

    if (!instances.length) {
      await ctx.reply(`当前文件夹没有可 attach 的 Codex 实例。\n${state.workingDirectory}`);
      return;
    }

    await ctx.reply("选择要 attach 的 Codex 实例：", {
      reply_markup: {
        inline_keyboard: instances.map((instance) => ([{
          text: `${shortThreadId(instance.threadId)}  ${instance.running ? "running" : "idle"}`,
          callback_data: `attach:${instance.threadId}`
        }]))
      }
    });
  } catch (error) {
    await ctx.reply(errorText(error));
  }
});

bot.command("new", async (ctx) => {
  const state = await ensureChatState(ctx.chat.id);
  chatStates.set(ctx.chat.id, { workingDirectory: state.workingDirectory });
  await ctx.reply(`已切换到新实例草稿。\n文件夹：${state.workingDirectory}\n下一条消息会创建 Codex 实例。`);
});

bot.command("thread", async (ctx) => {
  const state = await ensureChatState(ctx.chat.id);
  await ctx.reply(state.threadId ?? "(new)");
});

bot.command("status", async (ctx) => {
  try {
    const state = await ensureChatState(ctx.chat.id);
    const instances = (await listProxyInstances())
      .filter((instance) => instance.workingDirectory === state.workingDirectory);
    await ctx.reply([
      `文件夹：${state.workingDirectory}`,
      `当前 thread：${state.threadId ?? "(new)"}`,
      "",
      instances.length
        ? instances.map((instance) => `${shortThreadId(instance.threadId)} ${instance.running ? "running" : "idle"}`).join("\n")
        : "当前文件夹没有 Codex 实例。"
    ].join("\n"));
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
    const threadId = ctx.match[1];
    const state = await ensureChatState(ctx.chat!.id);
    const instance = (await listProxyInstances()).find((item) =>
      item.threadId === threadId && item.workingDirectory === state.workingDirectory
    );
    if (!instance) throw new Error("Instance no longer exists for current folder. Run /instances again.");
    chatStates.set(ctx.chat!.id, {
      workingDirectory: instance.workingDirectory,
      threadId: instance.threadId
    });
    await ctx.answerCbQuery("Attached");
    await ctx.editMessageText([
      `已 attach：${shortThreadId(instance.threadId)} ${instance.running ? "running" : "idle"}`,
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
  const statusMessage = await ctx.reply([
    "Codex running...",
    `folder: ${state.workingDirectory}`,
    `thread: ${state.threadId ? shortThreadId(state.threadId) : "(new)"}`
  ].join("\n"));
  let finalResponse = "";
  const progress: string[] = [];

  try {
    for await (const event of streamTurn({
      input: prompt,
      threadId: state.threadId,
      workingDirectory: state.workingDirectory,
      skipGitRepoCheck: true
    })) {
      if (event.type === "thread" && typeof event.threadId === "string") {
        state.threadId = event.threadId;
        chatStates.set(ctx.chat.id, state);
      } else if (event.type === "item") {
        const text = itemText(event.item);
        if (text && event.item.type !== "agent_message") progress.push(text);
      } else if (event.type === "final") {
        finalResponse = event.text;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    const text = finalResponse || progress.slice(-3).join("\n\n") || "Codex completed without text output.";
    await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, clampTelegram(text));
  } catch (error) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      clampTelegram(errorText(error))
    );
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

const listProxyInstances = async (): Promise<ProxyThreadInstance[]> => {
  const data = await apiJson<{ instances?: ProxyThreadInstance[] }>("/api/proxy/instances");
  return Array.isArray(data.instances) ? data.instances : [];
};

const streamTurn = async function* (payload: Record<string, unknown>): AsyncGenerator<any> {
  const response = await fetch(apiUrl("/api/turn/stream"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

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

const shortThreadId = (threadId: string) => threadId.slice(0, 8);

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const clampTelegram = (text: string) => {
  if (text.length <= 3900) return text;
  return `${text.slice(0, 3900)}\n\n[truncated]`;
};

await bot.telegram.setMyCommands(botCommands);
await bot.launch();
console.log(`codex-proxy telegram bot started, api=${apiBaseUrl}`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
