import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HealthPayload, MachinesPayload, RuntimesPayload } from "../shared/apiContract.js";
import type { MachineSummary } from "../shared/machineTypes.js";
import { codexHubDataDirectory } from "../core/authorityPaths.js";
import { codexhubVersion } from "../shared/version.js";

const DEFAULT_SERVER_PORT = 8788;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const RUNTIME_POLL_INTERVAL_MS = 250;
const DEFAULT_START_TIMEOUT_MS = 120_000;
const LOCK_WAIT_INTERVAL_MS = 100;
const STALE_LOCK_AGE_MS = 30_000;
const LOG_TAIL_LIMIT = 4_000;

type LocalServerBootstrapInput = {
  baseUrl: string;
  dataDir?: string;
  authToken?: string;
  cwd?: string;
  timeoutMs?: number;
  deadline?: number;
};

export type LocalServerBootstrapResult = {
  baseUrl: string;
  status: "started" | "reused";
  machineId: string;
};

type LocalServerHealth = HealthPayload & {
  ok: true;
  version: string;
  serverInstanceId: string;
  configPath: string;
  authRequired: boolean;
  authenticated: true;
  port: number;
};

type LockRecord = {
  pid: number;
  token: string;
  createdAt: string;
};

type SpawnedServer = {
  child: ChildProcess;
  logPath: string;
  error?: Error;
};

class LocalServerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LocalServerHttpError";
  }
}

class LocalServerHealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalServerHealthError";
  }
}

class LocalServerLockTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for another codexhub local server startup.");
    this.name = "LocalServerLockTimeoutError";
  }
}

const inProcessStarts = new Map<string, Promise<LocalServerBootstrapResult>>();

/** Resolve the standalone CLI server endpoint without ever selecting a remote host. */
export const defaultLocalServerUrl = (
  hostValue = process.env.CODEX_HUB_HOST,
  portValue = process.env.CODEX_HUB_PORT
) => {
  const host = hostValue ?? "127.0.0.1";
  if (!isLoopbackOrWildcardHost(host)) {
    throw new Error(
      `Cannot auto-start the local CodexHub server with CODEX_HUB_HOST=${host}; `
      + "specify --connect or CODEX_HUB_SERVER_URL for a remote backend."
    );
  }
  const port = parseServerPort(portValue);
  return `http://127.0.0.1:${port}`;
};

/** Ensure the standalone default server and its local runtime are ready for CLI conversation commands. */
export const ensureLocalServer = (input: LocalServerBootstrapInput): Promise<LocalServerBootstrapResult> => {
  const dataDir = path.resolve(input.dataDir ?? codexHubDataDirectory());
  const endpoint = normalizeLocalEndpoint(input.baseUrl);
  const key = `${dataDir}\u0000${endpoint}`;
  const existing = inProcessStarts.get(key);
  if (existing) return existing;

  const promise = ensureLocalServerInternal({ ...input, baseUrl: endpoint, dataDir });
  inProcessStarts.set(key, promise);
  return promise.finally(() => {
    if (inProcessStarts.get(key) === promise) inProcessStarts.delete(key);
  });
};

const ensureLocalServerInternal = async (
  input: LocalServerBootstrapInput & { dataDir: string; baseUrl: string }
): Promise<LocalServerBootstrapResult> => {
  const deadline = Math.min(Date.now() + readStartTimeout(input.timeoutMs), input.deadline ?? Number.POSITIVE_INFINITY);
  if (deadline <= Date.now()) throw new Error("No time remains in the CLI conversation timeout for local server startup.");
  const expected = expectedHealth(input);
  const current = await probeHealth(input.baseUrl, expected, input.authToken);
  if (current) {
    assertLocalMachineEnabled(current);
    const machineId = await waitForLocalRuntime(input, input.authToken, input.cwd, deadline);
    return { baseUrl: input.baseUrl, status: "reused", machineId };
  }

  const lock = await acquireStartupLock(input.dataDir, input.baseUrl, deadline);
  try {
    const afterLock = await probeHealth(input.baseUrl, expected, input.authToken);
    if (afterLock) {
      assertLocalMachineEnabled(afterLock);
      const machineId = await waitForLocalRuntime(input, input.authToken, input.cwd, deadline);
      return { baseUrl: input.baseUrl, status: "reused", machineId };
    }

    const spawned = await spawnLocalServer(input.dataDir, input.baseUrl);
    try {
      const health = await waitForHealth(input.baseUrl, expected, input.authToken, spawned, deadline);
      assertLocalMachineEnabled(health);
      const machineId = await waitForLocalRuntime(input, input.authToken, input.cwd, deadline);
      return { baseUrl: input.baseUrl, status: "started", machineId };
    } catch (error) {
      await stopSpawnedServer(spawned.child);
      throw await diagnosticStartupError(error, spawned.logPath, input.authToken);
    }
  } finally {
    await lock.release();
  }
};

