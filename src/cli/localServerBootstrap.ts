import { access, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MachinesPayload, RuntimesPayload } from "../shared/apiContract.js";
import type { MachineSummary } from "../shared/machineTypes.js";
import type { CodexAppServerLaunchOptions } from "../shared/appServerLaunch.js";
import { configuredAuthorityAuthToken } from "../core/authorityAuth.js";
import { authorityBuildId, ensureEmbeddedAuthority, cleanupFailedAuthorityStartup, authorityStartupError, type EmbeddedAuthorityHandle } from "../core/embeddedAuthority.js";
import { resolveAuthorityPackage } from "../core/authorityPackage.js";
import { codexHubDataDirectory } from "../core/authorityPaths.js";
import { mergeServerConfigEnv, readServerConfigEnv } from "../core/serverConfigEnv.js";
import { authorityServiceHost, authorityServicePort } from "../shared/surfaceTypes.js";

const RUNTIME_POLL_INTERVAL_MS = 250;
const DEFAULT_START_TIMEOUT_MS = 120_000;

type LocalAuthorityInput = {
  baseUrl: string;
  dataDir?: string;
  authToken?: string;
  timeoutMs?: number;
  deadline?: number;
  host?: string;
  staticDirectory?: string;
  appServerLaunch?: CodexAppServerLaunchOptions;
};
type LocalServerBootstrapInput = LocalAuthorityInput & { cwd?: string };
export type LocalServerBootstrapResult = {
  baseUrl: string;
  status: "started" | "reused";
  machineId: string;
  authority: EmbeddedAuthorityHandle;
};

/** Reuse the same authority client lease as Web documents; never stop shared work on CLI exit. */
export const startAuthorityClientLease = (input: {
  baseUrl: string;
  authToken?: string;
  clientId: string;
  intervalMs?: number;
  keepProcessAlive?: boolean;
}) => {
  let stopped = false;
  let failures = 0;
  let rejectFailure: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  // Conversation callers have their own HTTP/WS failure path.
  void failed.catch(() => undefined);
  const controller = new AbortController();
  const beat = async () => {
    if (stopped) return;
    const response = await fetch(new URL("/api/web-clients/heartbeat", input.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {})
      },
      body: JSON.stringify({ clientId: input.clientId }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)])
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`Authority heartbeat failed (HTTP ${response.status}).`);
    failures = 0;
  };
  const ready = beat();
  const timer = setInterval(() => {
    void beat().catch(() => {
      if (!stopped && ++failures >= 3) rejectFailure(new Error("Lost connection to the shared authority."));
    });
  }, input.intervalMs ?? 10_000);
  if (!input.keepProcessAlive) timer.unref();
  return { ready, failed, stop: () => { stopped = true; clearInterval(timer); controller.abort(); } };
};

export const defaultLocalServerUrl = (hostValue?: string, portValue?: string) => {
  try { authorityServiceHost(process.env, hostValue); } catch (error) {
    throw new Error(`Cannot auto-start the local CodexHub server: ${errorText(error)}`);
  }
  return `http://127.0.0.1:${authorityServicePort(process.env, process.platform, portValue)}`;
};

const modulePath = fileURLToPath(import.meta.url);
const sourceMode = modulePath.endsWith(".ts");
const packageRoot = path.resolve(path.dirname(modulePath), sourceMode ? "../.." : "../../..");

/** Server readiness does not require a local machine (e.g. Docker or remote-only control planes). */
export const ensureLocalAuthority = async (input: LocalAuthorityInput) => {
  const dataDir = path.resolve(input.dataDir ?? codexHubDataDirectory());
  const endpoint = normalizeLocalEndpoint(input.baseUrl);
  const deadline = Math.min(Date.now() + readStartTimeout(input.timeoutMs), input.deadline ?? Infinity);
  if (deadline <= Date.now()) throw new Error("No time remains in the CLI conversation timeout for local authority startup.");
  const configEnv = await readServerConfigEnv(path.join(dataDir, "config.yaml"));
  const environment = mergeServerConfigEnv(process.env, configEnv);
  const explicitStatic = input.staticDirectory ?? environment.CODEX_HUB_STATIC_DIR;
  let staticDirectory = path.resolve(explicitStatic || path.join(packageRoot, "dist"));
  if (explicitStatic && !(await stat(staticDirectory).catch(() => null))?.isDirectory()) {
    throw new Error(`CodexHub web assets are not available: ${staticDirectory}.`);
  }
  let authorityServicePath = sourceMode
    ? path.join(packageRoot, "src/server/authorityServiceMain.ts")
    : path.join(packageRoot, "dist-node/authority-service.cjs");
  let serviceCommand = sourceMode
    ? [path.join(packageRoot, "node_modules/tsx/dist/cli.mjs"), authorityServicePath]
    : undefined;
  let remoteClientPath: string | undefined = path.join(packageRoot, "dist-node/ssh/remote-client.cjs");
  if (environment.CODEX_HUB_AUTHORITY_PACKAGE?.trim()) {
    const selected = await resolveAuthorityPackage({ authorityServicePath, staticDirectory, remoteClientPath }, environment);
    authorityServicePath = selected.authorityServicePath;
    staticDirectory = explicitStatic ? staticDirectory : selected.staticDirectory;
    remoteClientPath = selected.remoteClientPath;
    serviceCommand = undefined;
  }
  const authority = await ensureEmbeddedAuthority({
    dataDir, authorityServicePath, serviceCommand, staticDirectory,
    remoteClientPath: remoteClientPath && await access(remoteClientPath).then(() => remoteClientPath).catch(() => undefined),
    authorityServiceSource: environment.CODEX_HUB_AUTHORITY_PACKAGE?.trim() ? "configured-package" : "bundled",
    buildId: await authorityBuildId([authorityServicePath, path.join(staticDirectory, "index.html")]),
    authToken: input.authToken !== undefined ? input.authToken.trim() : configuredAuthorityAuthToken(environment, configEnv),
    projectCatalog: "editable",
    port: Number(new URL(endpoint).port || 80),
    host: input.host,
    appServerLaunch: input.appServerLaunch,
    requireStaticDirectory: Boolean(explicitStatic),
    environment,
    startupTimeoutMs: deadline - Date.now()
  });
  return { baseUrl: endpoint, status: authority.startedByCaller ? "started" as const : "reused" as const, authority };
};

