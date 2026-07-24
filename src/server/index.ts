import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createMachineId, MachineHub } from "../core/machineHub.js";
import { loadConfig } from "../core/config.js";
import { loadDotEnv } from "../core/dotenv.js";
import { PluginHub } from "../core/pluginHub.js";
import { CodexPetStore } from "../core/petStore.js";
import { notificationHookRunnerFromEnv } from "../core/notificationHooks.js";
import { CodexhubServerState } from "../core/serverState.js";
import { listSshHosts } from "../core/sshConfig.js";
import { SshMachineManager } from "../core/sshMachine.js";
import { resolveSshRemoteClientBundle } from "../core/sshRemoteClient.js";
import { ThreadHub } from "../core/threadHub.js";
import { startCodexhubMachine, type CodexhubMachineHandle } from "../cli/codexhubMachine.js";
import { resolveCodexAppServerLaunchOptions, type CodexAppServerLaunchOptions } from "../cli/codexAppServerProcess.js";
import {
  parentRegistrationConnectSchema,
  type ConnectionsStreamEvent,
  type ParentRegistrationConnectInput,
  type ParentRegistrationStatus,
  type ProjectsPayload,
  type ProjectsStreamEvent
} from "../shared/apiContract.js";
import type { MachineRegistrationProject } from "../shared/machineTypes.js";
import type { ProjectSource } from "../shared/projectTypes.js";
import { readBooleanEnv, readNonNegativeNumberEnv } from "../shared/env.js";
import {
  isCodexHubSurface,
  isEmbeddedCodexHubSurface,
  type CodexHubSurface
} from "../shared/surfaceTypes.js";
import { registerStaticRoutes } from "./serverFiles.js";
import { registerProjectTaskRoutes } from "./projectTaskRoutes.js";
import { registerThreadRoutes } from "./threadRoutes.js";
import { registerMachineTransportRoutes } from "./machineTransportRoutes.js";
import { registerServerLifecycle } from "./serverLifecycle.js";
import { TunneledSessionManager } from "./tunneledSessionManager.js";
import { registerSystemRoutes } from "./systemRoutes.js";
import { registerPetRoutes } from "./petRoutes.js";
import { registerConnectionRoutes } from "./connectionRoutes.js";
import { TaskScheduler } from "./taskScheduler.js";
import {
  startTelegramPlugin,
  telegramBuiltinPlugin,
  telegramIntegrationType,
  telegramPluginState,
  type TelegramBotHandle
} from "../../plugins/telegram/index.js";

const localMachineEnabled = () => readBooleanEnv(process.env, "CODEX_HUB_LOCAL_MACHINE", true);

const staticRoot = (override?: string) => override
  ? path.resolve(override)
  : path.resolve(process.env.CODEX_HUB_STATIC_DIR ?? path.join(packageRoot(), "dist"));
const sessionOfflineTimeoutMs = () =>
  readNonNegativeNumberEnv(process.env, "CODEX_HUB_SESSION_OFFLINE_TIMEOUT_MS", 45_000);
const sessionOfflineRetentionMs = () =>
  readNonNegativeNumberEnv(process.env, "CODEX_HUB_SESSION_OFFLINE_RETENTION_MS", 30 * 60_000);
const sessionSweepIntervalMs = () =>
  readNonNegativeNumberEnv(process.env, "CODEX_HUB_SESSION_SWEEP_INTERVAL_MS", 5_000);
