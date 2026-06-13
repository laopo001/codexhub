import type { ThreadOptions } from "./threadOptions.js";

export type ProxyConfig = {
  host: string;
  port: number;
  defaultThreadOptions: ThreadOptions;
};

export type ProxyConfigOverrides = {
  host?: string;
  port?: number;
};

export const loadConfig = (overrides: ProxyConfigOverrides = {}): ProxyConfig => {
  return {
    host: overrides.host ?? process.env.CODEX_HUB_HOST ?? "0.0.0.0",
    port: overrides.port ?? parsePort(process.env.CODEX_HUB_PORT ?? "8788"),
    defaultThreadOptions: {}
  };
};

const parsePort = (value: string) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid CODEX_HUB_PORT: ${value}`);
  }
  return port;
};