const expectedHealth = (input: LocalServerBootstrapInput & { dataDir: string }) => ({
  configPath: path.join(input.dataDir, "config.yaml"),
  port: portFromUrl(new URL(input.baseUrl))
});

const normalizeLocalEndpoint = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid local CodexHub backend URL: ${value}`);
  }
  const hostname = normalizeHost(url.hostname);
  if (url.protocol !== "http:" || hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash) {
    throw new Error("Automatic local CodexHub startup requires an http://127.0.0.1 endpoint.");
  }
  url.pathname = "/";
  return url.toString().replace(/\/$/, "");
};

const isLoopbackOrWildcardHost = (value: string) => {
  const host = normalizeHost(value);
  return isLoopbackHost(host) || host === "0.0.0.0" || host === "::";
};

const isLoopbackHost = (host: string) =>
  host === "localhost"
  || (isIP(host) === 4 && host.startsWith("127."))
  || (isIP(host) === 6 && (host === "::1" || host === "0:0:0:0:0:0:0:1"));

const normalizeHost = (value: string) => value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

const parseServerPort = (value: string | undefined) => {
  const raw = value ?? String(DEFAULT_SERVER_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid CODEX_HUB_PORT: ${raw}`);
  }
  return port;
};

const portFromUrl = (url: URL) => Number(url.port || (url.protocol === "https:" ? 443 : 80));

const readStartTimeout = (override: number | undefined) => {
  const value = process.env.CODEX_HUB_LOCAL_SERVER_START_TIMEOUT_MS;
  const configured = value === undefined ? DEFAULT_START_TIMEOUT_MS : Number(value);
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new Error(`Invalid CODEX_HUB_LOCAL_SERVER_START_TIMEOUT_MS: ${value}`);
  }
  if (override === undefined) return configured;
  if (!Number.isFinite(override) || override <= 0) throw new Error("Local server startup timeout must be greater than 0.");
  return Math.min(override, configured);
};

const probeHealth = async (
  baseUrl: string,
  expected: { configPath: string; port: number },
  authToken: string | undefined
) => {
  const url = new URL("/api/health", baseUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: authHeaders(authToken),
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (isConnectionRefused(error)) return null;
    if (isAbortError(error)) throw new LocalServerHealthError(`Local CodexHub health probe timed out: ${baseUrl}`);
    throw new LocalServerHealthError(`Local CodexHub health probe failed: ${errorText(error)}`);
  }

  const body = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new LocalServerHealthError(`Local CodexHub port is occupied but authentication failed (HTTP ${response.status}).`);
    }
    throw new LocalServerHealthError(`Local CodexHub port is occupied by an invalid service (HTTP ${response.status}).`);
  }
  let health: HealthPayload;
  try {
    health = JSON.parse(body) as HealthPayload;
  } catch {
    throw new LocalServerHealthError("Local CodexHub port is occupied by a service with invalid health JSON.");
  }
  return assertMatchingHealth(health, expected, authToken);
};

const assertMatchingHealth = (
  health: HealthPayload,
  expected: { configPath: string; port: number },
  authToken: string | undefined
): LocalServerHealth => {
  if (health.ok !== true || health.version !== codexhubVersion || !nonEmpty(health.serverInstanceId)) {
    throw new LocalServerHealthError("Local CodexHub port is occupied by a non-matching or invalid CodexHub health response.");
  }
  if (health.configPath !== expected.configPath || health.port !== expected.port) {
    throw new LocalServerHealthError(
      `Local CodexHub profile mismatch on port ${expected.port}; the running config or port does not match ${expected.configPath}.`
    );
  }
  if (health.authRequired !== Boolean(authToken?.trim()) || health.authenticated !== true) {
    throw new LocalServerHealthError("Local CodexHub port is occupied but authentication does not match the current profile.");
  }
  return health as LocalServerHealth;
};

const assertLocalMachineEnabled = (health: LocalServerHealth) => {
  if (health.features?.localMachine === false) {
    throw new Error("The local CodexHub backend has local machine runtime disabled.");
  }
};

