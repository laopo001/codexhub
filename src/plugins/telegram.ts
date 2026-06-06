import type { BuiltinPluginDefinition, PluginIntegrationRuntimeState } from "../core/pluginHub.js";
import { startTelegramBotFromEnv, type TelegramBotHandle } from "../telegram/index.js";

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
          runtime: "builtin",
          label: "Telegram bot",
          requiredEnv: ["TELEGRAM_BOT_TOKEN"]
        }
      ]
    }
  }
});

export const telegramPluginRuntimeState = (started: boolean): PluginIntegrationRuntimeState => ({
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
