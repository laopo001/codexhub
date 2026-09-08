import { readBooleanEnv } from "../shared/env.js";
import type { CodexAppServerLaunchOptions } from "../shared/appServerLaunch.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, open as openFile, readFile, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveAuthorityNode, type AuthorityNodeRuntime } from "./authorityNode.js";
import { readServerConfigEnv } from "./serverConfigEnv.js";
import type { HealthPayload } from "../shared/apiContract.js";
import {
  authorityKind,
  authorityServicePort,
  authorityServiceHost,
  embeddedSurfaceProtocolVersion,
  type AuthorityServiceSource
} from "../shared/surfaceTypes.js";

export type EmbeddedAuthorityHandle = {
  url: string;
  authorityId: string;
  buildId: string;
  authToken: string;
  replacementExpected?: boolean;
  startedByCaller: boolean;
  pid?: number;
  serverInstanceId: string;
  localMachineEnabled?: boolean;
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
  /** Environment visible to the launcher for config.yaml-backed resolution. */
  environment?: NodeJS.ProcessEnv;
  authorityServiceSource?: AuthorityServiceSource;
  /** Optional complete argv prefix for a shared CLI authority entrypoint. */
  serviceCommand?: string[];
  /** Explicit app-server launch policy; validated on reuse and preserved across restart. */
  appServerLaunch?: CodexAppServerLaunchOptions;
  requireStaticDirectory?: boolean;
  requireHost?: boolean;
  host?: string;
  startupTimeoutMs?: number;
};

export type AuthorityRestartLaunchSpec = {
  servicePath: string;
  serviceCommand?: string[];
  appServerLaunch?: CodexAppServerLaunchOptions;
  staticDirectory: string;
  remoteClientPath?: string;
  dataDir: string;
  authorityId: string;
  authorityKind: ReturnType<typeof authorityKind>;
  host: string;
  port: number;
  projectCatalog: "editable" | "fixed";
  buildId: string;
  protocolVersion: number;
  nodeCommand: string;
  nodeSource: AuthorityNodeRuntime["source"];
  authRequired: boolean;
  oldPid: number;
  oldServerInstanceId: string;
};

/** Cross-build file contract. Future bundles must continue to read V1. */
export type AuthorityRestartHandoffV1 = {
  version: 1;
  spec: AuthorityRestartLaunchSpec;
  authToken: string;
};

export type AuthorityRestartCoordinator = {
  request: (targetBuildId?: string) => Promise<{ ok: true; restarting: true } | { ok: false; restarting: false; error: string }>;
};

export type AuthorityRestartCoordinatorInput = Omit<AuthorityRestartLaunchSpec, "buildId" | "oldServerInstanceId"> & {
  buildId: string | null;
  serverInstanceId: string;
  authorityBuildFiles: string[];
  authToken: string;
  onClose: () => void | Promise<void>;
  spawnSupervisor?: (spec: AuthorityRestartLaunchSpec, authToken: string) => Promise<void>;
};

export type AuthorityStopReason = "recovery" | "shutdown";

/** Decide whether an owned PID may be stopped for this lifecycle operation. */
export const shouldStopOwnedAuthorityProcess = (
  handle: Pick<EmbeddedAuthorityHandle, "startedByCaller" | "pid" | "serverInstanceId">,
  health: Pick<HealthPayload, "serverInstanceId"> | null | undefined,
  reason: AuthorityStopReason
) => {
  if (!handle.startedByCaller || !handle.pid || !handle.serverInstanceId) return false;
  if (!health) return true;
  if (health.serverInstanceId !== handle.serverInstanceId) return false;
  return reason === "shutdown";
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

export const parseAuthorityRestartHandoff = (raw: string): AuthorityRestartHandoffV1 => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid authority restart handoff: malformed JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid authority restart handoff envelope.");
  }
  const envelope = value as Record<string, unknown>;
  if (!("version" in envelope)) {
    throw new Error("Unsupported authority restart handoff version: missing version.");
  }
  if (envelope.version !== 1) {
    throw new Error(`Unsupported authority restart handoff version: ${String(envelope.version)}.`);
  }
  if (Object.keys(envelope).some((key) => !["version", "spec", "authToken"].includes(key))) {
    throw new Error("Invalid authority restart handoff envelope fields.");
  }
  if (!envelope.spec || typeof envelope.spec !== "object" || Array.isArray(envelope.spec)
    || typeof envelope.authToken !== "string") {
    throw new Error("Invalid authority restart handoff envelope.");
  }
  return envelope as AuthorityRestartHandoffV1;
};

