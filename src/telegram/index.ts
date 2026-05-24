import { Telegraf } from "telegraf";
import { CodexProxy } from "../core/codexProxy.js";
import { itemText } from "../core/events.js";
import { loadConfig } from "../core/config.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const config = loadConfig();
const proxy = new CodexProxy(config.codexOptions, config.defaultThreadOptions);
const bot = new Telegraf(token);
const threads = new Map<number, string>();

bot.start((ctx) => ctx.reply("codex-proxy ready. 直接发消息给 Codex，/new 开新会话，/thread 查看当前 thread。"));

bot.command("new", (ctx) => {
  threads.delete(ctx.chat.id);
  return ctx.reply("已切换到新会话。");
});

bot.command("thread", (ctx) => {
  return ctx.reply(threads.get(ctx.chat.id) ?? "(new)");
});

bot.on("text", async (ctx) => {
  const prompt = ctx.message.text.trim();
  if (!prompt || prompt.startsWith("/")) return;

  let statusMessage = await ctx.reply("Codex running...");
  let finalResponse = "";
  const progress: string[] = [];

  try {
    for await (const event of proxy.runStream({
      input: prompt,
      threadId: threads.get(ctx.chat.id),
      skipGitRepoCheck: true
    })) {
      if (event.type === "thread") {
        threads.set(ctx.chat.id, event.threadId);
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
      clampTelegram(error instanceof Error ? error.message : String(error))
    );
  }
});

const clampTelegram = (text: string) => {
  if (text.length <= 3900) return text;
  return `${text.slice(0, 3900)}\n\n[truncated]`;
};

await bot.launch();
console.log("codex-proxy telegram bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
