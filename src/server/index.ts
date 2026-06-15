import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createMachineId, MachineHub } from "../core/machineHub.js";
import { AppServerTunnelPeer, isAppServerTunnelFrame } from "../core/appServerTunnel.js";
import { loadConfig } from "../core/config.js";
import { loadDotEnv } from "../core/dotenv.js";
import { PluginHub } from "../core/pluginHub.js";
import { CodexhubServerState } from "../core/serverState.js";
import { listSshHosts } from "../core/sshConfig.js";
import { SshMachineManager } from "../core/sshMachine.js";
import { readSshRemoteClientBundle, resolveSshRemoteClientBundle } from "../core/sshRemoteClient.js";
import { cronMatches, cronMinuteKey, cronMinuteKeyFromIso, defaultTaskTimezone, nextCronRun } from "../core/taskCron.js";
import { ThreadHub } from "../core/threadHub.js";
import { startCodexhubMachine, type CodexhubMachineHandle, type CodexhubMachineStatus } from "../cli/codexhubMachine.js";
import { startAttachedCodexhubSession, type HeadlessCodexhubSessionHandle, type HeadlessSessionTransport, type HeadlessSessionTransportCallbacks } from "../cli/codexhubConnect.js";
import {
  machineTransportMessageSchema,
  parentRegistrationConnectSchema,
  sshConnectSchema,
  sshHostAliasSchema,
  type AuthStatusPayload,
  type ConnectionsStreamEvent,
  type HealthPayload,
  type MachinesPayload,
  type ParentRegistrationPayload,
  type ParentRegistrationStatus,
  type PluginsPayload,
  type ProjectsPayload,
  type ProjectsStreamEvent,
  type SessionsPayload,
  type SshConnectionPayload,
  type SshConnectionsPayload,
  type SshHostsPayload,
  type TaskMutationPayload,
  type TasksStreamEvent,
  type TaskView
} from "../shared/apiContract.js";
import type { MachineDirectoryListing } from "../shared/machineTypes.js";
import type { MachineRegistrationProject } from "../shared/machineTypes.js";
import type { ProjectSource, StoredTask } from "../shared/projectTypes.js";
import type { SessionCommand, SessionEventInput, SessionRegistration } from "../shared/threadTypes.js";
import { registerProjectTaskRoutes } from "./projectTaskRoutes.js";
import { registerThreadRoutes } from "./threadRoutes.js";
import {
  startTelegramPlugin,
  telegramBuiltinPlugin,
  telegramIntegrationType,
  telegramPluginState,
  type TelegramBotHandle
} from "../../plugins/telegram/index.js";

const envMs = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const envFlag = (name: string, fallback: boolean) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return fallback;
};
const localMachineEnabled = () => envFlag("CODEX_HUB_LOCAL_MACHINE", true);

const staticRoot = (override?: string) => override
  ? path.resolve(override)
  : path.resolve(process.env.CODEX_HUB_STATIC_DIR ?? path.join(packageRoot(), "dist"));
const sessionOfflineTimeoutMs = () =>
  envMs("CODEX_HUB_SESSION_OFFLINE_TIMEOUT_MS", 45_000);
const sessionOfflineRetentionMs = () =>
  envMs("CODEX_HUB_SESSION_OFFLINE_RETENTION_MS", 30 * 60_000);
const sessionSweepIntervalMs = () =>
  envMs("CODEX_HUB_SESSION_SWEEP_INTERVAL_MS", 5_000);