/**
 * Authority-owned restart handoff. The supervisor is the same bundled
 * authority service, so hosts do not need a second restart protocol.
 */
export const createAuthorityRestartCoordinator = (
  input: AuthorityRestartCoordinatorInput
): AuthorityRestartCoordinator => {
  let inFlight: Promise<{ ok: true; restarting: true } | { ok: false; restarting: false; error: string }> | null = null;
  return {
    request: (targetBuildId) => {
      if (inFlight) return inFlight;
      inFlight = requestRestart(input, targetBuildId).then((result) => {
        // A successful handoff permanently consumes this authority generation.
        // Only validation/spawn failures before shutdown may be retried.
        if (!result.ok) inFlight = null;
        return result;
      });
      return inFlight;
    }
  };
};

const requestRestart = async (
  input: AuthorityRestartCoordinatorInput,
  requestedBuildId?: string
) => {
  try {
    const buildId = requestedBuildId?.trim() || input.buildId?.trim() || "";
    if (!buildId) throw new Error("No verified successor build is available.");
    if (!/^[^:\s]+:\d+:[a-f0-9]{20}$/i.test(buildId)) {
      throw new Error(`Invalid successor build id: ${buildId}`);
    }
    const actualBuildId = await authorityBuildId(input.authorityBuildFiles);
    if (buildFingerprint(actualBuildId) !== buildFingerprint(buildId)) {
      throw new Error(`Successor build is not present or is incomplete: expected ${buildId}, found ${actualBuildId}.`);
    }
    await validateRestartLaunchSpec({ ...input, buildId, oldServerInstanceId: input.serverInstanceId });
    const spec: AuthorityRestartLaunchSpec = {
      servicePath: input.servicePath,
      serviceCommand: input.serviceCommand,
      appServerLaunch: input.appServerLaunch,
      staticDirectory: input.staticDirectory,
      ...(input.remoteClientPath ? { remoteClientPath: input.remoteClientPath } : {}),
      dataDir: input.dataDir,
      authorityId: input.authorityId,
      authorityKind: input.authorityKind,
      host: input.host,
      port: input.port,
      projectCatalog: input.projectCatalog,
      buildId,
      protocolVersion: input.protocolVersion,
      nodeCommand: input.nodeCommand,
      nodeSource: input.nodeSource,
      authRequired: input.authRequired,
      oldPid: process.pid,
      oldServerInstanceId: input.serverInstanceId,
    };
    await (input.spawnSupervisor ?? spawnRestartSupervisor)(spec, input.authToken);
    // The supervisor waits for this PID and owns the bind/health verification.
    // Closing after the response has been scheduled keeps the HTTP acknowledgement
    // useful while guaranteeing that no host-specific recovery is required.
    const closeTimer = setTimeout(() => void input.onClose(), 25);
    closeTimer.unref?.();
    return { ok: true, restarting: true } as const;
  } catch (error) {
    return { ok: false, restarting: false, error: error instanceof Error ? error.message : String(error) } as const;
  }
};

const buildFingerprint = (buildId: string) => buildId.split(":").slice(-2).join(":");

const validateRestartLaunchSpec = async (input: AuthorityRestartCoordinatorInput & { buildId: string; oldServerInstanceId: string }) => {
  if (!input.authorityId.startsWith("authority-")) throw new Error("Invalid authority id in restart spec.");
  if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65_535) throw new Error("Invalid authority port in restart spec.");
  authorityServiceHost({}, input.host);
  if (input.protocolVersion !== embeddedSurfaceProtocolVersion) throw new Error("Invalid authority protocol in restart spec.");
  const [service, staticDir] = await Promise.all([stat(input.servicePath), stat(input.staticDirectory)]);
  if (!service.isFile() || !staticDir.isDirectory()) throw new Error("Restart spec paths are not usable.");
  if (input.remoteClientPath) {
    const remote = await stat(input.remoteClientPath);
    if (!remote.isFile()) throw new Error("Restart spec remote client is not usable.");
  }
};

