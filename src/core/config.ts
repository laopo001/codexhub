import { authorityServiceHost, authorityServicePort } from "../shared/surfaceTypes.js";
import type { ThreadOptions } from "../shared/usageTypes.js";

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
    host: authorityServiceHost(process.env, overrides.host),
    port: authorityServicePort(process.env, process.platform, overrides.port),
    defaultThreadOptions: {}
  };
};