const taskScanIntervalMs = () => readNonNegativeNumberEnv(process.env, "CODEX_HUB_TASK_SCAN_INTERVAL_MS", 30_000);
const localApiBaseUrl = (host: string, port: number) => {
  const apiHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${apiHost}:${port}`;
};
const normalizedAuthToken = (value: string | null | undefined) => {
  const token = value?.trim();
  return token ? token : null;
};
const requestPath = (request: FastifyRequest) => new URL(request.url, "http://codexhub.local").pathname;
const isPublicRequest = (request: FastifyRequest) => {
  const pathname = requestPath(request);
  if (!pathname.startsWith("/api/")) return true;
  if (pathname === "/api/health" || pathname === "/api/auth/status") return true;
  if (pathname.startsWith("/api/remote-client/")) return request.method === "GET";
  if (pathname.startsWith("/api/ssh/remote-client/")) return request.method === "GET";
  if (pathname.startsWith("/api/plugins/") && pathname.includes("/assets/")) return request.method === "GET";
  return false;
};
const isAuthorizedRequest = (request: FastifyRequest, expectedToken: string) => {
  const token = requestAuthToken(request);
  return token ? safeTokenEqual(token, expectedToken) : false;
};
const requestAuthToken = (request: FastifyRequest) => {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  if (!allowsQueryAuthToken(request)) return "";
  const url = new URL(request.url, "http://codexhub.local");
  return url.searchParams.get("codexhub_token")?.trim()
    || "";
};
const allowsQueryAuthToken = (request: FastifyRequest) => {
  if (request.method !== "GET") return false;
  const pathname = requestPath(request);
  return ["/api/events/ws", "/api/machines/connect", "/api/file"].includes(pathname)
    || /^\/api\/pets\/[^/]+\/spritesheet$/.test(pathname);
};
const safeTokenEqual = (actual: string, expected: string) => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};
const packageRoot = () => findPackageRoot(moduleFilePath() ? path.dirname(moduleFilePath()) : process.cwd());
const findPackageRoot = (start: string) => {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
};
const moduleFilePath = () => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
};
const parseSurface = (value: string | undefined): CodexHubSurface =>
  isCodexHubSurface(value) ? value : "default";
const resolveServerFeatures = (overrides: Partial<ServerFeatureOptions> = {}): ServerFeatureOptions => ({
  localMachine: overrides.localMachine ?? localMachineEnabled(),
  ssh: overrides.ssh ?? true,
  tasks: overrides.tasks ?? true,
  integrations: overrides.integrations ?? true
});

export type ServerStartOptions = {
  host?: string;
  port?: number;
  dataDir?: string;
  staticDirectory?: string;
  surface?: CodexHubSurface;
  authToken?: string | null;
  buildId?: string | null;
  appServerLaunch?: CodexAppServerLaunchOptions;
  parentRegistration?: Partial<ParentRegistrationConnectInput>;
  parentRegistrationIdentity?: ParentRegistrationIdentity;
  features?: Partial<ServerFeatureOptions>;
};

export type ParentRegistrationIdentity = {
  machineId: string;
  name?: string;
};

export type ServerHandle = {
  app: FastifyInstance;
  host: string;
  port: number;
  serverInstanceId: string;
  stop: () => Promise<void>;
};

export type ServerFeatureOptions = {
  localMachine: boolean;
  ssh: boolean;
  tasks: boolean;
  integrations: boolean;
};

export const startServer = async (options: ServerStartOptions = {}): Promise<ServerHandle> => {
  const state = await CodexhubServerState.load({ dataDir: options.dataDir });
  state.applyEnvToProcess();
  const modelCatalogCacheFilePath = path.join(path.dirname(state.path), "model-catalog-cache.json");
  const config = loadConfig({ host: options.host, port: options.port });
  const appServerLaunch = resolveCodexAppServerLaunchOptions(options.appServerLaunch);
  const surface = options.surface ?? parseSurface(process.env.CODEX_HUB_SURFACE);
  const features = resolveServerFeatures(options.features);
  const serverAuthToken = normalizedAuthToken(options.authToken ?? process.env.CODEX_HUB_AUTH_TOKEN);
  const buildId = options.buildId ?? process.env.CODEX_HUB_BUILD_ID ?? null;
  const serverInstanceId = randomUUID();
  const parentRegistrationIdentity = normalizeParentRegistrationIdentity(options.parentRegistrationIdentity);
  const startupParentRegistration = resolveStartupParentRegistration(
    options.parentRegistration,
    state.parentRegistration(),
    parentRegistrationIdentity
  );
  const notificationHooks = notificationHookRunnerFromEnv(process.env);
  const embeddedSurface = isEmbeddedCodexHubSurface(surface);
  const shouldPersistMachine = (machine: { type?: string }) =>
    machine.type !== "registered" && !(embeddedSurface && machine.type === "local");
  let threads: ThreadHub;
  const captureSessionState = () => {
    state.captureSessions({
      sessions: threads.listSessions({ includeOffline: true }),
      threads: threads.listThreads()
    }, {
      persistMachines: !embeddedSurface
    });
  };
  threads = new ThreadHub(config.defaultThreadOptions, {
    onCatalogChange: () => publishProjects(),
    onThreadEvent: (event, records) => notificationHooks?.handleThreadEvent(event, records),
    onThreadChange: () => {
      captureSessionState();
    }
  });
  const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });
  const projectSubscribers = new Set<(event: ReturnType<typeof projectSnapshotEvent>) => void>();
  const connectionSubscribers = new Set<(event: ReturnType<typeof connectionSnapshotEvent>) => void>();
  let projectSeq = 0;
  let connectionSeq = 0;
  const machines = new MachineHub({ onChange: () => publishProjects() });
  const taskScheduler = new TaskScheduler({
    enabled: features.tasks,
    state,
    machines,
    threads,
    waitForSession: (sessionId) => waitForSession(sessionId)
  });
  const sshRemoteClient = features.ssh ? await resolveSshRemoteClientBundle() : null;
  const sshMachines = new SshMachineManager({
    localHost: config.host,
    localPort: config.port,
    sshConfigPath: process.env.CODEX_HUB_SSH_CONFIG,
    remoteClient: sshRemoteClient ?? undefined,
    appServerLaunch,
    authToken: serverAuthToken,
    onChange: () => {
      publishConnections();
      publishProjects();
    }
  });
  const plugins = new PluginHub({ builtins: [telegramBuiltinPlugin()] });
  const pets = new CodexPetStore();
  const contextWindowTokens = Number(process.env.CODEX_CONTEXT_WINDOW_TOKENS || 0) || null;
  const staticDirectory = staticRoot(options.staticDirectory);
  let telegramBot: TelegramBotHandle | null = null;
  let localMachine: CodexhubMachineHandle | null = null;
  let parentRegistration: CodexhubMachineHandle | null = null;
  let parentRegistrationStatus: ParentRegistrationStatus = { status: "idle" };
  const threadRecordSubscriptionCounts = new Map<string, number>();
  const threadRecordSubscriptionTimers = new Map<string, NodeJS.Timeout>();
  const tunneledSessions = new TunneledSessionManager({
    apiBase: localApiBaseUrl(config.host, config.port),
    modelCatalogCacheFilePath,
    threads,
    captureSessionState,
    publishProjects,
    refreshRetainedThreadRecordSubscriptions: () => refreshRetainedThreadRecordSubscriptions()
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      reply.code(400).send({
        error: "invalid_request",
        issues: error.issues
      });
      return;
    }
    reply.send(error);
  });

  const sessionSweep = setInterval(() => {
    threads.markStaleSessionsOffline(sessionOfflineTimeoutMs(), Date.now(), sessionOfflineRetentionMs());
  }, sessionSweepIntervalMs());
  sessionSweep.unref?.();
  const taskSweep = taskScheduler.start(taskScanIntervalMs());

  registerServerLifecycle(app, {
    intervals: [sessionSweep, taskSweep],
    subscriptionTimers: threadRecordSubscriptionTimers,
    stopTunneledSessions: () => tunneledSessions.stopAll(),
    stopSshMachines: () => sshMachines.stopAll(),
    stopParentRegistration: () => stopParentRegistration({ forget: false }).then(() => undefined),
    stopLocalMachine: async () => {
      await localMachine?.stop();
      localMachine = null;
    },
    stopIntegrations: () => {
      telegramBot?.stop("server closing");
      telegramBot = null;
      plugins.setIntegrationState(telegramIntegrationType, telegramPluginState(false));
    },
    flushState: () => state.flush()
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fieldSize: 32 * 1024, fields: 1, fileSize: 20 * 1024 * 1024, files: 1, parts: 2 },
  });
  await app.register(websocket);
  app.addHook("onRequest", async (request, reply) => {
    if (!serverAuthToken || isPublicRequest(request)) return;
    if (isAuthorizedRequest(request, serverAuthToken)) return;
    reply
      .code(401)
      .header("www-authenticate", "Bearer realm=\"codexhub\"")
      .send({ error: "unauthorized", authRequired: true });
  });

  function projectSnapshot(): ProjectsPayload {
    return state.snapshot({
      machines: machines.listMachines(),
      sessions: threads.listSessions({ includeOffline: true }),
      threads: threads.listThreads()
    }) satisfies ProjectsPayload;
  }

  function projectSnapshotEvent(): ProjectsStreamEvent {
    return {
      seq: projectSeq,
      kind: "projects" as const,
      ...projectSnapshot()
    } satisfies ProjectsStreamEvent;
  }

  function embeddedParentRegistrationProjects(): MachineRegistrationProject[] {
    if (!embeddedSurface || !localMachine) return [];
    return projectSnapshot().projects
      .filter((project) => project.machineId === localMachine?.machineId && project.source?.kind === surface)
      .map((project) => ({
        path: project.path,
        source: project.source
      }));
  }

  function replaceMachineRegistrationProjects(machineId: string, projects: MachineRegistrationProject[] | undefined) {
    state.deleteTransientProjectsForMachine(machineId);
    for (const project of projects ?? []) {
      state.upsertTransientProject({
        machineId,
        path: project.path,
        source: project.source ? registeredProjectSource(machineId, project.source) : undefined
      });
    }
  }

  function clearMachineRegistrationProjects(machineId: string) {
    state.deleteTransientProjectsForMachine(machineId);
  }

  function registeredProjectSource(machineId: string, source: ProjectSource): ProjectSource {
    return {
      ...source,
      groupId: `registered:${machineId}:${source.groupId}`
    };
  }

  function projectIsFixed(projectId: string) {
    const project = projectSnapshot().projects.find((item) => item.projectId === projectId);
    return project?.machine?.capabilities?.projectCatalog === "fixed";
  }

  function fixedProjectPathExists(machineId: string, projectPath: string) {
    return projectSnapshot().projects.some((project) => project.machineId === machineId && project.path === projectPath);
  }

  function isEmbeddedWorkspaceSource(source: ProjectSource | undefined) {
    return embeddedSurface && source?.kind === surface;
  }

  function publishProjects() {
    captureSessionState();
    const event = {
      seq: ++projectSeq,
      kind: "projects" as const,
      ...projectSnapshot()
    } satisfies ProjectsStreamEvent;
    for (const subscriber of projectSubscribers) subscriber(event);
  }

  const cancelThreadRecordSubscriptionIdle = (threadId: string) => {
    const timer = threadRecordSubscriptionTimers.get(threadId);
    if (!timer) return false;
    clearTimeout(timer);
    threadRecordSubscriptionTimers.delete(threadId);
    return true;
  };

  const retainThreadRecordSubscription = (threadId: string) => {
    const current = threadRecordSubscriptionCounts.get(threadId) ?? 0;
    const hadIdleTimer = cancelThreadRecordSubscriptionIdle(threadId);
    threadRecordSubscriptionCounts.set(threadId, current + 1);
    if (current > 0 || hadIdleTimer) return;
    try {
      // 第一个 Web 订阅者触发对应 session 开始镜像 app-server records。
      threads.subscribeThreadRecords(threadId);
    } catch {
      // 当 session 离线时，thread 订阅仍可返回内存里的快照。
    }
  };

  const releaseThreadRecordSubscription = (threadId: string) => {
    const current = threadRecordSubscriptionCounts.get(threadId) ?? 0;
    if (current <= 0) return;
    if (current > 1) {
      threadRecordSubscriptionCounts.set(threadId, current - 1);
      return;
    }
    threadRecordSubscriptionCounts.delete(threadId);
    scheduleThreadRecordSubscriptionIdle(threadId);
  };

  const forceReleaseThreadRecordSubscription = (threadId: string) => {
    threadRecordSubscriptionCounts.delete(threadId);
    cancelThreadRecordSubscriptionIdle(threadId);
    try {
      threads.unsubscribeThreadRecords(threadId);
    } catch {
      // 删除 thread 不应被过期或离线 session 阻塞。
    }
  };

  const refreshRetainedThreadRecordSubscriptions = () => {
    for (const threadId of threadRecordSubscriptionCounts.keys()) {
      try {
        threads.subscribeThreadRecords(threadId);
      } catch {
        // 订阅刷新是尽力而为；Web 订阅仍能收到已存储的 thread events。
      }
    }
  };

  function scheduleThreadRecordSubscriptionIdle(threadId: string) {
    if (threadRecordSubscriptionTimers.has(threadId)) return;
    const idleMs = threadRecordSubscriptionIdleMs();
    if (idleMs <= 0) return;
    const timer = setTimeout(() => {
      threadRecordSubscriptionTimers.delete(threadId);
      if ((threadRecordSubscriptionCounts.get(threadId) ?? 0) > 0) return;
      const thread = threads.getThread(threadId);
      if (!thread) return;
      try {
        // 只释放 records 镜像订阅，runtime session 本身保持在线。
        threads.unsubscribeThreadRecords(threadId);
      } catch {
        // 当 thread tab idle 期间，session 可能已经离线。
      }
    }, idleMs);
    timer.unref?.();
    threadRecordSubscriptionTimers.set(threadId, timer);
  }


  function connectionSnapshotEvent(): ConnectionsStreamEvent {
    return {
      seq: connectionSeq,
      kind: "connections" as const,
      connections: features.ssh ? sshMachines.listConnections() : [],
      registration: parentRegistrationView()
    } satisfies ConnectionsStreamEvent;
  }

  function publishConnections() {
    const event = {
      seq: ++connectionSeq,
      kind: "connections" as const,
      connections: sshMachines.listConnections(),
      registration: parentRegistrationView()
    } satisfies ConnectionsStreamEvent;
    for (const subscriber of connectionSubscribers) subscriber(event);
  }

  function parentRegistrationView(): ParentRegistrationStatus {
    return { ...parentRegistrationStatus } satisfies ParentRegistrationStatus;
  }

  async function startParentRegistration(
    input: z.infer<typeof parentRegistrationConnectSchema>,
    options: { persist?: boolean } = {}
  ) {
    const url = normalizeBaseUrl(input.url);
    await assertNotSelfRegistrationTarget(input.url, {
      host: config.host,
      port: config.port,
      serverInstanceId
    });
    await stopParentRegistration({ forget: false });
    const storedRegistration = state.parentRegistration();
    const hasExplicitAuthToken = Object.hasOwn(input, "authToken");
    const inputAuthToken = hasExplicitAuthToken
      ? normalizedOptionalValue(input.authToken)
      : authTokenFromUrl(input.url)
        || (storedRegistration?.url === url ? storedRegistration.authToken : undefined);
    const authToken = hasExplicitAuthToken
      ? inputAuthToken
      : inputAuthToken || normalizedOptionalValue(process.env.CODEX_HUB_REGISTER_AUTH_TOKEN);
    const machineId = parentRegistrationIdentity?.machineId
      || input.machineId?.trim()
      || process.env.CODEX_HUB_REGISTER_MACHINE_ID
      || createMachineId(`${os.hostname()}-server-${config.port}`);
    const name = parentRegistrationIdentity?.name
      || input.name?.trim()
      || process.env.CODEX_HUB_REGISTER_NAME
      || `CodexHub Server ${localApiBaseUrl(config.host, config.port)}`;
    if (options.persist !== false) {
      state.setParentRegistration({
        url,
        ...(inputAuthToken ? { authToken: inputAuthToken } : {}),
        ...(parentRegistrationIdentity ? {} : { machineId, name })
      });
    }
    parentRegistrationStatus = {
      status: "starting",
      url,
      machineId,
      name,
      message: "starting parent registration",
      updatedAt: new Date().toISOString()
    };
    parentRegistration = startCodexhubMachine({
      apiBase: url,
      authToken,
      machineId,
      type: "registered",
      name,
      appServerLaunch,
      capabilities: embeddedSurface ? { projectCatalog: "fixed" } : undefined,
      projects: embeddedParentRegistrationProjects,
      onStatus: (status) => {
        parentRegistrationStatus = {
          status: status.status,
          url,
          machineId: status.machineId,
          name,
          message: status.message,
          updatedAt: status.updatedAt
        };
        publishConnections();
      }
    });
    return parentRegistrationView();
  }

  async function stopParentRegistration(options: { forget?: boolean } = {}) {
    const current = parentRegistration;
    parentRegistration = null;
    if (current) await current.stop();
    if (options.forget) state.clearParentRegistration();
    parentRegistrationStatus = {
      status: "idle",
      updatedAt: new Date().toISOString()
    };
    return parentRegistrationView();
  }

  const disconnectParentRegistration = () => stopParentRegistration({ forget: true });

  async function localSshConfigHostsByAlias() {
    if (!features.ssh) return new Map();
    return new Map((await listSshHosts()).map((host) => [host.alias, host]));
  }

  async function listCodexhubSshHosts() {
    if (!features.ssh) return [];
    const configHostsByAlias = await localSshConfigHostsByAlias();
    return state.listSshHosts().map((storedHost) => {
      const configHost = configHostsByAlias.get(storedHost.alias);
      return {
        alias: storedHost.alias,
        hostName: configHost?.hostName,
        user: configHost?.user,
        port: configHost?.port,
        identityFiles: configHost?.identityFiles ?? [],
        proxyJump: configHost?.proxyJump,
        configured: Boolean(configHost),
        createdAt: storedHost.createdAt,
        updatedAt: storedHost.updatedAt
      };
    });
  }

  async function autoConnectSavedSshHosts(reason: string) {
    if (!features.ssh) return;
    if (!sshAutoConnectEnabled()) return;
    const hosts = await listCodexhubSshHosts();
    for (const host of hosts) {
      await autoConnectSavedSshHost(host.alias, reason);
    }
  }

  async function autoConnectSavedSshHost(alias: string, reason: string) {
    if (!features.ssh) return;
    if (!sshAutoConnectEnabled()) return;
    if (sshMachines.listConnections().some((connection) => connection.host === alias && connection.status !== "exited")) return;
    const configHostsByAlias = await localSshConfigHostsByAlias();
    if (!configHostsByAlias.has(alias)) {
      app.log.warn({ host: alias, reason }, "codexhub saved SSH host is missing from ssh config");
      return;
    }
    try {
      sshMachines.connect({ host: alias, name: alias });
      app.log.info({ host: alias, reason }, "codexhub SSH autoconnect started");
    } catch (error) {
      app.log.warn({ err: error, host: alias, reason }, "codexhub SSH autoconnect failed");
    }
  }

  async function stopSshConnectionsForHost(alias: string) {
    const connections = sshMachines.listConnections().filter((connection) => connection.host === alias && connection.status !== "exited");
    await Promise.allSettled(connections.map((connection) => sshMachines.stop(connection.connectionId)));
  }

  async function waitForSession(sessionId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const session = threads.listSessions({ includeOffline: true }).find((item) => item.sessionId === sessionId);
      if (session?.online) return session;
      await delay(50);
    }
    throw new Error(`Session did not register: ${sessionId}`);
  }


  async function startBuiltinIntegrations() {
    if (!features.integrations) {
      plugins.setIntegrationState(telegramIntegrationType, telegramPluginState(false));
      return;
    }
    plugins.setIntegrationState(telegramIntegrationType, telegramPluginState(false));
    if (await plugins.hasEnabledBuiltinIntegration(telegramIntegrationType)) {
      telegramBot = await startTelegramPlugin({
        apiBaseUrl: localApiBaseUrl(config.host, config.port),
        apiAuthToken: serverAuthToken,
        requireToken: false
      });
      plugins.setIntegrationState(telegramIntegrationType, telegramPluginState(Boolean(telegramBot)));
    }
  }

  registerSystemRoutes(app, {
    authRequired: Boolean(serverAuthToken),
    isAuthorized: (request) => Boolean(serverAuthToken && isAuthorizedRequest(request, serverAuthToken)),
    healthPayload: () => ({
      ok: true,
      serverInstanceId,
      env: process.env.CODEX_HUB_ENV ?? process.env.NODE_ENV ?? "development",
      build: buildId,
      host: config.host,
      port: config.port,
      surface,
      features,
      staticDirectory,
      configPath: state.path,
      model: config.defaultThreadOptions.model ?? null,
      modelReasoningEffort: config.defaultThreadOptions.modelReasoningEffort ?? null,
      serviceTier: config.defaultThreadOptions.serviceTier ?? null,
      contextWindowTokens,
      ssh: { connections: sshMachines.listConnections() },
      telegram: { started: Boolean(telegramBot) }
    }),
    configPayload: () => ({ config: state.config() }),
    updateUiConfig: (ui) => state.updateUiConfig(ui)
  });

  registerPetRoutes(app, pets);

  registerThreadRoutes(app, {
    connectionSnapshotEvent,
    connectionSubscribers,
    forceReleaseThreadRecordSubscription,
    markStaleSessions: () => threads.markStaleSessionsOffline(sessionOfflineTimeoutMs(), Date.now(), sessionOfflineRetentionMs()),
    machines,
    projectSnapshotEvent,
    projectSubscribers,
    publishProjects,
    releaseThreadRecordSubscription,
    retainThreadRecordSubscription,
    taskSnapshotEvent: () => taskScheduler.snapshotEvent(),
    taskSubscribers: taskScheduler.subscribers,
    threads,
    waitForSession
  });

  registerConnectionRoutes(app, {
    sshEnabled: features.ssh,
    machines,
    plugins,
    sshMachines,
    state,
    listCodexhubSshHosts,
    hasSshConfigHost: async (alias) => (await localSshConfigHostsByAlias()).has(alias),
    autoConnectSavedSshHost,
    stopSshConnectionsForHost,
    parentRegistrationView,
    startParentRegistration,
    stopParentRegistration: disconnectParentRegistration,
    buildRegisteredBootstrap: (request, bundle, input) => {
      const serverBase = normalizeBaseUrl(input.server ?? requestBaseUrl(request, config.host, config.port));
      return registeredBootstrapScript({
        serverBase,
        clientUrl: `${serverBase}/api/remote-client/${bundle.hash}`,
        clientHash: bundle.hash,
        authToken: normalizedAuthToken(requestAuthToken(request)),
        appServerLaunch,
        name: input.name
      });
    }
  });

  registerProjectTaskRoutes(app, {
    features,
    fixedProjectPathExists,
    isEmbeddedWorkspaceSource,
    localTaskView: (task) => taskScheduler.view(task),
    localTaskViews: () => taskScheduler.views(),
    machines,
    projectIsFixed,
    projectSnapshot,
    publishProjects,
    refreshParentRegistration: () => parentRegistration?.refreshRegistration(),
    publishTasks: () => taskScheduler.publish(),
    resolveTargetMachine,
    runLocalTask: (taskId) => taskScheduler.run(taskId),
    state,
    surface,
    threads,
    waitForSession
  });

  registerMachineTransportRoutes(app, {
    attachTunneledAppServer: (input) => tunneledSessions.attach(input),
    clearMachineRegistrationProjects,
    machines,
    publishProjects,
    refreshRetainedThreadRecordSubscriptions,
    replaceMachineRegistrationProjects,
    shouldPersistMachine,
    startTunneledAppServerThread: (input) => tunneledSessions.startThread(input),
    state,
    stopTunneledAppServerSession: (sessionId, transportId) => tunneledSessions.stop(sessionId, transportId),
    stopTunneledAppServerSessionsForTransport: (transportId) => tunneledSessions.stopForTransport(transportId),
    threads
  });

  if (staticDirectory) registerStaticRoutes(app, staticDirectory);

  await app.listen({ host: config.host, port: config.port });

  if (features.localMachine) {
    localMachine = startCodexhubMachine({
      apiBase: localApiBaseUrl(config.host, config.port),
      authToken: serverAuthToken ?? undefined,
      machineId: process.env.CODEX_HUB_LOCAL_MACHINE_ID,
      type: "local",
      name: process.env.CODEX_HUB_LOCAL_MACHINE_NAME || "local",
      appServerLaunch,
      modelCatalogCacheFilePath,
      capabilities: embeddedSurface ? { projectCatalog: "fixed" } : undefined
    });
  }

  if (startupParentRegistration) {
    try {
      await startParentRegistration(startupParentRegistration, { persist: false });
    } catch (error) {
      const url = safeNormalizeBaseUrl(startupParentRegistration.url);
      parentRegistrationStatus = {
        status: "offline",
        ...(url ? { url } : {}),
        machineId: startupParentRegistration.machineId,
        name: startupParentRegistration.name,
        message: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      };
      console.error(`codexhub parent registration startup failed: ${parentRegistrationStatus.message}`);
      publishConnections();
    }
  }

  if (features.ssh) await autoConnectSavedSshHosts("startup");

  try {
    await startBuiltinIntegrations();
  } catch (error) {
    await app.close();
    throw error;
  }

  return {
    app,
    host: config.host,
    port: config.port,
    serverInstanceId,
    stop: () => app.close()
  };
};

const registeredBootstrapScript = (input: {
  serverBase: string;
  clientUrl: string;
  clientHash: string;
  authToken: string | null;
  appServerLaunch?: CodexAppServerLaunchOptions;
  name?: string;
}) => [
  "#!/bin/sh",
  "set -eu",
  "PATH=\"/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/bin:/usr/bin:/bin:$PATH\"",
  "export PATH",
  `CODEXHUB_REMOTE_CLIENT_HASH=${shellQuote(input.clientHash)}`,
  `CODEXHUB_REMOTE_CLIENT_URL=${shellQuote(input.clientUrl)}`,
  ...(input.authToken ? [`CODEX_HUB_AUTH_TOKEN=${shellQuote(input.authToken)}`] : []),
  ...registeredAppServerLaunchEnvAssignments(input.appServerLaunch),
  `export ${[
    "CODEXHUB_REMOTE_CLIENT_HASH",
    "CODEXHUB_REMOTE_CLIENT_URL",
    ...(input.authToken ? ["CODEX_HUB_AUTH_TOKEN"] : []),
    ...registeredAppServerLaunchEnvNames(input.appServerLaunch)
  ].join(" ")}`,
  "cache_root=\"${XDG_CACHE_HOME:-$HOME/.cache}/codexhub/remote-client\"",
  "cache_dir=\"$cache_root/$CODEXHUB_REMOTE_CLIENT_HASH\"",
  "client=\"$cache_dir/client.cjs\"",
  "mkdir -p \"$cache_dir\"",
  "chmod 700 \"$cache_root\" \"$cache_dir\" 2>/dev/null || true",
  "if [ ! -s \"$client\" ]; then",
  "  tmp=\"$client.tmp.$$\"",
  "  rm -f \"$tmp\"",
  "  CODEXHUB_REMOTE_CLIENT_TMP=\"$tmp\" node - <<'CODEXHUB_REMOTE_CLIENT_BOOTSTRAP'",
  remoteClientBootstrapNodeScript,
  "CODEXHUB_REMOTE_CLIENT_BOOTSTRAP",
  "  chmod 600 \"$tmp\"",
  "  mv \"$tmp\" \"$client\"",
  "fi",
  [
    "exec",
    "node",
    "\"$client\"",
    "--server",
    shellQuote(input.serverBase),
    "--type",
    "registered",
    ...(input.name ? ["--name", shellQuote(input.name)] : [])
  ].join(" "),
  ""
].join("\n");

const registeredAppServerLaunchEnvAssignments = (options: CodexAppServerLaunchOptions | undefined) => [
  ...(options?.approvalPolicy ? [`CODEX_HUB_APP_SERVER_APPROVAL_POLICY=${shellQuote(options.approvalPolicy)}`] : []),
  ...(options?.approvalsReviewer
    ? [`CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER=${shellQuote(options.approvalsReviewer)}`]
    : []),
  ...(options?.sandbox ? [`CODEX_HUB_APP_SERVER_SANDBOX=${shellQuote(options.sandbox)}`] : [])
];

const registeredAppServerLaunchEnvNames = (options: CodexAppServerLaunchOptions | undefined) => [
  ...(options?.approvalPolicy ? ["CODEX_HUB_APP_SERVER_APPROVAL_POLICY"] : []),
  ...(options?.approvalsReviewer ? ["CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER"] : []),
  ...(options?.sandbox ? ["CODEX_HUB_APP_SERVER_SANDBOX"] : [])
];

const remoteClientBootstrapNodeScript = [
  "const fs = require('node:fs');",
  "const { createHash } = require('node:crypto');",
  "const http = require('node:http');",
  "const https = require('node:https');",
  "const url = process.env.CODEXHUB_REMOTE_CLIENT_URL;",
  "const tmp = process.env.CODEXHUB_REMOTE_CLIENT_TMP;",
  "const expectedHash = process.env.CODEXHUB_REMOTE_CLIENT_HASH;",
  "if (!url || !tmp || !expectedHash) throw new Error('missing codexhub remote client bootstrap env');",
  "const transport = url.startsWith('https:') ? https : http;",
  "const fail = (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); };",
  "new Promise((resolve, reject) => {",
  "  const file = fs.createWriteStream(tmp, { mode: 0o600 });",
  "  const hash = createHash('sha256');",
  "  const request = transport.get(url, (response) => {",
  "    if (response.statusCode !== 200) {",
  "      response.resume();",
  "      reject(new Error(`remote client download failed: ${response.statusCode}`));",
  "      return;",
  "    }",
  "    response.on('data', (chunk) => hash.update(chunk));",
  "    response.on('error', reject);",
  "    response.pipe(file);",
  "  });",
  "  request.on('error', reject);",
  "  file.on('error', reject);",
  "  file.on('finish', () => {",
  "    file.close((error) => {",
  "      if (error) { reject(error); return; }",
  "      const actualHash = hash.digest('hex');",
  "      if (actualHash !== expectedHash) {",
  "        reject(new Error(`remote client checksum mismatch: ${actualHash}`));",
  "        return;",
  "      }",
  "      resolve();",
  "    });",
  "  });",
  "}).catch(fail);"
].join("\n");

const requestBaseUrl = (request: FastifyRequest, host: string, port: number) => {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" && forwardedProto.trim()
    ? forwardedProto.split(",")[0].trim()
    : "http";
  return `${proto}://${request.headers.host || `${host}:${port}`}`;
};