const spawnRestartSupervisor = async (spec: AuthorityRestartLaunchSpec, authToken: string) => {
  const logPath = path.join(spec.dataDir, "authority-restart.log");
  await mkdir(spec.dataDir, { recursive: true });
  const handoffPath = path.join(spec.dataDir, `authority-restart-${randomUUID()}.json`);
  await writeFile(handoffPath, JSON.stringify({ version: 1, spec, authToken } satisfies AuthorityRestartHandoffV1), { flag: "wx", mode: 0o600 });
  const logFd = openSync(logPath, "a", 0o600);
  try {
    const childEnv: NodeJS.ProcessEnv = { ...(process.env as NodeJS.ProcessEnv) };
    delete childEnv.CODEX_HUB_AUTH_TOKEN;
    const child = spawn(spec.nodeCommand, [...(spec.serviceCommand ?? [spec.servicePath]), "--restart-supervisor", "--handoff", handoffPath], {
      cwd: spec.dataDir, detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd], env: childEnv
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    child.unref();
  } catch (error) {
    await unlink(handoffPath).catch(() => undefined);
    throw error;
  } finally {
    closeSync(logFd);
  }
};

export const runAuthorityRestartSupervisor = async (handoffPath: string) => {
  if (!handoffPath) throw new Error("Missing authority restart handoff path.");
  let raw: string;
  try {
    raw = await readFile(handoffPath, "utf8");
  } finally {
    await unlink(handoffPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  // V1 is a compatibility boundary: a newer bundle must retain this parser
  // even when it evolves the successor launch spec.
  const handoff = parseAuthorityRestartHandoff(raw);
  const spec = handoff.spec;
  const authToken = handoff.authToken;
  if (!spec || typeof spec !== "object" || !Number.isInteger(spec.oldPid) || spec.oldPid <= 0
    || typeof spec.servicePath !== "string" || typeof spec.staticDirectory !== "string"
    || typeof spec.dataDir !== "string" || typeof spec.authorityId !== "string"
    || typeof spec.buildId !== "string" || typeof spec.nodeCommand !== "string") {
    throw new Error("Invalid authority restart spec.");
  }
  await validateRestartLaunchSpec({ ...spec, authToken, authorityBuildFiles: [], buildId: spec.buildId, serverInstanceId: spec.oldServerInstanceId, onClose: () => undefined });
  await waitForProcessExit(spec.oldPid, 20_000);
  await waitForPortRelease(spec.host === "0.0.0.0" || spec.host === "::" ? "127.0.0.1" : spec.host, spec.port, 20_000);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.CODEX_HUB_RESTART_HANDOFF;
  delete childEnv.CODEX_HUB_AUTH_TOKEN;
  if (authToken) childEnv.CODEX_HUB_AUTH_TOKEN = authToken;
  const args = [...(spec.serviceCommand ?? [spec.servicePath]), "--host", spec.host, ...authorityLaunchArgs(spec.appServerLaunch), "--port", String(spec.port), "--authority-id", spec.authorityId, "--authority-kind", spec.authorityKind, "--data-dir", spec.dataDir, "--static-directory", spec.staticDirectory, "--build-id", spec.buildId, "--project-catalog", spec.projectCatalog, ...(spec.remoteClientPath ? ["--remote-client", spec.remoteClientPath] : []), ...(spec.authRequired ? ["--auth-token-env", "CODEX_HUB_AUTH_TOKEN"] : [])];
  const logPath = path.join(spec.dataDir, "authority.log");
  const logFd = openSync(logPath, "a", 0o600);
  try {
    const child = spawn(spec.nodeCommand, args, { cwd: spec.dataDir, detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd], env: childEnv });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  const deadline = Date.now() + 30_000;
  let lastError = "successor health check timed out";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${spec.port}/api/health`, {
        headers: spec.authRequired ? { authorization: `Bearer ${authToken}` } : undefined
      });
      const health = await response.json() as HealthPayload;
      if (response.ok && health.authority?.authorityId === spec.authorityId && health.build === spec.buildId && health.authority.surfaceProtocolVersion === spec.protocolVersion && health.serverInstanceId !== spec.oldServerInstanceId) return;
      lastError = `successor health mismatch: ${JSON.stringify({ status: response.status, authorityId: health.authority?.authorityId, build: health.build, protocol: health.authority?.surfaceProtocolVersion, serverInstanceId: health.serverInstanceId })}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(200);
  }
  throw new Error(`Authority successor failed verification: ${lastError}`);
};

const waitForProcessExit = async (pid: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    await delay(100);
  }
  throw new Error(`Old authority process ${pid} did not exit.`);
};

const waitForPortRelease = async (host: string, port: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isTcpPortListening(host, port)) return;
    await delay(100);
  }
  throw new Error(`Authority port ${port} did not become available.`);
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
  }, process.platform);
};