const taskScanIntervalMs = () => envMs("CODEX_HUB_TASK_SCAN_INTERVAL_MS", 30_000);
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
  const headerToken = request.headers["x-codexhub-token"];
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim();
  const url = new URL(request.url, "http://codexhub.local");
  return url.searchParams.get("codexhub_token")?.trim()
    || url.searchParams.get("token")?.trim()
    || "";
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
const parseSurface = (value: string | undefined): "default" | "vscode" =>
  value === "vscode" ? "vscode" : "default";
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
  surface?: "default" | "vscode";
  authToken?: string | null;
  buildId?: string | null;
  features?: Partial<ServerFeatureOptions>;
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
  const config = loadConfig({ host: options.host, port: options.port });
  const surface = options.surface ?? parseSurface(process.env.CODEX_HUB_SURFACE);
  const features = resolveServerFeatures(options.features);
  const serverAuthToken = normalizedAuthToken(options.authToken ?? process.env.CODEX_HUB_AUTH_TOKEN);
  const buildId = options.buildId ?? process.env.CODEX_HUB_BUILD_ID ?? null;
  const state = await CodexhubServerState.load({ dataDir: options.dataDir });
  const serverInstanceId = randomUUID();
  let threads: ThreadHub;
  const captureSessionState = () => {
    state.captureSessions({
      sessions: threads.listSessions({ includeOffline: true }),
      threads: threads.listThreads()
    });
  };
  threads = new ThreadHub(config.defaultThreadOptions, {
    onCatalogChange: () => publishProjects(),
    onThreadChange: () => {
      captureSessionState();
    }
  });
  const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });
  const projectSubscribers = new Set<(event: ReturnType<typeof projectSnapshotEvent>) => void>();
  const taskSubscribers = new Set<(event: ReturnType<typeof taskSnapshotEvent>) => void>();
  const connectionSubscribers = new Set<(event: ReturnType<typeof connectionSnapshotEvent>) => void>();
  let projectSeq = 0;
  let taskSeq = 0;
  let connectionSeq = 0;
  const machines = new MachineHub({ onChange: () => publishProjects() });
  const sshRemoteClient = features.ssh ? await resolveSshRemoteClientBundle() : null;
  const sshMachines = new SshMachineManager({
    localHost: config.host,
    localPort: config.port,
    sshConfigPath: process.env.CODEX_HUB_SSH_CONFIG,
    remoteMode: sshRemoteMode(),
    remoteClient: sshRemoteClient ?? undefined,
    authToken: serverAuthToken,
    onChange: () => {
      publishConnections();
      publishProjects();
    }
  });
  const plugins = new PluginHub({ builtins: [telegramBuiltinPlugin()] });
  const contextWindowTokens = Number(process.env.CODEX_CONTEXT_WINDOW_TOKENS || 0) || null;
  const staticDirectory = staticRoot(options.staticDirectory);
  let telegramBot: TelegramBotHandle | null = null;
  let localMachine: CodexhubMachineHandle | null = null;
  let parentRegistration: CodexhubMachineHandle | null = null;
  let parentRegistrationStatus: ParentRegistrationStatus = { status: "idle" };
  const threadRecordSubscriptionCounts = new Map<string, number>();
  const threadRecordSubscriptionTimers = new Map<string, NodeJS.Timeout>();
  const tunneledAppServerSessions = new Map<string, {
    transportId: string;
    machineId: string;
    appServerId: string;
    handle: HeadlessCodexhubSessionHandle;
  }>();

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
  const runningTasks = new Set<string>();
  const triggeredTaskMinutes = new Map<string, string>();
  const taskSweep = features.tasks
    ? setInterval(() => void scanLocalTasks(new Date()), taskScanIntervalMs())
    : null;
  taskSweep?.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(sessionSweep);
    if (taskSweep) clearInterval(taskSweep);
    for (const timer of threadRecordSubscriptionTimers.values()) clearTimeout(timer);
    threadRecordSubscriptionTimers.clear();
    await Promise.allSettled([...tunneledAppServerSessions.values()].map((entry) => entry.handle.stop()));
    tunneledAppServerSessions.clear();
    await sshMachines.stopAll();
    await parentRegistration?.stop();
    parentRegistration = null;
    await localMachine?.stop();
    telegramBot?.stop("server closing");
    plugins.setIntegrationState(telegramIntegrationType, telegramPluginState(false));
    await state.flush();
  });
  await app.register(cors, { origin: true });
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

  function vscodeParentRegistrationProjects(): MachineRegistrationProject[] {
    if (surface !== "vscode" || !localMachine) return [];
    return projectSnapshot().projects
      .filter((project) => project.machineId === localMachine?.machineId && project.source?.kind === "vscode")
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
    if (source.kind !== "vscode") return source;
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

  function isVscodeWorkspaceSource(source: ProjectSource | undefined) {
    return source?.kind === "vscode";
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

  const sessionsForProject = (target: { machineId: string; path: string }) => {
    const sessions = threads.listSessions({ includeOffline: true })
      .filter((session) =>
        session.machineId === target.machineId
        && (
          session.workingDirectory === target.path
          || session.threads.some((thread) => thread.workingDirectory === target.path)
        )
      );
    return [...new Map(sessions.map((session) => [session.sessionId, session])).values()];
  };

  const stopProjectSessions = async (target: { machineId: string; path: string }) => {
    const sessions = sessionsForProject(target);
    return sessions.map((session) => ({
      machineId: target.machineId,
      sessionId: session.sessionId,
      stopped: false,
      removed: true,
      reason: session.online ? "shared_session" : "session_offline"
    }));
  };

  function taskSnapshotEvent(): TasksStreamEvent {
    return {
      seq: taskSeq,
      kind: "tasks" as const,
      tasks: localTaskViews()
    } satisfies TasksStreamEvent;
  }

  function localTaskView(task: StoredTask): TaskView {
    return {
      ...task,
      nextRunAt: task.enabled ? nextCronRun(task.schedule, new Date(), defaultTaskTimezone)?.toISOString() ?? null : null
    } satisfies TaskView;
  }

  function localTaskViews(): TaskView[] {
    return state.listTasks().map(localTaskView);
  }

  function publishTasks() {
    const event = {
      seq: ++taskSeq,
      kind: "tasks" as const,
      tasks: localTaskViews()
    } satisfies TasksStreamEvent;
    for (const subscriber of taskSubscribers) subscriber(event);
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

  async function startParentRegistration(input: z.infer<typeof parentRegistrationConnectSchema>) {
    const url = normalizeBaseUrl(input.url);
    await assertNotSelfRegistrationTarget(input.url, {
      host: config.host,
      port: config.port,
      serverInstanceId
    });
    await stopParentRegistration();
    const authToken = input.authToken?.trim()
      || authTokenFromUrl(input.url)
      || process.env.CODEX_HUB_REGISTER_AUTH_TOKEN;
    const machineId = input.machineId?.trim()
      || process.env.CODEX_HUB_REGISTER_MACHINE_ID
      || createMachineId(`${os.hostname()}-server-${config.port}`);
    const name = input.name?.trim()
      || process.env.CODEX_HUB_REGISTER_NAME
      || `CodexHub Server ${localApiBaseUrl(config.host, config.port)}`;
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
      capabilities: surface === "vscode" ? { projectCatalog: "fixed" } : undefined,
      projects: vscodeParentRegistrationProjects,
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

  async function stopParentRegistration() {
    const current = parentRegistration;
    parentRegistration = null;
    if (current) await current.stop();
    parentRegistrationStatus = {
      status: "idle",
      updatedAt: new Date().toISOString()
    };
    return parentRegistrationView();
  }

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

  async function runLocalTask(taskId: string): Promise<TaskMutationPayload> {
    if (!features.tasks) throw new Error("Tasks are disabled for this codexhub surface.");
    const task = state.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const runId = randomUUID();
    if (runningTasks.has(task.taskId)) {
      state.startTaskRun(task.taskId, { runId });
      const skippedTask = state.finishTaskRun(task.taskId, runId, {
        status: "skipped",
        error: "Task already running"
      });
      publishTasks();
      return {
        ok: true,
        skipped: true,
        task: localTaskView(skippedTask)
      } satisfies TaskMutationPayload;
    }
    let releaseOnReturn = true;
    runningTasks.add(task.taskId);
    state.startTaskRun(task.taskId, { runId });
    publishTasks();
    try {
      const started = machines.startSession(task.machineId, {
        cwd: task.projectPath,
        reuse: true
      });
      const session = await started.promise;
      const sessionId = session.sessionId;
      await waitForSession(sessionId);
      let threadId = task.threadId ?? session.threadId;
      if (task.threadId) {
        const resumed = await threads.resumeSessionThread(sessionId, task.threadId, task.projectPath);
        threadId = resumed.threadId;
      } else {
        threads.attachSessionThread(sessionId, threadId, session.cwd);
      }
      const localCommand = threads.runLocalCommand(threadId, task.input, "task");
      if (localCommand.handled) {
        const completedTask = state.finishTaskRun(task.taskId, runId, {
          status: "completed",
          sessionId,
          threadId
        });
        publishTasks();
        return {
          ok: true,
          task: localTaskView(completedTask),
          sessionId,
          threadId,
          command: localCommand.command
        } satisfies TaskMutationPayload;
      }
      const turn = threads.runTurn(threadId, task.input, "task");
      const queuedTask = state.updateTaskRun(task.taskId, {
        lastStatus: "queued",
        threadId
      });
      publishTasks();
      releaseOnReturn = false;
      turn.then(() => {
        state.finishTaskRun(task.taskId, runId, {
          status: "completed",
          sessionId,
          threadId
        });
        publishTasks();
      }).catch((error: unknown) => {
        state.finishTaskRun(task.taskId, runId, {
          status: "failed",
          sessionId,
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
        publishTasks();
      }).finally(() => {
        runningTasks.delete(task.taskId);
      });
      return {
        ok: true,
        task: localTaskView(queuedTask),
        sessionId,
        threadId
      } satisfies TaskMutationPayload;
    } catch (error) {
      state.finishTaskRun(task.taskId, runId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      publishTasks();
      throw error;
    } finally {
      if (releaseOnReturn) runningTasks.delete(task.taskId);
    }
  }

  async function scanLocalTasks(now: Date) {
    if (!features.tasks) return;
    for (const task of state.listTasks()) {
      if (!task.enabled) continue;
      if (!cronMatches(task.schedule, now, defaultTaskTimezone)) continue;
      const minuteKey = cronMinuteKey(now, defaultTaskTimezone);
      if (triggeredTaskMinutes.get(task.taskId) === minuteKey) continue;
      if (cronMinuteKeyFromIso(task.lastRunAt, defaultTaskTimezone) === minuteKey) {
        triggeredTaskMinutes.set(task.taskId, minuteKey);
        continue;
      }
      triggeredTaskMinutes.set(task.taskId, minuteKey);
      void runLocalTask(task.taskId)
        .catch((error: unknown) => {
          console.error(`codexhub task failed: ${task.name}: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
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

  app.get("/api/auth/status", async (request) => ({
    authRequired: Boolean(serverAuthToken),
    authenticated: !serverAuthToken || isAuthorizedRequest(request, serverAuthToken)
  } satisfies AuthStatusPayload));

  app.get("/api/health", async (request) => ({
    ok: true,
    serverInstanceId,
    authRequired: Boolean(serverAuthToken),
    authenticated: !serverAuthToken || isAuthorizedRequest(request, serverAuthToken),
    env: process.env.CODEX_HUB_ENV ?? process.env.NODE_ENV ?? "development",
    build: buildId,
    host: config.host,
    port: config.port,
    surface,
    features,
    staticDirectory,
    statePath: state.path,
    model: config.defaultThreadOptions.model ?? null,
    modelReasoningEffort: config.defaultThreadOptions.modelReasoningEffort ?? null,
    serviceTier: config.defaultThreadOptions.serviceTier ?? null,
    contextWindowTokens,
    ssh: {
      connections: sshMachines.listConnections()
    },
    telegram: {
      started: Boolean(telegramBot)
    }
  } satisfies HealthPayload));

  registerThreadRoutes(app, {
    connectionSnapshotEvent,
    connectionSubscribers,
    forceReleaseThreadRecordSubscription,
    markStaleSessions: () => threads.markStaleSessionsOffline(sessionOfflineTimeoutMs(), Date.now(), sessionOfflineRetentionMs()),
    projectSnapshotEvent,
    projectSubscribers,
    publishProjects,
    releaseThreadRecordSubscription,
    retainThreadRecordSubscription,
    taskSnapshotEvent,
    taskSubscribers,
    threads
  });

  app.get("/api/machines", async () => ({
    machines: machines.listMachines()
  } satisfies MachinesPayload));

  app.get("/api/ssh/config-hosts", async () => ({
    hosts: features.ssh ? await listSshHosts() : []
  } satisfies SshHostsPayload));

  app.get("/api/ssh/hosts", async () => ({
    hosts: await listCodexhubSshHosts()
  } satisfies SshHostsPayload));

  app.post("/api/ssh/hosts", async (request, reply) => {
    if (!features.ssh) {
      reply.code(404);
      return { error: "ssh_disabled" };
    }
    const payload = sshHostAliasSchema.parse(request.body);
    const alias = payload.alias.trim();
    const configHostsByAlias = await localSshConfigHostsByAlias();
    if (!configHostsByAlias.has(alias)) {
      reply.code(404);
      return { error: `SSH config host not found: ${alias}` };
    }
    const alreadySaved = state.listSshHosts().some((host) => host.alias === alias);
    state.upsertSshHost({ alias });
    if (!alreadySaved) void autoConnectSavedSshHost(alias, "host_added");
    return {
      ok: true,
      hosts: await listCodexhubSshHosts()
    } satisfies SshHostsPayload;
  });

  app.delete("/api/ssh/hosts/:alias", async (request, reply) => {
    if (!features.ssh) {
      reply.code(404);
      return { error: "ssh_disabled" };
    }
    const params = sshHostAliasSchema.parse(request.params);
    await stopSshConnectionsForHost(params.alias);
    return {
      ok: true,
      deleted: state.deleteSshHost(params.alias),
      hosts: await listCodexhubSshHosts()
    } satisfies SshHostsPayload;
  });

  app.get("/api/ssh/connections", async () => ({
    connections: features.ssh ? sshMachines.listConnections() : []
  } satisfies SshConnectionsPayload));

  app.get("/api/registered/parent", async () => ({
    registration: parentRegistrationView()
  } satisfies ParentRegistrationPayload));

  app.post("/api/registered/parent", async (request) => {
    const input = parentRegistrationConnectSchema.parse(request.body);
    return {
      registration: await startParentRegistration(input)
    } satisfies ParentRegistrationPayload;
  });

  app.delete("/api/registered/parent", async () => ({
    registration: await stopParentRegistration()
  } satisfies ParentRegistrationPayload));

  app.get("/api/registered/bootstrap", async (request, reply) => {
    const query = z.object({
      server: z.string().url().optional(),
      name: z.string().min(1).optional()
    }).parse(request.query);
    const bundle = await resolveSshRemoteClientBundle();
    if (!bundle) {
      reply.code(404);
      return { error: "remote_client_not_found" };
    }
    const serverBase = normalizeBaseUrl(query.server ?? requestBaseUrl(request, config.host, config.port));
    const authToken = normalizedAuthToken(requestAuthToken(request));
    const script = registeredBootstrapScript({
      serverBase,
      clientUrl: `${serverBase}/api/remote-client/${bundle.hash}`,
      clientHash: bundle.hash,
      authToken,
      name: query.name
    });
    reply.type("text/x-shellscript; charset=utf-8");
    reply.header("cache-control", "no-cache");
    return reply.send(script);
  });

  app.get("/api/remote-client/:hash", async (request, reply) => {
    const params = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params);
    const bundle = await readSshRemoteClientBundle(params.hash);
    if (!bundle) {
      reply.code(404);
      return { error: "remote_client_not_found" };
    }
    reply.type("text/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("x-codexhub-remote-client-sha256", bundle.hash);
    return reply.send(bundle.content);
  });

  app.get("/api/ssh/remote-client/:hash", async (request, reply) => {
    if (!features.ssh) {
      reply.code(404);
      return { error: "ssh_disabled" };
    }
    const params = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params);
    const bundle = await readSshRemoteClientBundle(params.hash);
    if (!bundle) {
      reply.code(404);
      return { error: "ssh_remote_client_not_found" };
    }
    reply.type("text/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("x-codexhub-remote-client-sha256", bundle.hash);
    return reply.send(bundle.content);
  });

  app.get("/api/plugins", async () => ({
    plugins: await plugins.listPlugins()
  } satisfies PluginsPayload));

  app.get("/api/plugins/:pluginId/assets/*", async (request, reply) => {
    const params = z.object({
      pluginId: z.string().min(1),
      "*": z.string().min(1)
    }).parse(request.params);
    try {
      const filePath = await plugins.resolveAsset(params.pluginId, params["*"]);
      reply.type(contentType(filePath));
      return reply.send(createReadStream(filePath));
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/ssh/connect", async (request, reply) => {
    if (!features.ssh) {
      reply.code(404);
      return { error: "ssh_disabled" };
    }
    const payload = sshConnectSchema.parse(request.body);
    try {
      return {
        ok: true,
        connection: sshMachines.connect(payload)
      } satisfies SshConnectionPayload;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.delete("/api/ssh/connections/:connectionId", async (request, reply) => {
    if (!features.ssh) {
      reply.code(404);
      return { error: "ssh_disabled" };
    }
    const params = z.object({ connectionId: z.string().min(1) }).parse(request.params);
    try {
      return {
        ok: true,
        connection: await sshMachines.stop(params.connectionId)
      } satisfies SshConnectionPayload;
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/machines/:machineId/directories", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    try {
      const command = machines.listDirectory(params.machineId, { cwd: query.path });
      const listing = await command.promise;
      return listing satisfies MachineDirectoryListing;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerProjectTaskRoutes(app, {
    features,
    fixedProjectPathExists,
    isVscodeWorkspaceSource,
    localTaskView,
    localTaskViews,
    machines,
    projectIsFixed,
    projectSnapshot,
    publishProjects,
    publishTasks,
    resolveTargetMachine,
    runLocalTask,
    sessionsForProject,
    state,
    stopProjectSessions,
    surface,
    threads,
    waitForSession
  });

  const stopTunneledAppServerSession = async (sessionId: string, transportId?: string) => {
    const entry = tunneledAppServerSessions.get(sessionId);
    if (!entry) return;
    if (transportId && entry.transportId !== transportId) return;
    tunneledAppServerSessions.delete(sessionId);
    await entry.handle.stop().catch(() => undefined);
    publishProjects();
  };

  const stopTunneledAppServerSessionsForTransport = async (transportId: string) => {
    const sessionIds = [...tunneledAppServerSessions.entries()]
      .filter(([, entry]) => entry.transportId === transportId)
      .map(([sessionId]) => sessionId);
    await Promise.allSettled(sessionIds.map((sessionId) => stopTunneledAppServerSession(sessionId, transportId)));
  };

  const attachTunneledAppServer = async (input: {
    machineId: string;
    transportId: string;
    commandId: string;
    sessionId: string;
    appServerId: string;
    cwd: string;
    appServerUrl: string;
    tunnel: AppServerTunnelPeer;
  }) => {
    const existing = tunneledAppServerSessions.get(input.sessionId);
    if (existing && existing.transportId !== input.transportId) {
      await stopTunneledAppServerSession(input.sessionId);
    }
    if (existing && existing.transportId === input.transportId) return existing.handle.threadId;
    const sessionTransportId = `${input.transportId}:app-server:${input.sessionId}`;
    // 已注册 machine 的 app-server 通过 tunnel 接入；ThreadHub 看到的仍是一条普通 session。
    const handle = await startAttachedCodexhubSession({
      apiBase: localApiBaseUrl(config.host, config.port),
      appServerUrl: `tunnel://${input.appServerId}`,
      appServerTransportFactory: () => input.tunnel.openStream(input.appServerId),
      sessionId: input.sessionId,
      machineId: input.machineId,
      cwd: input.cwd,
      readyLabel: "codexhub tunneled app-server ready",
      transportFactory: (_context, callbacks) => new DirectThreadHubSessionTransport({
        threads,
        sessionId: input.sessionId,
        machineId: input.machineId,
        transportId: sessionTransportId,
        onChange: () => {
          captureSessionState();
          publishProjects();
        },
        onRegister: () => refreshRetainedThreadRecordSubscriptions()
      }, callbacks)
    });
    tunneledAppServerSessions.set(input.sessionId, {
      transportId: input.transportId,
      machineId: input.machineId,
      appServerId: input.appServerId,
      handle
    });
    publishProjects();
    return handle.threadId;
  };

  const startTunneledAppServerThread = async (input: {
    transportId: string;
    sessionId: string;
    cwd: string;
    threadId?: string;
  }) => {
    const entry = tunneledAppServerSessions.get(input.sessionId);
    if (!entry || entry.transportId !== input.transportId) {
      throw new Error(`Tunneled app-server session not attached: ${input.sessionId}`);
    }
    // 同一个 tunneled runtime 按 cwd 启动/复用 thread，不新建 machine session。
    const threadId = input.threadId
      ? await entry.handle.ensureThread(input.threadId, input.cwd)
      : await entry.handle.startThread(input.cwd);
    publishProjects();
    return threadId;
  };

  app.get("/api/machines/connect", { websocket: true }, (socket) => {
    const transportId = randomUUID();
    let machineId: string | null = null;
    let commandCursor = 0;
    let closed = false;
    let commandPumpStarted = false;
    const sessionIds = new Set<string>();
    const sessionCursors = new Map<string, number>();
    const sessionCommandPumps = new Set<string>();

    const send = (message: unknown) => {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify(message));
    };
    const tunnel = new AppServerTunnelPeer({
      send: (frame) => send(frame),
      label: `codexhub server machine transport ${transportId}`
    });

    const startCommandPump = () => {
      if (commandPumpStarted) return;
      commandPumpStarted = true;
      void commandPump().catch((error: unknown) => {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        socket.close();
      });
    };

    const commandPump = async () => {
      while (!closed && machineId) {
        // 这里的 machine command 长轮询只负责 machine 级动作；thread 动作走 sessionCommandPump。
        const response = await machines.waitMachineCommands(machineId, commandCursor, 60_000);
        if (closed || !machineId) return;
        commandCursor = Math.max(commandCursor, response.cursor);
        if (response.commands.length) {
          send({ type: "commands", cursor: commandCursor, commands: response.commands });
        }
      }
    };

    const sessionTransportId = (sessionId: string) => `${transportId}:${sessionId}`;

    const startSessionCommandPump = (sessionId: string) => {
      if (sessionCommandPumps.has(sessionId)) return;
      sessionCommandPumps.add(sessionId);
      void sessionCommandPump(sessionId)
        .catch((error: unknown) => {
          send({
            type: "session_error",
            sessionId,
            message: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          sessionCommandPumps.delete(sessionId);
        });
    };

    const sessionCommandPump = async (sessionId: string) => {
      while (!closed && sessionIds.has(sessionId)) {
        // 每条 session command pump 独立按 cursor replay，避免多个 session 相互阻塞。
        const response = await threads.waitSessionCommands(sessionId, sessionCursors.get(sessionId) ?? 0, 60_000);
        if (closed || !sessionIds.has(sessionId)) return;
        sessionCursors.set(sessionId, Math.max(sessionCursors.get(sessionId) ?? 0, response.cursor));
        if (response.commands.length) {
          send({
            type: "session_commands",
            sessionId,
            cursor: sessionCursors.get(sessionId) ?? response.cursor,
            commands: response.commands
          });
        }
      }
    };

    const disconnectSessions = () => {
      for (const sessionId of [...sessionIds]) {
        threads.disconnectSession(sessionId, sessionTransportId(sessionId));
      }
      sessionIds.clear();
      sessionCursors.clear();
    };

    const handleMessage = async (data: unknown) => {
      let parsed: z.infer<typeof machineTransportMessageSchema>;
      try {
        parsed = machineTransportMessageSchema.parse(JSON.parse(String(data)));
      } catch (error) {
        send({ type: "error", message: `invalid machine transport message: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }

      if (parsed.type !== "register" && !machineId) {
        send({ type: "error", message: "machine transport must register before sending messages" });
        return;
      }

      try {
        if (isAppServerTunnelFrame(parsed)) {
          tunnel.handleFrame(parsed);
          return;
        }

        if (parsed.type === "register") {
          const result = machines.registerMachine({ ...parsed.registration, transportId });
          state.upsertMachine({
            machineId: result.machineId,
            type: result.machine.type,
            hostname: result.machine.hostname,
            name: result.machine.name,
            lastSeenAt: result.machine.lastSeenAt,
            capabilities: result.machine.capabilities
          });
          replaceMachineRegistrationProjects(result.machineId, parsed.registration.projects);
          machineId = result.machineId;
          commandCursor = machines.clampMachineCommandCursor(machineId, parsed.commandCursor ?? 0);
          send({ type: "registered", machineId, machine: result.machine });
          publishProjects();
          startCommandPump();
          return;
        }

        if (parsed.type === "app_server_ready") {
          const threadId = await attachTunneledAppServer({
            machineId: machineId!,
            transportId,
            commandId: parsed.commandId,
            sessionId: parsed.sessionId,
            appServerId: parsed.appServerId,
            cwd: parsed.cwd,
            appServerUrl: parsed.appServerUrl,
            tunnel
          });
          send({
            type: "app_server_attached",
            commandId: parsed.commandId,
            sessionId: parsed.sessionId,
            threadId
          });
          return;
        }

        if (parsed.type === "app_server_start_thread") {
          const threadId = await startTunneledAppServerThread({
            transportId,
            sessionId: parsed.sessionId,
            cwd: parsed.cwd,
            threadId: parsed.threadId
          });
          send({
            type: "app_server_attached",
            commandId: parsed.commandId,
            sessionId: parsed.sessionId,
            threadId
          });
          return;
        }

        if (parsed.type === "app_server_stopped") {
          await stopTunneledAppServerSession(parsed.sessionId, transportId);
          return;
        }

        if (parsed.type === "unregister") {
          machines.unregisterMachine(machineId!, transportId);
          clearMachineRegistrationProjects(machineId!);
          await stopTunneledAppServerSessionsForTransport(transportId);
          for (const sessionId of [...sessionIds]) {
            threads.unregisterSession(sessionId, sessionTransportId(sessionId));
          }
          sessionIds.clear();
          sessionCursors.clear();
          publishProjects();
          machineId = null;
          socket.close();
          return;
        }

        if (parsed.type === "heartbeat") {
          machines.heartbeatMachine(machineId!, parsed.registration ?? {});
          publishProjects();
          return;
        }

        if (parsed.type === "session_register") {
          // 历史 currentThreadId 只容忍丢弃；server 不恢复 current thread 状态。
          const { currentThreadId: _legacyCurrentThreadId, ...registration } = parsed.registration;
          const registered = threads.registerSession({
            ...registration,
            sessionId: parsed.sessionId,
            machineId: machineId!,
            transportId: sessionTransportId(parsed.sessionId)
          });
          const sessionId = registered.sessionId;
          sessionIds.add(sessionId);
          sessionCursors.set(sessionId, threads.clampSessionCommandCursor(sessionId, parsed.commandCursor ?? 0));
          send({ type: "session_registered", sessionId, session: registered.session });
          refreshRetainedThreadRecordSubscriptions();
          publishProjects();
          startSessionCommandPump(sessionId);
          return;
        }

        if (parsed.type === "session_unregister") {
          threads.unregisterSession(parsed.sessionId, sessionTransportId(parsed.sessionId));
          sessionIds.delete(parsed.sessionId);
          sessionCursors.delete(parsed.sessionId);
          publishProjects();
          return;
        }

        if (parsed.type === "session_heartbeat") {
          const { currentThreadId: _legacyCurrentThreadId, ...registration } = parsed.registration ?? {};
          threads.heartbeatSession(parsed.sessionId, registration);
          return;
        }

        if (parsed.type === "session_event") {
          threads.applySessionEvent(parsed.sessionId, parsed.event);
          return;
        }

        if (parsed.type === "session_command_result") {
          threads.resolveSessionCommand(parsed.sessionId, parsed.commandId, parsed.result);
          return;
        }

        if (parsed.type === "session_command_error") {
          threads.failSessionCommand(parsed.sessionId, parsed.commandId, parsed.message);
          return;
        }

        if (parsed.type === "command_result") {
          machines.resolveCommand(machineId!, parsed.commandId, parsed.result);
          publishProjects();
          return;
        }

        machines.failCommand(machineId!, parsed.commandId, parsed.message);
        publishProjects();
      } catch (error) {
        if (parsed.type === "app_server_ready" || parsed.type === "app_server_start_thread") {
          send({
            type: "app_server_attach_error",
            commandId: parsed.commandId,
            sessionId: parsed.sessionId,
            message: error instanceof Error ? error.message : String(error)
          });
          return;
        }
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };

    socket.on("message", (data: unknown) => void handleMessage(data));
    socket.on("close", () => {
      closed = true;
      tunnel.closeAll();
      disconnectSessions();
      void stopTunneledAppServerSessionsForTransport(transportId);
      if (machineId) {
        machines.disconnectMachine(machineId, transportId);
        clearMachineRegistrationProjects(machineId);
        publishProjects();
      }
    });
    socket.on("error", () => {
      closed = true;
      tunnel.closeAll();
      disconnectSessions();
      void stopTunneledAppServerSessionsForTransport(transportId);
      if (machineId) {
        machines.disconnectMachine(machineId, transportId);
        clearMachineRegistrationProjects(machineId);
        publishProjects();
      }
    });
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
      capabilities: surface === "vscode" ? { projectCatalog: "fixed" } : undefined
    });
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

class DirectThreadHubSessionTransport implements HeadlessSessionTransport {
  private stopped = false;
  private registered = false;
  private commandCursor = 0;
  private commandLoopStarted = false;

  constructor(
    private readonly options: {
      threads: ThreadHub;
      sessionId: string;
      machineId?: string;
      transportId: string;
      onChange: () => void;
      onRegister?: () => void;
    },
    private readonly callbacks: HeadlessSessionTransportCallbacks
  ) {}

  start() {
    if (this.stopped || this.registered) return;
    this.callbacks.onState("connecting", `codexhub direct session registering: ${this.options.sessionId}`);
    // 这是 server 内部 transport，不再经 machine WebSocket 反绕一圈。
    const { currentThreadId: _legacyCurrentThreadId, ...registration } = this.callbacks.registration() as SessionRegistration & { currentThreadId?: string };
    this.options.threads.registerSession({
      ...registration,
      sessionId: this.options.sessionId,
      machineId: this.options.machineId,
      transportId: this.options.transportId
    });
    this.registered = true;
    this.callbacks.onState("online", `codexhub direct session connected: ${this.options.sessionId}`);
    this.options.onRegister?.();
    this.options.onChange();
    this.startCommandLoop();
  }

  stop(options: { unregister?: boolean } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.registered) {
      if (options.unregister) this.options.threads.unregisterSession(this.options.sessionId, this.options.transportId);
      else this.options.threads.disconnectSession(this.options.sessionId, this.options.transportId);
    }
    this.registered = false;
    this.options.onChange();
  }

  sendEvent(event: SessionEventInput) {
    if (this.stopped || !this.registered) return;
    this.options.threads.applySessionEvent(this.options.sessionId, event);
    this.options.onChange();
  }

  sendHeartbeat(registration: Partial<SessionRegistration>) {
    if (this.stopped || !this.registered) return;
    this.options.threads.heartbeatSession(this.options.sessionId, registration);
  }

  private startCommandLoop() {
    if (this.commandLoopStarted) return;
    this.commandLoopStarted = true;
    void this.commandLoop().catch((error: unknown) => {
      if (!this.stopped) this.callbacks.onState("offline", `codexhub direct session command loop failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async commandLoop() {
    while (!this.stopped && this.registered) {
      // 直接 transport 同样使用 ThreadHub command cursor，保持和远端 session 一致的 replay 语义。
      const response = await this.options.threads.waitSessionCommands(this.options.sessionId, this.commandCursor, 60_000);
      if (this.stopped || !this.registered) return;
      this.commandCursor = Math.max(this.commandCursor, response.cursor);
      for (const command of response.commands) {
        await this.handleCommand(command);
      }
    }
  }

  private async handleCommand(command: SessionCommand) {
    try {
      const result = await this.callbacks.handleCommand(command);
      if (result !== undefined) {
        this.options.threads.resolveSessionCommand(this.options.sessionId, command.commandId, result);
      }
    } catch (error) {
      this.options.threads.failSessionCommand(this.options.sessionId, command.commandId, error instanceof Error ? error.message : String(error));
    } finally {
      this.commandCursor = Math.max(this.commandCursor, command.seq);
      this.options.onChange();
    }
  }
}

const registeredBootstrapScript = (input: {
  serverBase: string;
  clientUrl: string;
  clientHash: string;
  authToken: string | null;
  name?: string;
}) => [
  "#!/bin/sh",
  "set -eu",
  "PATH=\"/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/bin:/usr/bin:/bin:$PATH\"",
  "export PATH",
  `CODEXHUB_REMOTE_CLIENT_HASH=${shellQuote(input.clientHash)}`,
  `CODEXHUB_REMOTE_CLIENT_URL=${shellQuote(input.clientUrl)}`,
  ...(input.authToken ? [`CODEX_HUB_AUTH_TOKEN=${shellQuote(input.authToken)}`] : []),
  `export CODEXHUB_REMOTE_CLIENT_HASH CODEXHUB_REMOTE_CLIENT_URL${input.authToken ? " CODEX_HUB_AUTH_TOKEN" : ""}`,
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
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const authTokenFromUrl = (value: string) => {
  const url = new URL(value);
  return url.searchParams.get("codexhub_token")?.trim()
    || url.searchParams.get("token")?.trim()
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

const registerStaticRoutes = (app: FastifyInstance, root: string) => {
  const sendIndex = async (_request: unknown, reply: any) => {
    const indexPath = path.join(root, "index.html");
    if (!await fileExists(indexPath)) {
      reply.code(404);
      return { error: "dist_index_not_found", path: indexPath };
    }
    reply.type("text/html; charset=utf-8");
    reply.header("cache-control", "no-cache");
    return reply.send(createReadStream(indexPath));
  };

  app.get("/", sendIndex);
  app.get("/*", async (request, reply) => {
    const rawPath = (request.params as { "*": string })["*"] ?? "";
    if (rawPath === "api" || rawPath.startsWith("api/")) {
      reply.code(404);
      return { error: "api_route_not_found", path: `/${rawPath}` };
    }
    const requested = path.resolve(root, rawPath);
    if (!requested.startsWith(`${root}${path.sep}`)) {
      reply.code(403);
      return { error: "forbidden_path" };
    }
    if (await fileExists(requested)) {
      reply.type(contentType(requested));
      return reply.send(createReadStream(requested));
    }
    return sendIndex(request, reply);
  });
};

const fileExists = async (filePath: string) => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const delay = async (ms: number) => await new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const contentType = (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".ico") return "image/x-icon";
  return "application/octet-stream";
};

const sshRemoteMode = () => process.env.CODEX_HUB_SSH_REMOTE_MODE === "installed" ? "installed" : "bootstrap";

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