const waitForHealth = async (
  baseUrl: string,
  expected: { configPath: string; port: number },
  authToken: string | undefined,
  spawned: SpawnedServer,
  deadline: number
) => {
  while (Date.now() < deadline) {
    if (spawned.error) throw new Error(`Local CodexHub server child failed: ${spawned.error.message}`);
    if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
      throw new Error(`Local CodexHub server child exited before health was ready (${childExit(spawned.child)}).`);
    }
    const health = await probeHealth(baseUrl, expected, authToken);
    if (health) return health;
    await pauseUntil(deadline, RUNTIME_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for the local CodexHub server health at ${baseUrl}.`);
};

const waitForLocalRuntime = async (
  input: LocalServerBootstrapInput & { dataDir: string; baseUrl: string },
  authToken: string | undefined,
  cwd: string | undefined,
  deadline: number
) => {
  let ensureAttempted = false;
  let lastMachineState = "no online local machine";
  while (Date.now() < deadline) {
    const machines = await requestJson<MachinesPayload>(input.baseUrl, "/api/machines", authToken, deadline);
    const localMachines = (machines.machines ?? []).filter(isOnlineLocalLauncher);
    if (localMachines.length > 1) {
      throw new Error("The local CodexHub backend has multiple online local machines; choose an explicit backend/machine.");
    }
    const machine = localMachines[0];
    if (!machine) {
      lastMachineState = "no online local machine";
      await pauseUntil(deadline, RUNTIME_POLL_INTERVAL_MS);
      continue;
    }
    lastMachineState = `machine ${machine.machineId} has no online runtime`;
    const runtimes = await requestJson<RuntimesPayload>(input.baseUrl, "/api/runtimes", authToken, deadline);
    const runtime = (runtimes.runtimes ?? []).find((candidate) => candidate.machineId === machine.machineId && candidate.online);
    if (runtime) return machine.machineId;
    if (!ensureAttempted) {
      ensureAttempted = true;
      await requestJson(
        input.baseUrl,
        `/api/machines/${encodeURIComponent(machine.machineId)}/runtime/ensure`,
        authToken,
        deadline,
        { method: "POST", body: JSON.stringify({ cwd: cwd?.trim() || process.cwd() }) }
      );
    }
    await pauseUntil(deadline, RUNTIME_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for the default local CodexHub runtime (${lastMachineState}).`);
};

const isOnlineLocalLauncher = (machine: MachineSummary) =>
  machine.type === "local"
  && machine.online
  && machine.capabilities?.projectLauncher !== false;