/**
 * Resolve the detached authority listen host. Authorities stay loopback-only
 * by default; an explicit wildcard host is required before exposing one to a
 * LAN. Process environment values win over config.yaml, matching the port
 * and auth-token precedence used by the embedded clients.
 */
export const resolveEmbeddedAuthorityHost = async (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
) => {
  const configEnv = await readServerConfigEnv(path.join(dataDir, "config.yaml"));
  return authorityServiceHost({ ...(configEnv ?? {}), ...env });
};

export const ensureEmbeddedAuthority = async (
  input: EnsureEmbeddedAuthorityInput
): Promise<EmbeddedAuthorityHandle> => {
  const environment = input.environment ?? process.env;
  const port = input.port ?? await resolveEmbeddedAuthorityPort(input.dataDir, environment);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + positiveStartupTimeout(input.startupTimeoutMs);
  const lock = await acquireAuthorityStartupLock(input.dataDir, port, deadline);
  try {
    const authorityId = await resolveAuthorityId(input.dataDir);
    const host = input.host ?? await resolveEmbeddedAuthorityHost(input.dataDir, environment);
    input = { ...input, host, requireHost: input.requireHost ?? Boolean(
      input.host !== undefined || environment.CODEX_HUB_HOST?.trim() || environment.CODEX_HUB_AUTHORITY_HOST?.trim()
    ) };
    let existing = await probeEmbeddedAuthority(url, authorityId, Boolean(input.authToken), input.authToken);
    if (existing) return authorityHandle(input, url, authorityId, existing, false);
    if (await isTcpPortListening("127.0.0.1", port)) {
      existing = await probeEmbeddedAuthorityWithRetry(
        url,
        authorityId,
        Boolean(input.authToken),
        { authToken: input.authToken }
      );
      if (existing) return authorityHandle(input, url, authorityId, existing, false);
      throw new Error(`Authority port is occupied by a non-responsive service: ${url}`);
    }
    const nodeRuntime = await resolveAuthorityNode(environment);
    const child = await startDetachedAuthority(input, authorityId, port, nodeRuntime);
    try {
      const health = await waitForEmbeddedAuthority(
        url,
        authorityId,
        Boolean(input.authToken),
        Math.max(1, deadline - Date.now()),
        input.authToken
      );
      return { ...authorityHandle(input, url, authorityId, health, true), pid: child.pid };
    } catch (error) {
      await stopDetachedAuthority(child.pid);
      throw await authorityStartupError(error, input.dataDir, input.authToken);
    }
  } finally {
    await lock.release();
  }
};

