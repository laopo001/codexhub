import { createHash } from "node:crypto";
import net from "node:net";
import { loadDotEnv } from "../core/dotenv.js";
import type { CodexHubSurface } from "../shared/surfaceTypes.js";
import {
  startServer,
  type ParentRegistrationIdentity,
  type ServerFeatureOptions,
  type ServerHandle
} from "./index.js";

export type EmbeddedServerOptions = {
  host?: string;
  portMode: "preferred" | "random" | "increment";
  preferredPort?: number;
  dataDir?: string;
  staticDirectory?: string;
  surface?: CodexHubSurface;
  buildId?: string | null;
  parentRegistrationIdentity?: ParentRegistrationIdentity;
  features?: Partial<ServerFeatureOptions>;
  logPrefix?: string;
};

export const startEmbeddedServer = async (options: EmbeddedServerOptions) => {
  await loadDotEnv();
  const host = options.host ?? "0.0.0.0";
  const preferredPort = options.portMode === "random"
    ? await findFreePort(host)
    : options.preferredPort;
  if (preferredPort === undefined) {
    throw new Error(`${options.portMode} embedded server mode requires preferredPort`);
  }
  const startAtPort = async (port: number) =>
    await startServer({
      host,
      port,
      dataDir: options.dataDir,
      staticDirectory: options.staticDirectory,
      surface: options.surface,
      buildId: options.buildId,
      parentRegistrationIdentity: options.parentRegistrationIdentity,
      features: options.features
    });

  let port = preferredPort;
  for (;;) {
    try {
      return await startAtPort(port);
    } catch (error) {
      if (!isAddressInUse(error) || options.portMode === "preferred") throw error;
      const fallbackPort = options.portMode === "random"
        ? await findFreePort(host)
        : nextEmbeddedPort(port);
      const prefix = options.logPrefix ?? "codexhub embedded";
      console.error(`${prefix} port ${port} is busy; trying ${fallbackPort}`);
      port = fallbackPort;
    }
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

export const stableEmbeddedPortForName = (
  name: string,
  rangeStart = 20_000,
  rangeSize = 10_000
) => {
  if (
    !Number.isInteger(rangeStart)
    || !Number.isInteger(rangeSize)
    || rangeStart <= 0
    || rangeSize <= 0
    || rangeStart + rangeSize - 1 > 65_535
  ) {
    throw new Error(`Invalid embedded server port range: ${rangeStart}..${rangeStart + rangeSize - 1}`);
  }
  const normalizedName = name.normalize("NFKC").trim() || "codexhub";
  const hash = createHash("sha256").update(normalizedName).digest().readUInt32BE(0);
  return rangeStart + (hash % rangeSize);
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

const nextEmbeddedPort = (port: number) => {
  if (port >= 65_535) {
    throw new Error("Could not allocate embedded server port after reaching 65535.");
  }
  return port + 1;
};
