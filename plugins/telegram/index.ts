import type { BuiltinPluginDefinition, PluginIntegrationState } from "../../src/core/pluginHub.js";
import { startTelegramBotFromEnv, type TelegramBotHandle } from "./bot.js";

export type { TelegramBotHandle };

export const telegramPluginId = "codexhub.telegram";
export const telegramIntegrationType = "telegram";

export const telegramBuiltinPlugin = (): BuiltinPluginDefinition => ({
  root: "builtin:telegram",
  manifest: {
    version: 1,
    id: telegramPluginId,
    name: "Telegram",
    enabled: envFlag("CODEX_HUB_PLUGIN_TELEGRAM", true),
    contributes: {
      integrations: [
        {
          type: telegramIntegrationType,
          runner: "builtin",
          label: "Telegram bot",
          requiredEnv: ["TELEGRAM_BOT_TOKEN"]
        }
      ]
    }
  }
});

export const telegramPluginState = (started: boolean): PluginIntegrationState => ({
  configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  started
});

export const startTelegramPlugin = async (options: {
  apiBaseUrl?: string;
  requireToken?: boolean;
  logger?: Pick<Console, "error" | "log">;
} = {}): Promise<TelegramBotHandle | null> => {
  return startTelegramBotFromEnv(options);
};

const envFlag = (name: string, fallback: boolean) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return fallback;
};