const requestJson = async <T>(
  baseUrl: string,
  pathname: string,
  authToken: string | undefined,
  deadline: number,
  init: RequestInit = {}
): Promise<T> => {
  const remaining = Math.max(1, Math.min(90_000, deadline - Date.now()));
  let response: Response;
  try {
    const headers = authHeaders(authToken, init.headers);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    response = await fetch(new URL(pathname, baseUrl), {
      ...init,
      headers,
      signal: AbortSignal.timeout(remaining)
    });
  } catch (error) {
    throw new Error(`Local CodexHub request failed for ${pathname}: ${errorText(error)}`);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new LocalServerHttpError(
      response.status,
      `Local CodexHub request failed for ${pathname} (HTTP ${response.status}): ${redact(body, authToken)}`
    );
  }
  if (!body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Local CodexHub returned invalid JSON for ${pathname}.`);
  }
};

const authHeaders = (authToken: string | undefined, initial?: HeadersInit) => {
  const headers = new Headers(initial);
  const token = authToken?.trim();
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  return headers;
};

const spawnLocalServer = async (dataDir: string, baseUrl: string): Promise<SpawnedServer> => {
  const port = portFromUrl(new URL(baseUrl));
  const logPath = path.join(dataDir, `local-server-${port}.log`);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const logFile = await open(logPath, "a", 0o600);
  await chmod(logPath, 0o600);
  let child: ChildProcess;
  try {
    const command = localServerCommand();
    child = spawn(process.execPath, [
      ...command,
      "server",
      "--host",
      "127.0.0.1",
      "--port",
      String(port)
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HUB_DATA_DIR: dataDir },
      stdio: ["ignore", logFile.fd, logFile.fd],
      detached: true,
      windowsHide: true
    });
  } catch (error) {
    await logFile.close();
    throw new Error(`Unable to spawn the local CodexHub server: ${errorText(error)}`);
  }
  await logFile.close();
  const spawned: SpawnedServer = { child, logPath };
  child.once("error", (error) => {
    spawned.error = error;
  });
  child.unref();
  return spawned;
};

const localServerCommand = () => {
  const entry = process.argv[1];
  if (!entry) throw new Error("Unable to locate the current codexhub CLI entrypoint.");
  const possibleSource = process.argv[2];
  if (isTypeScriptEntrypoint(entry)) return [...process.execArgv, entry];
  if (isTsxLauncher(entry) && possibleSource && isTypeScriptEntrypoint(possibleSource)) {
    return [...process.execArgv, entry, possibleSource];
  }
  return [...process.execArgv, entry];
};

const isTypeScriptEntrypoint = (value: string) => /\.(?:cts|mts|ts|tsx)$/i.test(value);
const isTsxLauncher = (value: string) => /(?:^|[/\\])tsx(?:[/\\]|$)/i.test(value) || /tsx.*\.m?js$/i.test(value);

const acquireStartupLock = async (dataDir: string, baseUrl: string, deadline: number) => {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const port = portFromUrl(new URL(baseUrl));
  const lockPath = path.join(dataDir, `local-server-${port}.lock`);
  const token = randomUUID();
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await chmod(lockPath, 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() } satisfies LockRecord));
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return {
        release: async () => {
          await handle.close().catch(() => undefined);
          try {
            const current = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockRecord>;
            if (current.token !== token) return;
          } catch {
            return;
          }
          await unlink(lockPath).catch(() => undefined);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeDeadStartupLock(lockPath)) continue;
      await pauseUntil(deadline, LOCK_WAIT_INTERVAL_MS);
    }
  }
  throw new LocalServerLockTimeoutError();
};

const removeDeadStartupLock = async (lockPath: string) => {
  let info;
  try {
    info = await stat(lockPath);
  } catch {
    return true;
  }
  let record: Partial<LockRecord>;
  try {
    record = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockRecord>;
  } catch {
    if (Date.now() - info.mtimeMs < STALE_LOCK_AGE_MS) return false;
    await unlink(lockPath).catch(() => undefined);
    return true;
  }
  if (typeof record.pid === "number" && processAlive(record.pid)) return false;
  await unlink(lockPath).catch(() => undefined);
  return true;
};

const processAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopSpawnedServer = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { return; }
  await waitForChildExit(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    await waitForChildExit(child, 1_000);
  }
};

const waitForChildExit = async (child: ChildProcess, timeoutMs: number) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
  });
};

const diagnosticStartupError = async (error: unknown, logPath: string, authToken: string | undefined) => {
  const message = redact(errorText(error), authToken);
  const tail = await readLogTail(logPath, authToken);
  return new Error(`${message} See local server log ${logPath}.${tail ? ` Last log lines: ${tail}` : ""}`);
};

const readLogTail = async (logPath: string, authToken: string | undefined) => {
  let logFile;
  try {
    logFile = await open(logPath, "r");
    const info = await logFile.stat();
    const size = Math.min(info.size, LOG_TAIL_LIMIT);
    const buffer = Buffer.alloc(size);
    if (size > 0) await logFile.read(buffer, 0, size, info.size - size);
    return redact(buffer.toString("utf8"), authToken).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim();
  } catch {
    return "";
  } finally {
    await logFile?.close().catch(() => undefined);
  }
};

const childExit = (child: ChildProcess) =>
  child.signalCode ? `signal ${child.signalCode}` : `exit ${child.exitCode ?? "unknown"}`;

const pauseUntil = async (deadline: number, requestedMs: number) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await delay(Math.min(requestedMs, remaining));
};

const authTokenVariants = (authToken: string | undefined) => {
  const token = authToken?.trim();
  return token ? [token, encodeURIComponent(token)] : [];
};

const redact = (value: string, authToken: string | undefined) =>
  authTokenVariants(authToken).reduce((result, secret) => result.replaceAll(secret, "[REDACTED_SECRET]"), value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const isAbortError = (error: unknown) => error instanceof Error && error.name === "TimeoutError";
const isConnectionRefused = (error: unknown) => {
  const cause = error && typeof error === "object" && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  return (cause && typeof cause === "object" && "code" in cause && (cause as { code?: unknown }).code === "ECONNREFUSED")
    || error instanceof Error && error.message.includes("ECONNREFUSED");
};