const authorityHandle = (
  input: EnsureEmbeddedAuthorityInput,
  url: string,
  authorityId: string,
  health: HealthPayload,
  startedByCaller: boolean
): EmbeddedAuthorityHandle => {
  if (health.port !== Number(new URL(url).port || 80)) throw new Error(`Authority listen port mismatch on ${url}.`);
  if (health.configPath !== path.join(path.resolve(input.dataDir), "config.yaml")) {
    throw new Error(`Authority profile mismatch on ${url}: config directory differs.`);
  }
  const environment = input.environment ?? process.env;
  if (environment.CODEX_HUB_LOCAL_MACHINE !== undefined
    && health.features?.localMachine !== readBooleanEnv(environment, "CODEX_HUB_LOCAL_MACHINE", true)) {
    throw new Error(`Authority local machine configuration mismatch on ${url}.`);
  }
  if (input.requireHost && health.host !== input.host) throw new Error(`Authority listen host mismatch on ${url}.`);
  if (input.requireStaticDirectory && health.staticDirectory !== path.resolve(input.staticDirectory)) {
    throw new Error(`Authority static directory mismatch on ${url}.`);
  }
  for (const [key, value] of Object.entries(input.appServerLaunch ?? {})) {
    if (value !== undefined && health.appServerLaunch?.[key as keyof CodexAppServerLaunchOptions] !== value) {
      throw new Error(`Authority app-server ${key} differs; restart with the requested configuration.`);
    }
  }
  return {
    url,
    authorityId,
    buildId: input.buildId,
    authToken: input.authToken,
    replacementExpected: Boolean(health.build && health.build !== input.buildId),
    startedByCaller,
    serverInstanceId: requireServerInstanceId(health),
    localMachineEnabled: health.features?.localMachine !== false
  };
};

const requireServerInstanceId = (health: HealthPayload) => {
  const value = health.serverInstanceId?.trim();
  if (!value) throw new Error("Authority health did not expose serverInstanceId.");
  return value;
};

export const probeEmbeddedAuthority = async (
  url: string,
  authorityId: string,
  expectedAuthRequired: boolean,
  authToken?: string
): Promise<HealthPayload | null> => {
  let response: Response;
  try {
    response = await fetch(new URL("/api/health", url), {
      headers: authToken ? { authorization: `Bearer ${authToken}` } : undefined,
      signal: AbortSignal.timeout(1_000)
    });
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
  if (health?.ok !== true || typeof health.version !== "string" || !health.version.trim()) {
    throw new Error(`Authority port is occupied by a non-CodexHub service: ${url}`);
  }
  if (!health.authority) throw new Error(`Authority port is occupied by a non-authority CodexHub service: ${url}`);
  if (health.authRequired !== expectedAuthRequired) {
    const expected = expectedAuthRequired ? "enabled" : "disabled";
    const received = health.authRequired ? "enabled" : "disabled";
    throw new Error(`Authority authentication mode mismatch on ${url}: expected ${expected}, received ${received}.`);
  }
  if (expectedAuthRequired && health.authenticated !== true) {
    throw new Error(`Authority authentication failed on ${url}.`);
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

export const probeEmbeddedAuthorityWithRetry = async (
  url: string,
  authorityId: string,
  expectedAuthRequired: boolean,
  options: { attempts?: number; retryDelayMs?: number; authToken?: string } = {}
): Promise<HealthPayload | null> => {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 250));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await probeEmbeddedAuthority(url, authorityId, expectedAuthRequired, options.authToken);
    if (health) return health;
    if (attempt + 1 < attempts && retryDelayMs > 0) await delay(retryDelayMs);
  }
  return null;
};

export const waitForEmbeddedAuthority = async (
  url: string,
  authorityId: string,
  expectedAuthRequired: boolean,
  timeoutMs = 20_000,
  authToken?: string
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeEmbeddedAuthority(url, authorityId, expectedAuthRequired, authToken);
    if (health) return health;
    await delay(200);
  }
  throw new Error(`Timed out waiting for CodexHub authority service at ${url}.`);
};

