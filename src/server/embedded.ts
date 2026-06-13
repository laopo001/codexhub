import net from "node:net";
import { loadDotEnv } from "../core/dotenv.js";
import { startServer, type ServerFeatureOptions, type ServerHandle } from "./index.js";

export type EmbeddedServerOptions = {
  host?: string;
  portMode?: "preferred" | "random";
  preferredPort?: number;
  explicitPort?: boolean;
  staticDirectory?: string;
  surface?: "default" | "vscode";
  buildId?: string | null;
  features?: Partial<ServerFeatureOptions>;
  logPrefix?: string;
};

export const startEmbeddedServer = async (options: EmbeddedServerOptions = {}) => {
  await loadDotEnv();
  const host = options.host ?? "0.0.0.0";
  const preferredPort = options.portMode === "random"
    ? await findFreePort(host)
    : options.preferredPort ?? 18788;
  try {
    return await startServer({
      host,
      port: preferredPort,
      staticDirectory: options.staticDirectory,
      surface: options.surface,
      buildId: options.buildId,
      features: options.features
    });
  } catch (error) {
    if (options.explicitPort || !isAddressInUse(error)) throw error;
    const fallbackPort = await findFreePort(host);
    const prefix = options.logPrefix ?? "codexhub embedded";
    console.error(`${prefix} port ${preferredPort} is busy; using ${fallbackPort}`);
    return await startServer({
      host,
      port: fallbackPort,
      staticDirectory: options.staticDirectory,
      surface: options.surface,
      buildId: options.buildId,
      features: options.features
    });
  }
};

export const localServerUrl = (handle: ServerHandle) => {
  const host = handle.host === "0.0.0.0" || handle.host === "::" ? "127.0.0.1" : handle.host;
  return `http://${host}:${handle.port}`;
};

export const parseEmbeddedPort = (value: string, label = "embedded server port") => {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return port;
};

export const findFreePort = async (host: string) => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, host, () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("Could not allocate embedded server port.")));
      return;
    }
    const port = address.port;
    server.close(() => resolve(port));
  });
});

const isAddressInUse = (error: unknown) =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
