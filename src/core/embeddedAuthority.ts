import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { readServerConfigEnv } from "./serverConfigEnv.js";
import type { HealthPayload } from "../shared/apiContract.js";
import { authorityKind, authorityServicePort, embeddedSurfaceProtocolVersion } from "../shared/surfaceTypes.js";

export type EmbeddedAuthorityHandle = {
  url: string;
  authorityId: string;
  buildId: string;
  authToken: string;
  replacementExpected?: boolean;
  startedByCaller: boolean;
  pid?: number;
};

export type EnsureEmbeddedAuthorityInput = {
  dataDir: string;
  authorityServicePath: string;
  staticDirectory: string;
  remoteClientPath?: string;
  buildId: string;
  authToken: string;
  projectCatalog?: "editable" | "fixed";
  port?: number;
  runAsElectronNode?: boolean;
  logFileName?: string;
};

const authorityIdFileName = "authority-id";
const legacyAuthorityIdFileNames = ["vscode-authority-id"];

export const resolveAuthorityId = async (dataDir: string) => {
  await mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, authorityIdFileName);
  const read = async (candidate: string) => {
    const value = (await readFile(candidate, "utf8")).trim();
    if (!/^authority-[a-z0-9-]{8,}$/i.test(value)) {
      throw new Error(`Invalid CodexHub authority id: ${candidate}`);
    }
    return value;
  };
  try {
    return await read(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const legacyName of legacyAuthorityIdFileNames) {
    const legacyPath = path.join(dataDir, legacyName);
    try {
      const value = await read(legacyPath);
      await writeFile(filePath, `${value}\n`, { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const candidate = `authority-${randomUUID()}`;
  try {
    await writeFile(filePath, `${candidate}\n`, { flag: "wx", mode: 0o600 });
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await read(filePath);
  }
};

export const authorityBuildId = async (files: string[], prefix = "authority") => {
  const hash = createHash("sha256");
  let size = 0;
  for (const filePath of files) {
    try {
      const contents = await readFile(filePath);
      hash.update(contents);
      size += contents.byteLength;
    } catch {
      hash.update(`${filePath}:missing`);
    }
  }
  return `${prefix}:${size}:${hash.digest("hex").slice(0, 20)}`;
};

/**
 * Resolve the shared authority port. Explicit process/CLI environment values
 * win, while config.yaml supplies the default for VS Code and Electron when
 * they are the first client to start the detached authority.
 */
export const resolveEmbeddedAuthorityPort = async (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
) => {
  const configEnv = await readServerConfigEnv(path.join(dataDir, "config.yaml"));
  return authorityServicePort({
    ...(configEnv ?? {}),
    ...env
  });
};

export const ensureEmbeddedAuthority = async (
  input: EnsureEmbeddedAuthorityInput
): Promise<EmbeddedAuthorityHandle> => {
  const authorityId = await resolveAuthorityId(input.dataDir);
  const port = input.port ?? await resolveEmbeddedAuthorityPort(input.dataDir);
  const url = `http://127.0.0.1:${port}`;
  const existing = await probeEmbeddedAuthority(url, authorityId, Boolean(input.authToken));
  if (existing) {
    return {
      url,
      authorityId,
      buildId: input.buildId,
      authToken: input.authToken,
      replacementExpected: Boolean(existing.build && existing.build !== input.buildId),
      startedByCaller: false
    };
  }
  if (await isTcpPortListening("127.0.0.1", port)) {
    throw new Error(`Authority port is occupied by a non-responsive service: ${url}`);
  }
  const child = await startDetachedAuthority(input, authorityId, port);
  await waitForEmbeddedAuthority(url, authorityId, Boolean(input.authToken));
  return {
    url,
    authorityId,
    buildId: input.buildId,
    authToken: input.authToken,
    startedByCaller: true,
    pid: child.pid
  };
};

export const probeEmbeddedAuthority = async (
  url: string,
  authorityId: string,
  expectedAuthRequired: boolean
): Promise<HealthPayload | null> => {
  let response: Response;
  try {
    response = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(1_000) });
  } catch {
    return null;
  }
  if (!response.ok) throw new Error(`Authority port returned HTTP ${response.status}: ${url}`);
  let health: HealthPayload;
  try {
    health = await response.json() as HealthPayload;
  } catch {
    throw new Error(`Authority port is occupied by a non-CodexHub service: ${url}`);
  }
  if (!health.authority) throw new Error(`Authority port is occupied by a non-authority CodexHub service: ${url}`);
  if (health.authRequired !== expectedAuthRequired) {
    const expected = expectedAuthRequired ? "enabled" : "disabled";
    const received = health.authRequired ? "enabled" : "disabled";
    throw new Error(`Authority authentication mode mismatch on ${url}: expected ${expected}, received ${received}.`);
  }
  if (health.authority.authorityId !== authorityId) {
    throw new Error(`Authority mismatch on ${url}: expected ${authorityId}, received ${health.authority.authorityId}.`);
  }
  if (health.authority.surfaceProtocolVersion !== embeddedSurfaceProtocolVersion) {
    throw new Error(
      `Authority protocol mismatch on ${url}: expected ${embeddedSurfaceProtocolVersion}, `
      + `received ${health.authority.surfaceProtocolVersion}.`
    );
  }
  return health;
};

export const waitForEmbeddedAuthority = async (
  url: string,
  authorityId: string,
  expectedAuthRequired: boolean,
  timeoutMs = 20_000
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeEmbeddedAuthority(url, authorityId, expectedAuthRequired);
    if (health) return health;
    await delay(200);
  }
  throw new Error(`Timed out waiting for CodexHub authority service at ${url}.`);
};

const startDetachedAuthority = async (
  input: EnsureEmbeddedAuthorityInput,
  authorityId: string,
  port: number
) => {
  await Promise.all([stat(input.authorityServicePath), stat(input.staticDirectory)]);
  await mkdir(input.dataDir, { recursive: true });
  const logPath = path.join(input.dataDir, input.logFileName ?? "authority.log");
  const logFd = openSync(logPath, "a", 0o600);
  try {
    const args = [
      input.authorityServicePath,
      "--port", String(port),
      "--authority-id", authorityId,
      "--authority-kind", authorityKind(),
      "--data-dir", input.dataDir,
      "--static-directory", input.staticDirectory,
      "--build-id", input.buildId,
      ...(input.remoteClientPath ? ["--remote-client", input.remoteClientPath] : []),
      ...(input.projectCatalog ? ["--project-catalog", input.projectCatalog] : []),
      ...(input.authToken ? ["--auth-token-env", "CODEX_HUB_AUTH_TOKEN"] : [])
    ];
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.runAsElectronNode ? { ELECTRON_RUN_AS_NODE: "1" } : {})
    };
    delete childEnv.CODEX_HUB_AUTH_TOKEN;
    if (input.authToken) childEnv.CODEX_HUB_AUTH_TOKEN = input.authToken;
    const child = spawn(process.execPath, args, {
      cwd: input.dataDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: childEnv
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
};

const isTcpPortListening = async (host: string, port: number) => await new Promise<boolean>((resolve) => {
  const socket = net.createConnection({ host, port });
  const finish = (listening: boolean) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(listening);
  };
  socket.setTimeout(500);
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  socket.once("timeout", () => finish(false));
});

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