const startDetachedAuthority = async (
  input: EnsureEmbeddedAuthorityInput,
  authorityId: string,
  port: number,
  nodeRuntime: AuthorityNodeRuntime
) => {
  await stat(input.authorityServicePath);
  await mkdir(input.dataDir, { recursive: true });
  const logPath = path.join(input.dataDir, input.logFileName ?? "authority.log");
  const logFd = openSync(logPath, "a", 0o600);
  try {
    const args = [
      ...(input.serviceCommand ?? [input.authorityServicePath]),
      ...(input.host ? ["--host", input.host] : []),
      ...authorityLaunchArgs(input.appServerLaunch),
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
    const childEnv: NodeJS.ProcessEnv = { ...(input.environment ?? process.env), CODEX_HUB_DATA_DIR: input.dataDir };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    if (input.runAsElectronNode && nodeRuntime.source === "host-fallback") {
      childEnv.ELECTRON_RUN_AS_NODE = "1";
    }
    childEnv.CODEX_HUB_AUTHORITY_NODE_SOURCE = nodeRuntime.source;
    childEnv.CODEX_HUB_AUTHORITY_SERVICE_SOURCE = input.authorityServiceSource ?? "unknown";
    delete childEnv.CODEX_HUB_AUTH_TOKEN;
    if (input.authToken) childEnv.CODEX_HUB_AUTH_TOKEN = input.authToken;
    const child = spawn(nodeRuntime.command, args, {
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

const positiveStartupTimeout = (value: number | undefined) => {
  if (value === undefined) return 30_000;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Authority startup timeout must be greater than 0.");
  return Math.floor(value);
};

const acquireAuthorityStartupLock = async (dataDir: string, port: number, deadline: number) => {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, `authority-${port}.lock`);
  const token = randomUUID();
  while (Date.now() < deadline) {
    try {
      const handle = await openFile(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return {
        release: async () => {
          await handle.close().catch(() => undefined);
          try {
            const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
            if (current.token !== token) return;
          } catch {
            return;
          }
          await unlink(lockPath).catch(() => undefined);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeDeadAuthorityStartupLock(lockPath)) continue;
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for the CodexHub authority startup lock for port ${port}.`);
};

const removeDeadAuthorityStartupLock = async (lockPath: string) => {
  let info;
  try {
    info = await stat(lockPath);
  } catch {
    return true;
  }
  let record: { pid?: number };
  try {
    record = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
  } catch {
    if (Date.now() - info.mtimeMs < 30_000) return false;
    await unlinkIfUnchanged(lockPath, info.mtimeMs, info.size);
    return true;
  }
  if (typeof record.pid === "number") {
    try {
      process.kill(record.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      // The owner is gone; the lock can be reclaimed.
    }
  }
  await unlinkIfUnchanged(lockPath, info.mtimeMs, info.size);
  return true;
};

const unlinkIfUnchanged = async (lockPath: string, mtimeMs: number, size: number) => {
  try {
    const current = await stat(lockPath);
    if (current.mtimeMs !== mtimeMs || current.size !== size) return false;
    await unlink(lockPath);
    return true;
  } catch {
    return false;
  }
};

const stopDetachedAuthority = async (pid: number | undefined) => {
  if (!pid || pid === process.pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  await delay(500);
  try { process.kill(pid, 0); } catch { return; }
  try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
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

const authorityLaunchArgs = (options: CodexAppServerLaunchOptions = {}) => [
  ...(options.approvalPolicy ? ["--approval-policy", options.approvalPolicy] : []),
  ...(options.approvalsReviewer ? ["--approvals-reviewer", options.approvalsReviewer] : []),
  ...(options.sandbox ? ["--sandbox", options.sandbox] : [])
];

/** Failure cleanup only owns the generation spawned by this bootstrap call. */
export const cleanupFailedAuthorityStartup = async (handle: EmbeddedAuthorityHandle) => {
  if (!handle.startedByCaller || !handle.pid) return;
  const health = await probeEmbeddedAuthority(handle.url, handle.authorityId, Boolean(handle.authToken), handle.authToken);
  if (health && health.serverInstanceId !== handle.serverInstanceId) return;
  await stopDetachedAuthority(handle.pid);
};

export const authorityStartupError = async (error: unknown, dataDir: string, authToken: string) => {
  let message = error instanceof Error ? error.message : String(error);
  const file = await openFile(path.join(dataDir, "authority.log"), "r").catch(() => null);
  if (file) {
    try {
      const info = await file.stat();
      const buffer = Buffer.alloc(Math.min(info.size, 4000));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length));
      if (bytesRead) message += `\nRecent local server log:\n${buffer.subarray(0, bytesRead).toString("utf8")}`;
    } finally { await file.close(); }
  }
  const secrets = [authToken, ...Object.entries(process.env)
    .filter(([key]) => /TOKEN|PASSWORD|SECRET/i.test(key)).map(([, value]) => value ?? "")];
  for (const secret of secrets) if (secret) message = message.split(secret).join("[REDACTED]");
  return new Error(message);
};