/** Conversation commands additionally require the authority's single local runtime. */
export const ensureLocalServer = async (input: LocalServerBootstrapInput): Promise<LocalServerBootstrapResult> => {
  const deadline = Math.min(Date.now() + readStartTimeout(input.timeoutMs), input.deadline ?? Infinity);
  const result = await ensureLocalAuthority({ ...input, deadline });
  try {
    if (result.authority.localMachineEnabled === false) throw new Error("The local CodexHub authority has local machine runtime disabled.");
    const machineId = await waitForLocalRuntime(input, result.authority.authToken, input.cwd, deadline);
    return { ...result, machineId };
  } catch (error) {
    await cleanupFailedAuthorityStartup(result.authority);
    throw await authorityStartupError(error, input.dataDir ?? codexHubDataDirectory(), result.authority.authToken);
  }
};

const normalizeLocalEndpoint = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid local CodexHub backend URL: ${value}`);
  }
  const hostname = normalizeHost(url.hostname);
  if (url.protocol !== "http:" || !isLoopbackHost(hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("Automatic local CodexHub startup requires an http:// loopback endpoint.");
  }
  url.pathname = "/";
  return url.toString().replace(/\/$/, "");
};

const waitForLocalRuntime = async (
  input: LocalServerBootstrapInput,
  authToken: string,
  cwd: string | undefined,
  deadline: number
) => {
  let ensureAttempted = false;
  let lastMachineState = "no online local machine";
  while (Date.now() < deadline) {
    const machines = await requestJson<MachinesPayload>(input.baseUrl, "/api/machines", authToken, deadline);
    const localMachines = (machines.machines ?? []).filter(isOnlineLocalLauncher);
    if (localMachines.length > 1) throw new Error("The local CodexHub authority has multiple online local machines.");
    const machine = localMachines[0];
    if (!machine) {
      lastMachineState = "no online local machine";
      await pauseUntil(deadline);
      continue;
    }
    lastMachineState = `machine ${machine.machineId} has no online runtime`;
    if (machine.runtime?.online) {
      return machine.machineId;
    }
    // Older authorities do not yet include the nested runtime field. Keep a
    // one-release compatibility fallback; current authorities stay one GET.
    if (!Object.hasOwn(machine, "runtime")) {
      const legacy = await requestJson<RuntimesPayload>(input.baseUrl, "/api/runtimes", authToken, deadline).catch(() => null);
      if (legacy?.runtimes?.some((runtime) => runtime.machineId === machine.machineId && runtime.online)) {
        return machine.machineId;
      }
    }
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
    await pauseUntil(deadline);
  }
  throw new Error(`Timed out waiting for the default local CodexHub runtime (${lastMachineState}).`);
};

const requestJson = async <T>(baseUrl: string, pathname: string, authToken: string, deadline: number, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${authToken}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(new URL(pathname, baseUrl), {
      ...init,
      headers,
      signal: AbortSignal.timeout(Math.max(1, Math.min(90_000, deadline - Date.now())))
    });
  } catch (error) {
    throw new Error(`Local CodexHub request failed for ${pathname}: ${errorText(error)}`);
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`Local CodexHub request failed for ${pathname} (HTTP ${response.status}): ${body}`);
  if (!body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Local CodexHub returned invalid JSON for ${pathname}.`);
  }
};

const readStartTimeout = (override: number | undefined) => {
  const configured = process.env.CODEX_HUB_LOCAL_SERVER_START_TIMEOUT_MS === undefined
    ? DEFAULT_START_TIMEOUT_MS
    : Number(process.env.CODEX_HUB_LOCAL_SERVER_START_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) throw new Error(`Invalid CODEX_HUB_LOCAL_SERVER_START_TIMEOUT_MS: ${process.env.CODEX_HUB_LOCAL_SERVER_START_TIMEOUT_MS}`);
  if (override === undefined) return configured;
  if (!Number.isFinite(override) || override <= 0) throw new Error("Local server startup timeout must be greater than 0.");
  return Math.min(override, configured);
};

const pauseUntil = async (deadline: number) => {
  const remaining = deadline - Date.now();
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(RUNTIME_POLL_INTERVAL_MS, remaining)));
};

const isOnlineLocalLauncher = (machine: MachineSummary) =>
  machine.type === "local" && machine.online && machine.capabilities?.projectLauncher !== false;

const isLoopbackHost = (host: string) =>
  host === "localhost"
  || (isIP(host) === 4 && host.startsWith("127."))
  || (isIP(host) === 6 && (host === "::1" || host === "0:0:0:0:0:0:0:1"));

const normalizeHost = (value: string) => value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