const normalizeBaseUrl = (value: string) => {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const safeNormalizeBaseUrl = (value: string) => {
  try {
    return normalizeBaseUrl(value);
  } catch {
    return undefined;
  }
};

const resolveStartupParentRegistration = (
  override: Partial<ParentRegistrationConnectInput> | undefined,
  stored: ReturnType<CodexhubServerState["parentRegistration"]>,
  identity?: ParentRegistrationIdentity
): ParentRegistrationConnectInput | undefined => {
  const overrideUrl = override?.url?.trim();
  const envUrl = process.env.CODEX_HUB_REGISTER_TO?.trim();
  const useStored = !overrideUrl && !envUrl;
  const url = overrideUrl || envUrl || stored?.url;
  if (!url) return undefined;
  const overrideAuthToken = override?.authToken;
  const authToken = overrideAuthToken !== undefined
    ? overrideAuthToken.trim()
    : normalizedOptionalValue(process.env.CODEX_HUB_REGISTER_AUTH_TOKEN)
      || (useStored ? stored?.authToken : undefined);
  return {
    url,
    ...(overrideAuthToken !== undefined || authToken ? { authToken: authToken ?? "" } : {}),
    machineId: identity?.machineId
      || override?.machineId?.trim()
      || process.env.CODEX_HUB_REGISTER_MACHINE_ID?.trim()
      || (useStored ? stored?.machineId : undefined),
    name: identity?.name
      || override?.name?.trim()
      || process.env.CODEX_HUB_REGISTER_NAME?.trim()
      || (useStored ? stored?.name : undefined)
  };
};

const normalizeParentRegistrationIdentity = (
  value: ParentRegistrationIdentity | undefined
): ParentRegistrationIdentity | undefined => {
  if (!value) return undefined;
  const machineId = value.machineId.trim();
  if (!machineId) throw new Error("Parent registration identity machineId is required.");
  const name = value.name?.trim();
  return {
    machineId,
    ...(name ? { name } : {})
  };
};

const normalizedOptionalValue = (value: string | undefined) => {
  const normalized = value?.trim();
  return normalized || undefined;
};

const authTokenFromUrl = (value: string) => {
  const url = new URL(value);
  return url.searchParams.get("codexhub_token")?.trim()
    || undefined;
};

const assertNotSelfRegistrationTarget = async (
  value: string,
  current: { host: string; port: number; serverInstanceId: string }
) => {
  if (isSameLocalEndpoint(value, current.host, current.port)) {
    throw selfRegistrationError();
  }
  const targetInstanceId = await fetchServerInstanceId(value);
  if (targetInstanceId && targetInstanceId === current.serverInstanceId) {
    throw selfRegistrationError();
  }
};

const fetchServerInstanceId = async (value: string) => {
  try {
    const response = await fetch(new URL("/api/health", value), { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return undefined;
    const data = await response.json() as { serverInstanceId?: unknown };
    return typeof data.serverInstanceId === "string" ? data.serverInstanceId : undefined;
  } catch {
    return undefined;
  }
};

const isSameLocalEndpoint = (value: string, host: string, port: number) => {
  const url = new URL(value);
  if (urlPort(url) !== port) return false;
  const targetHost = normalizedUrlHost(url.hostname);
  const localHost = normalizedUrlHost(host);
  if (isWildcardHost(targetHost)) return true;
  if (targetHost === localHost) return true;
  return isLoopbackHost(targetHost) && (isLoopbackHost(localHost) || isWildcardHost(localHost));
};

const urlPort = (url: URL) => url.port
  ? Number(url.port)
  : url.protocol === "https:" ? 443 : 80;

const normalizedUrlHost = (value: string) => value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

const isLoopbackHost = (host: string) =>
  host === "localhost"
  || host === "::1"
  || host === "0:0:0:0:0:0:0:1"
  || host.startsWith("127.");

const isWildcardHost = (host: string) => host === "0.0.0.0" || host === "::";

const selfRegistrationError = () => Object.assign(
  new Error("Cannot register this CodexHub server to itself."),
  { statusCode: 400 }
);

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const resolveTargetMachine = <T extends {
  machineId: string;
  type?: "local" | "ssh" | "registered";
  online: boolean;
  capabilities?: { projectLauncher?: boolean; projectCatalog?: "editable" | "fixed" };
}>(
  allMachines: T[],
  requestedMachineId: string | undefined
): T => {
  const onlineMachines = allMachines.filter((machine) => machine.online && machine.capabilities?.projectLauncher !== false);
  if (requestedMachineId) {
    const machine = onlineMachines.find((item) => item.machineId === requestedMachineId);
    if (!machine) throw new Error(`Project launcher is offline or not found: ${requestedMachineId}`);
    return machine;
  }
  if (onlineMachines.length === 1) return onlineMachines[0];
  if (onlineMachines.length === 0) throw new Error("No online codexhub project launcher.");
  throw new Error("Multiple online project launchers. Choose one before opening a project.");
};

const delay = async (ms: number) => await new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const sshAutoConnectEnabled = () => process.env.CODEX_HUB_SSH_AUTOCONNECT !== "0";

const threadRecordSubscriptionIdleMs = () => {
  const value = Number(process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS);
  return Number.isFinite(value) && value >= 0 ? value : 120_000;
};

const isDirectEntryPoint = () => {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && path.resolve(entrypoint) === moduleFilePath());
};

if (isDirectEntryPoint()) {
  void (async () => {
    await loadDotEnv();
    await startServer();
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
