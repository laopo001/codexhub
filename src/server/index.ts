import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MachineHub } from "../core/machineHub.js";
import { loadConfig } from "../core/config.js";
import { loadDotEnv } from "../core/dotenv.js";
import { PluginHub } from "../core/pluginHub.js";
import { CodexhubServerState } from "../core/serverState.js";
import { listSshHosts } from "../core/sshConfig.js";
import { SshMachineManager } from "../core/sshMachine.js";
import { readSshRemoteClientBundle, resolveSshRemoteClientBundle } from "../core/sshRemoteClient.js";
import { cronMatches, cronMinuteKey, defaultTaskTimezone, isCronExpression } from "../core/taskCron.js";
import { runtimeSessionFromWorker, ThreadHub } from "../core/threadHub.js";
import { startCodexhubMachine, type CodexhubMachineHandle } from "../cli/codexhubMachine.js";
import {
  startTelegramPlugin,
  telegramBuiltinPlugin,
  telegramIntegrationType,
  telegramPluginRuntimeState,
  type TelegramBotHandle
} from "../../plugins/telegram/index.js";

const inputSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        url: z.string().min(1),
        detail: z.enum(["auto", "low", "high", "original"]).optional()
      })
    ])
  )
]);

const threadRunOptionsSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional(),
  collaborationMode: z.enum(["default", "plan"]).nullable().optional(),
  goalMode: z.boolean().nullable().optional(),
  goalObjective: z.string().min(1).nullable().optional(),
  goalTokenBudget: z.number().int().positive().nullable().optional()
});

const sessionRegistrationSchema = z.object({
  machineId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  workingDirectory: z.string().min(1),
  appServerUrl: z.string().min(1).optional(),
  pid: z.number().int().optional(),
  hostname: z.string().min(1).optional(),
  currentThreadId: z.string().min(1).optional()
}).strict();

const sessionHeartbeatSchema = sessionRegistrationSchema.partial();

const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thread_event"),
    threadId: z.string().min(1),
    commandId: z.string().min(1).optional(),
    heartbeat: z.boolean().optional(),
    message: z.unknown()
  }),
  z.object({
    type: z.literal("thread_execution_changed"),
    threadId: z.string().min(1),
    running: z.boolean(),
    turnId: z.string().min(1).optional(),
    heartbeat: z.boolean().optional()
  }),
  z.object({
    type: z.literal("runtime_settings_changed"),
    threadId: z.string().min(1),
    model: z.string().min(1).nullable().optional(),
    modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional(),
    heartbeat: z.boolean().optional()
  })
]);

const jsonlLineSchema = z.object({
  line: z.number().int().min(1),
  text: z.string()
}).strict();

const sessionRecordsSchema = z.object({
  threadId: z.string().min(1),
  mode: z.enum(["replace", "append"]),
  path: z.string().min(1).optional(),
  lastLine: z.number().int().min(0),
  lines: z.array(jsonlLineSchema),
  heartbeat: z.boolean().optional()
}).strict();

const machineRegistrationSchema = z.object({
  machineId: z.string().min(1).optional(),
  type: z.enum(["local", "ssh", "registered"]).optional(),
  name: z.string().min(1).optional(),
  hostname: z.string().min(1),
  pid: z.number().int().optional(),
  platform: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  capabilities: z.object({
    projectLauncher: z.boolean().optional()
  }).optional()
});

const machineHeartbeatSchema = machineRegistrationSchema.partial();

const machineStartSessionResultSchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  appServerUrl: z.string().min(1),
  cwd: z.string().min(1),
  reused: z.boolean().optional()
});

const machineDirectoryListingSchema = z.object({
  cwd: z.string().min(1),
  parent: z.string().min(1).optional(),
  home: z.string().min(1),
  entries: z.array(z.object({
    name: z.string().min(1),
    path: z.string().min(1)
  }))
});

const machineStopSessionResultSchema = z.object({
  sessionId: z.string().min(1),
  stopped: z.boolean(),
  cwd: z.string().min(1).optional()
});

const machineTransportMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("register"),
    commandCursor: z.number().int().min(0).optional(),
    registration: machineRegistrationSchema
  }),
  z.object({
    type: z.literal("unregister")
  }),
  z.object({
    type: z.literal("heartbeat"),
    registration: machineHeartbeatSchema.optional()
  }),
  z.object({
    type: z.literal("command_result"),
    commandId: z.string().min(1),
    result: z.union([machineStartSessionResultSchema, machineDirectoryListingSchema, machineStopSessionResultSchema])
  }),
  z.object({
    type: z.literal("command_error"),
    commandId: z.string().min(1),
    message: z.string().min(1)
  }),
  z.object({
    type: z.literal("session_register"),
    sessionId: z.string().min(1),
    commandCursor: z.number().int().min(0).optional(),
    registration: sessionRegistrationSchema
  }),
  z.object({
    type: z.literal("session_unregister"),
    sessionId: z.string().min(1)
  }),
  z.object({
    type: z.literal("session_heartbeat"),
    sessionId: z.string().min(1),
    registration: sessionHeartbeatSchema.optional()
  }),
  z.object({
    type: z.literal("session_event"),
    sessionId: z.string().min(1),
    event: sessionEventSchema
  }),
  z.object({
    type: z.literal("session_records"),
    sessionId: z.string().min(1),
    records: sessionRecordsSchema
  }),
  z.object({
    type: z.literal("session_command_result"),
    sessionId: z.string().min(1),
    commandId: z.string().min(1),
    result: z.unknown()
  }),
  z.object({
    type: z.literal("session_command_error"),
    sessionId: z.string().min(1),
    commandId: z.string().min(1),
    message: z.string().min(1)
  })
]);

const webEventsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    sessionsAfter: z.number().int().min(0).optional(),
    projectsAfter: z.number().int().min(0).optional(),
    tasksAfter: z.number().int().min(0).optional(),
    connectionsAfter: z.number().int().min(0).optional()
  }).strict(),
  z.object({
    type: z.literal("subscribe_thread"),
    threadId: z.string().min(1),
    after: z.number().int().min(0).optional()
  }).strict(),
  z.object({
    type: z.literal("unsubscribe_thread"),
    threadId: z.string().min(1)
  }).strict()
]);

const sshConnectSchema = z.object({
  host: z.string().min(1),
  name: z.string().min(1).optional(),
  remotePort: z.number().int().min(1).max(65535).optional(),
  remoteCommand: z.string().min(1).optional()
});

const sshHostAliasSchema = z.object({
  alias: z.string().min(1)
}).strict();

const cronScheduleSchema = z.string().min(1).refine(isCronExpression, {
  message: "Invalid cron schedule. Use five fields such as \"0 9 * * *\"."
});

const taskCreateSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  schedule: cronScheduleSchema,
  machineId: z.string().min(1),
  projectPath: z.string().min(1),
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  input: z.string().min(1)
});

const taskUpdateSchema = taskCreateSchema.partial();

type SseStream = NodeJS.WritableStream & {
  destroyed?: boolean;
  flushHeaders?: () => void;
  writableEnded?: boolean;
  writeHead?: (statusCode: number, headers: Record<string, string>) => void;
};

const envMs = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const sseHeartbeatMs = () => envMs("CODEX_HUB_SSE_HEARTBEAT_MS", 20_000);
const envFlag = (name: string, fallback: boolean) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return fallback;
};
const localMachineEnabled = () => envFlag("CODEX_HUB_LOCAL_MACHINE", true);

const sseEventId = (data: unknown) => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const seq = (data as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? String(seq) : null;
};

const sendSse = (raw: SseStream, event: string, data: unknown) => {
  const id = sseEventId(data);
  if (id) raw.write(`id: ${id}\n`);
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
};

const sendSseComment = (raw: SseStream, comment: string) => {
  if (raw.destroyed || raw.writableEnded) return;
  raw.write(`: ${comment}\n\n`);
};

const startSse = (raw: SseStream) => {
  raw.writeHead?.(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  raw.flushHeaders?.();
  sendSseComment(raw, "connected");

  const intervalMs = sseHeartbeatMs();
  const heartbeat = intervalMs > 0
    ? setInterval(() => sendSseComment(raw, "ping"), intervalMs)
    : null;
  return () => {
    if (heartbeat) clearInterval(heartbeat);
  };
};

const staticRoot = (override?: string) => override
  ? path.resolve(override)
  : path.resolve(process.env.CODEX_HUB_STATIC_DIR ?? path.join(packageRoot(), "dist"));
const sessionOfflineTimeoutMs = () =>
  envMs("CODEX_HUB_SESSION_OFFLINE_TIMEOUT_MS", envMs("CODEX_HUB_WORKER_OFFLINE_TIMEOUT_MS", 45_000));
const sessionOfflineRetentionMs = () =>
  envMs("CODEX_HUB_SESSION_OFFLINE_RETENTION_MS", envMs("CODEX_HUB_WORKER_OFFLINE_RETENTION_MS", 30 * 60_000));
const sessionSweepIntervalMs = () =>
  envMs("CODEX_HUB_SESSION_SWEEP_INTERVAL_MS", envMs("CODEX_HUB_WORKER_SWEEP_INTERVAL_MS", 5_000));
const taskScanIntervalMs = () => envMs("CODEX_HUB_TASK_SCAN_INTERVAL_MS", 30_000);
const localApiBaseUrl = (host: string, port: number) => {
  const apiHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${apiHost}:${port}`;
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
  staticDirectory?: string;
  surface?: "default" | "vscode";
  features?: Partial<ServerFeatureOptions>;
};

export type ServerHandle = {
  app: FastifyInstance;
  host: string;
  port: number;
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
  const state = await CodexhubServerState.load();
  let threads: ThreadHub;
  const captureRuntimeState = () => {
    state.captureRuntime({
      runtimeSessions: threads.listWorkers({ includeOffline: true }),
      threads: threads.listThreads()
    });
  };
  threads = new ThreadHub(config.defaultThreadOptions, {
    onCatalogChange: () => publishProjects(),
    onThreadChange: () => captureRuntimeState()
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
  const threadRecordObservationCounts = new Map<string, number>();
  const threadRecordObservationTimers = new Map<string, NodeJS.Timeout>();

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
    threads.markStaleWorkersOffline(sessionOfflineTimeoutMs(), Date.now(), sessionOfflineRetentionMs());
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
    for (const timer of threadRecordObservationTimers.values()) clearTimeout(timer);
    threadRecordObservationTimers.clear();
    await sshMachines.stopAll();
    await localMachine?.stop();
    telegramBot?.stop("server closing");
    plugins.setIntegrationState(telegramIntegrationType, telegramPluginRuntimeState(false));
    await state.flush();
  });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  function projectSnapshot() {
    return state.snapshot({
      machines: machines.listMachines(),
      runtimeSessions: threads.listWorkers({ includeOffline: true }),
      threads: threads.listThreads()
    });
  }

  function projectSnapshotEvent() {
    return {
      seq: projectSeq,
      kind: "projects" as const,
      ...projectSnapshot()
    };
  }

  function publishProjects() {
    captureRuntimeState();
    const event = {
      seq: ++projectSeq,
      kind: "projects" as const,
      ...projectSnapshot()
    };
    for (const subscriber of projectSubscribers) subscriber(event);
  }

  const cancelThreadRecordObservationIdle = (threadId: string) => {
    const timer = threadRecordObservationTimers.get(threadId);
    if (!timer) return false;
    clearTimeout(timer);
    threadRecordObservationTimers.delete(threadId);
    return true;
  };

  const retainThreadRecordObservation = (threadId: string) => {
    const current = threadRecordObservationCounts.get(threadId) ?? 0;
    const hadIdleTimer = cancelThreadRecordObservationIdle(threadId);
    threadRecordObservationCounts.set(threadId, current + 1);
    if (current > 0 || hadIdleTimer) return;
    try {
      threads.observeThreadRecords(threadId);
    } catch {
      // A thread subscription can still serve the in-memory snapshot when its runtime is offline.
    }
  };

  const releaseThreadRecordObservation = (threadId: string) => {
    const current = threadRecordObservationCounts.get(threadId) ?? 0;
    if (current <= 0) return;
    if (current > 1) {
      threadRecordObservationCounts.set(threadId, current - 1);
      return;
    }
    threadRecordObservationCounts.delete(threadId);
    scheduleThreadRecordObservationIdle(threadId);
  };

  const forceReleaseThreadRecordObservation = (threadId: string) => {
    threadRecordObservationCounts.delete(threadId);
    cancelThreadRecordObservationIdle(threadId);
    try {
      threads.unobserveThreadRecords(threadId);
    } catch {
      // Thread deletion should not be blocked by a stale or offline runtime session.
    }
  };

  const refreshRetainedThreadRecordObservations = () => {
    for (const threadId of threadRecordObservationCounts.keys()) {
      try {
        threads.observeThreadRecords(threadId);
      } catch {
        // Observation is best-effort; Web subscriptions still receive stored thread events.
      }
    }
  };

  function scheduleThreadRecordObservationIdle(threadId: string) {
    if (threadRecordObservationTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      threadRecordObservationTimers.delete(threadId);
      if ((threadRecordObservationCounts.get(threadId) ?? 0) > 0) return;
      const thread = threads.getThread(threadId);
      if (!thread) return;
      try {
        threads.unobserveThreadRecords(threadId);
      } catch {
        // Runtime may have gone offline while the thread tab was idle.
      }
    }, threadRecordObservationIdleMs());
    timer.unref?.();
    threadRecordObservationTimers.set(threadId, timer);
  }

  const runtimeSessionsForProject = (target: { machineId: string; path: string }) => {
    const sessions = threads.listRuntimeSessions({ includeOffline: true })
      .filter((session) => session.machineId === target.machineId && session.workingDirectory === target.path);
    return [...new Map(sessions.map((session) => [session.sessionId, session])).values()];
  };

  const stopProjectRuntimeSessions = async (target: { machineId: string; path: string }) => {
    const sessions = runtimeSessionsForProject(target);
    return await Promise.all(sessions.map(async (session) => {
      if (!session.online) {
        threads.unregisterWorker(session.sessionId);
        return {
          machineId: target.machineId,
          sessionId: session.sessionId,
          stopped: false,
          removed: true,
          reason: "session_offline"
        };
      }
      try {
        const command = machines.stopSession(target.machineId, { sessionId: session.sessionId });
        const result = await command.promise;
        if (!result.stopped) threads.unregisterWorker(session.sessionId);
        return {
          machineId: target.machineId,
          sessionId: session.sessionId,
          stopped: result.stopped,
          removed: true,
          cwd: result.cwd,
          reason: result.stopped ? undefined : "session_not_found"
        };
      } catch (error) {
        return {
          machineId: target.machineId,
          sessionId: session.sessionId,
          stopped: false,
          removed: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }));
  };

  function taskSnapshotEvent() {
    return {
      seq: taskSeq,
      kind: "tasks" as const,
      tasks: state.listTasks()
    };
  }

  function publishTasks() {
    const event = {
      seq: ++taskSeq,
      kind: "tasks" as const,
      tasks: state.listTasks()
    };
    for (const subscriber of taskSubscribers) subscriber(event);
  }

  function connectionSnapshotEvent() {
    return {
      seq: connectionSeq,
      kind: "connections" as const,
      connections: features.ssh ? sshMachines.listConnections() : []
    };
  }

  function publishConnections() {
    const event = {
      seq: ++connectionSeq,
      kind: "connections" as const,
      connections: sshMachines.listConnections()
    };
    for (const subscriber of connectionSubscribers) subscriber(event);
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

  async function waitForRuntimeSession(sessionId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const session = threads.listWorkers({ includeOffline: true }).find((worker) => worker.workerId === sessionId);
      if (session?.online) return session;
      await delay(50);
    }
    throw new Error(`Session did not register: ${sessionId}`);
  }

  async function runLocalTask(taskId: string) {
    if (!features.tasks) throw new Error("Tasks are disabled for this codexhub surface.");
    const task = state.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (runningTasks.has(task.taskId)) {
      const skippedTask = state.updateTaskRun(task.taskId, {
        lastStatus: "skipped",
        lastError: "Task already running"
      });
      publishTasks();
      return {
        ok: true,
        skipped: true,
        task: skippedTask
      };
    }
    let releaseOnReturn = true;
    runningTasks.add(task.taskId);
    try {
      const started = machines.startSession(task.machineId, {
        cwd: task.projectPath,
        reuse: true
      });
      const session = await started.promise;
      const sessionId = session.sessionId;
      await waitForRuntimeSession(sessionId);
      let threadId = task.threadId ?? session.threadId;
      if (task.threadId) {
        const resumed = await threads.resumeWorkerThread(sessionId, task.threadId);
        threadId = resumed.threadId;
      } else {
        threads.attachWorkerThread(sessionId, threadId);
      }
      const localCommand = threads.runLocalCommand(threadId, task.input, "task");
      if (localCommand.handled) {
        const completedTask = state.updateTaskRun(task.taskId, {
          lastStatus: "completed",
          threadId
        });
        publishTasks();
        return {
          ok: true,
          task: completedTask,
          sessionId,
          threadId,
          command: localCommand.command
        };
      }
      const turn = threads.runTurn(threadId, task.input, "task");
      const queuedTask = state.updateTaskRun(task.taskId, {
        lastStatus: "queued",
        threadId
      });
      publishTasks();
      releaseOnReturn = false;
      turn.then(() => {
        state.updateTaskRun(task.taskId, {
          lastStatus: "completed",
          threadId
        });
        publishTasks();
      }).catch((error: unknown) => {
        state.updateTaskRun(task.taskId, {
          lastStatus: "failed",
          threadId,
          lastError: error instanceof Error ? error.message : String(error)
        });
        publishTasks();
      }).finally(() => {
        runningTasks.delete(task.taskId);
      });
      return {
        ok: true,
        task: queuedTask,
        sessionId,
        threadId
      };
    } catch (error) {
      state.updateTaskRun(task.taskId, {
        lastStatus: "failed",
        lastError: error instanceof Error ? error.message : String(error)
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
      triggeredTaskMinutes.set(task.taskId, minuteKey);
      void runLocalTask(task.taskId)
        .catch((error: unknown) => {
          console.error(`codexhub task failed: ${task.name}: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  }

  async function startBuiltinIntegrations() {
    if (!features.integrations) {
      plugins.setIntegrationState(telegramIntegrationType, telegramPluginRuntimeState(false));
      return;
    }
    plugins.setIntegrationState(telegramIntegrationType, telegramPluginRuntimeState(false));
    if (await plugins.hasEnabledBuiltinIntegration(telegramIntegrationType)) {
      telegramBot = await startTelegramPlugin({
        apiBaseUrl: localApiBaseUrl(config.host, config.port),
        requireToken: false
      });
      plugins.setIntegrationState(telegramIntegrationType, telegramPluginRuntimeState(Boolean(telegramBot)));
    }
  }

  app.get("/api/health", async () => ({
    ok: true,
    env: process.env.CODEX_HUB_ENV ?? process.env.NODE_ENV ?? "development",
    build: process.env.CODEX_HUB_BUILD_ID ?? null,
    host: config.host,
    port: config.port,
    surface,
    features,
    staticDirectory,
    statePath: state.path,
    model: config.defaultThreadOptions.model ?? null,
    modelReasoningEffort: config.defaultThreadOptions.modelReasoningEffort ?? null,
    contextWindowTokens,
    ssh: {
      connections: sshMachines.listConnections()
    },
    telegram: {
      started: Boolean(telegramBot)
    }
  }));

  app.get("/api/threads", async () => ({
    ...threads.markStaleWorkersOffline(sessionOfflineTimeoutMs(), Date.now(), sessionOfflineRetentionMs()),
    threads: threads.listThreads()
  }));

  app.get("/api/sessions", async (request) => {
    const query = z.object({ includeOffline: z.string().optional() }).parse(request.query);
    return {
      ...threads.markStaleWorkersOffline(sessionOfflineTimeoutMs(), Date.now(), sessionOfflineRetentionMs()),
      sessions: threads.listRuntimeSessions({ includeOffline: query.includeOffline === "true" })
    };
  });

  app.get("/api/sessions/events", async (request, reply) => {
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);
    threads.markStaleWorkersOffline(sessionOfflineTimeoutMs(), Date.now(), sessionOfflineRetentionMs());

    const stopSse = startSse(reply.raw);

    const unsubscribe = threads.subscribeRuntimeSessions(query.after ?? 0, (event) => {
      sendSse(reply.raw, event.kind, event);
    });
    reply.raw.on("close", () => {
      stopSse();
      unsubscribe();
    });
  });

  app.get("/api/events", async (request, reply) => {
    const query = z.object({
      sessionsAfter: z.coerce.number().optional(),
      projectsAfter: z.coerce.number().optional(),
      tasksAfter: z.coerce.number().optional(),
      connectionsAfter: z.coerce.number().optional()
    }).parse(request.query);
    threads.markStaleWorkersOffline(sessionOfflineTimeoutMs(), Date.now(), sessionOfflineRetentionMs());

    const stopSse = startSse(reply.raw);
    const sessionsAfter = query.sessionsAfter ?? 0;
    const projectsAfter = query.projectsAfter ?? 0;
    const tasksAfter = query.tasksAfter ?? 0;
    const connectionsAfter = query.connectionsAfter ?? 0;

    const unsubscribeSessions = threads.subscribeRuntimeSessions(sessionsAfter, (event) => {
      sendSse(reply.raw, event.kind, event);
    });
    if (projectsAfter <= 0 || projectSeq > projectsAfter) sendSse(reply.raw, "projects", projectSnapshotEvent());
    if (tasksAfter <= 0 || taskSeq > tasksAfter) sendSse(reply.raw, "tasks", taskSnapshotEvent());
    if (connectionsAfter <= 0 || connectionSeq > connectionsAfter) sendSse(reply.raw, "connections", connectionSnapshotEvent());

    const projectSubscriber = (event: ReturnType<typeof projectSnapshotEvent>) => {
      if (event.seq > projectsAfter) sendSse(reply.raw, event.kind, event);
    };
    const taskSubscriber = (event: ReturnType<typeof taskSnapshotEvent>) => {
      if (event.seq > tasksAfter) sendSse(reply.raw, event.kind, event);
    };
    const connectionSubscriber = (event: ReturnType<typeof connectionSnapshotEvent>) => {
      if (event.seq > connectionsAfter) sendSse(reply.raw, event.kind, event);
    };
    projectSubscribers.add(projectSubscriber);
    taskSubscribers.add(taskSubscriber);
    connectionSubscribers.add(connectionSubscriber);
    reply.raw.on("close", () => {
      stopSse();
      unsubscribeSessions();
      projectSubscribers.delete(projectSubscriber);
      taskSubscribers.delete(taskSubscriber);
      connectionSubscribers.delete(connectionSubscriber);
    });
  });

  app.get("/api/events/ws", { websocket: true }, (socket) => {
    const threadUnsubscribers = new Map<string, () => void>();
    let unsubscribeSessions: (() => void) | null = null;
    let projectSubscriber: ((event: ReturnType<typeof projectSnapshotEvent>) => void) | null = null;
    let taskSubscriber: ((event: ReturnType<typeof taskSnapshotEvent>) => void) | null = null;
    let connectionSubscriber: ((event: ReturnType<typeof connectionSnapshotEvent>) => void) | null = null;

    const send = (message: unknown) => {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify(message));
    };

    const sendEvent = <T extends { kind: string }>(event: T) => {
      send({ type: event.kind, ...event });
    };

    const unsubscribeControl = () => {
      unsubscribeSessions?.();
      unsubscribeSessions = null;
      if (projectSubscriber) projectSubscribers.delete(projectSubscriber);
      if (taskSubscriber) taskSubscribers.delete(taskSubscriber);
      if (connectionSubscriber) connectionSubscribers.delete(connectionSubscriber);
      projectSubscriber = null;
      taskSubscriber = null;
      connectionSubscriber = null;
    };

    const subscribeControl = (input: Extract<z.infer<typeof webEventsMessageSchema>, { type: "hello" }>) => {
      unsubscribeControl();
      threads.markStaleWorkersOffline(sessionOfflineTimeoutMs(), Date.now(), sessionOfflineRetentionMs());

      const sessionsAfter = input.sessionsAfter ?? 0;
      const projectsAfter = input.projectsAfter ?? 0;
      const tasksAfter = input.tasksAfter ?? 0;
      const connectionsAfter = input.connectionsAfter ?? 0;

      unsubscribeSessions = threads.subscribeRuntimeSessions(sessionsAfter, (event) => {
        sendEvent(event);
      });
      if (projectsAfter <= 0 || projectSeq > projectsAfter) sendEvent(projectSnapshotEvent());
      if (tasksAfter <= 0 || taskSeq > tasksAfter) sendEvent(taskSnapshotEvent());
      if (connectionsAfter <= 0 || connectionSeq > connectionsAfter) sendEvent(connectionSnapshotEvent());

      projectSubscriber = (event) => {
        if (event.seq > projectsAfter) sendEvent(event);
      };
      taskSubscriber = (event) => {
        if (event.seq > tasksAfter) sendEvent(event);
      };
      connectionSubscriber = (event) => {
        if (event.seq > connectionsAfter) sendEvent(event);
      };
      projectSubscribers.add(projectSubscriber);
      taskSubscribers.add(taskSubscriber);
      connectionSubscribers.add(connectionSubscriber);
      send({ type: "ready" });
    };

    const subscribeThread = (threadId: string, after = 0) => {
      threadUnsubscribers.get(threadId)?.();
      threadUnsubscribers.delete(threadId);
      try {
        const unsubscribeStream = threads.subscribe(threadId, after, (event) => {
          sendEvent(event);
        });
        retainThreadRecordObservation(threadId);
        const unsubscribe = () => {
          unsubscribeStream();
          releaseThreadRecordObservation(threadId);
        };
        threadUnsubscribers.set(threadId, unsubscribe);
        send({ type: "thread_subscribed", threadId });
      } catch (error) {
        send({
          type: "error",
          scope: "thread",
          threadId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };

    const unsubscribeThread = (threadId: string) => {
      threadUnsubscribers.get(threadId)?.();
      threadUnsubscribers.delete(threadId);
      send({ type: "thread_unsubscribed", threadId });
    };

    const closeSubscriptions = () => {
      unsubscribeControl();
      for (const unsubscribe of threadUnsubscribers.values()) unsubscribe();
      threadUnsubscribers.clear();
    };

    const handleMessage = (data: unknown) => {
      let parsed: z.infer<typeof webEventsMessageSchema>;
      try {
        parsed = webEventsMessageSchema.parse(JSON.parse(String(data)));
      } catch (error) {
        send({ type: "error", message: `invalid web events message: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }

      if (parsed.type === "hello") {
        subscribeControl(parsed);
        return;
      }
      if (parsed.type === "subscribe_thread") {
        subscribeThread(parsed.threadId, parsed.after ?? 0);
        return;
      }
      if (parsed.type === "unsubscribe_thread") {
        unsubscribeThread(parsed.threadId);
      }
    };

    socket.on("message", (data: unknown) => handleMessage(data));
    socket.on("close", closeSubscriptions);
  });

  app.get("/api/sessions/:sessionId/thread-candidates", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);
    try {
      return await threads.listWorkerThreadCandidates(params.sessionId, query.limit ?? 50);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Session not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/sessions/:sessionId/threads", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const payload = z.discriminatedUnion("action", [
      z.object({ action: z.literal("new") }),
      z.object({ action: z.literal("resume"), threadId: z.string().min(1) })
    ]).parse(request.body);
    try {
      const thread = payload.action === "new"
        ? await threads.startWorkerThread(params.sessionId)
        : await threads.resumeWorkerThread(params.sessionId, payload.threadId);
      publishProjects();
      return thread;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Session not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/sessions/:sessionId/turn", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const payload = z.object({
      threadId: z.string().min(1),
      input: inputSchema,
      source: z.enum(["web", "telegram", "task"]).optional(),
      options: threadRunOptionsSchema.optional()
    }).parse(request.body);

    try {
      const result = threads.runWorkerThreadTurn(params.sessionId, payload.threadId, payload.input, payload.source ?? "web", payload.options);
      result.promise.catch(() => undefined);
      return { ok: true, thread: result.thread, command: result.command };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Session not found:") || message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.get("/api/machines", async () => ({
    machines: machines.listMachines()
  }));

  app.get("/api/ssh/config-hosts", async () => ({
    hosts: features.ssh ? await listSshHosts() : []
  }));

  app.get("/api/ssh/hosts", async () => ({
    hosts: await listCodexhubSshHosts()
  }));

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
    };
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
    };
  });

  app.get("/api/ssh/connections", async () => ({
    connections: features.ssh ? sshMachines.listConnections() : []
  }));

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

  app.get("/api/ssh/connections/events", async (request, reply) => {
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);
    const stopSse = startSse(reply.raw);
    const after = query.after ?? 0;
    if (after <= 0 || connectionSeq > after) sendSse(reply.raw, "connections", connectionSnapshotEvent());
    const subscriber = (event: ReturnType<typeof connectionSnapshotEvent>) => {
      if (event.seq > after) sendSse(reply.raw, event.kind, event);
    };
    connectionSubscribers.add(subscriber);
    reply.raw.on("close", () => {
      stopSse();
      connectionSubscribers.delete(subscriber);
    });
  });

  app.get("/api/plugins", async () => ({
    plugins: await plugins.listPlugins()
  }));

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
      };
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
      };
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
      return await command.promise;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/projects", async () => projectSnapshot());

  app.get("/api/projects/events", async (request, reply) => {
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);
    const stopSse = startSse(reply.raw);
    const after = query.after ?? 0;
    if (after <= 0) sendSse(reply.raw, "projects", projectSnapshotEvent());
    const subscriber = (event: ReturnType<typeof projectSnapshotEvent>) => {
      if (event.seq > after) sendSse(reply.raw, event.kind, event);
    };
    projectSubscribers.add(subscriber);
    reply.raw.on("close", () => {
      stopSse();
      projectSubscribers.delete(subscriber);
    });
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const target = state.projectDeleteTarget(params.projectId);
    const deleted = state.deleteProject(params.projectId);
    const existingSessions = target ? runtimeSessionsForProject(target) : [];
    if (!deleted && existingSessions.length === 0) {
      reply.code(404);
      return { error: `Project not found: ${params.projectId}` };
    }
    if (deleted) publishProjects();
    const stoppedSessions = target ? await stopProjectRuntimeSessions(target) : [];
    publishProjects();
    return { ok: true, deleted, stoppedSessions, ...projectSnapshot() };
  });

  app.post("/api/projects/open", async (request, reply) => {
    const payload = z.object({
      machineId: z.string().min(1).optional(),
      path: z.string().min(1),
      reuse: z.boolean().optional()
    }).parse(request.body);

    try {
      const machine = resolveTargetMachine(machines.listMachines(), payload.machineId);
      const started = machines.startSession(machine.machineId, {
        cwd: payload.path,
        reuse: payload.reuse ?? true
      });
      const result = await started.promise;
      const sessionId = result.sessionId;
      await waitForRuntimeSession(sessionId);
      threads.attachWorkerThread(sessionId, result.threadId);
      const project = state.upsertProject({
        machineId: machine.machineId,
        path: result.cwd,
        sessionId,
        threadId: result.threadId
      });
      publishProjects();
      return { ok: true, machine, project, result, ...projectSnapshot() };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/tasks", async () => ({
    tasks: state.listTasks()
  }));

  app.get("/api/tasks/events", async (request, reply) => {
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);
    const stopSse = startSse(reply.raw);
    const after = query.after ?? 0;
    if (after <= 0 || taskSeq > after) sendSse(reply.raw, "tasks", taskSnapshotEvent());
    const subscriber = (event: ReturnType<typeof taskSnapshotEvent>) => {
      if (event.seq > after) sendSse(reply.raw, event.kind, event);
    };
    taskSubscribers.add(subscriber);
    reply.raw.on("close", () => {
      stopSse();
      taskSubscribers.delete(subscriber);
    });
  });

  app.post("/api/tasks", async (request, reply) => {
    const payload = taskCreateSchema.parse(request.body);
    try {
      const task = state.upsertTask({
        taskId: randomUUID(),
        name: payload.name,
        enabled: payload.enabled ?? true,
        schedule: payload.schedule,
        machineId: payload.machineId,
        projectId: payload.projectId,
        projectPath: payload.projectPath,
        threadId: payload.threadId,
        input: payload.input
      });
      publishTasks();
      return { ok: true, task };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.patch("/api/tasks/:taskId", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const payload = taskUpdateSchema.parse(request.body);
    const existing = state.getTask(params.taskId);
    if (!existing) {
      reply.code(404);
      return { error: "task_not_found" };
    }
    try {
      const task = state.upsertTask({
        ...existing,
        ...payload,
        taskId: existing.taskId,
        name: payload.name ?? existing.name,
        enabled: payload.enabled ?? existing.enabled,
        schedule: payload.schedule ?? existing.schedule,
        machineId: payload.machineId ?? existing.machineId,
        projectPath: payload.projectPath ?? existing.projectPath,
        input: payload.input ?? existing.input,
        projectId: payload.projectId ?? existing.projectId,
        threadId: payload.threadId ?? existing.threadId,
        createdAt: existing.createdAt
      });
      publishTasks();
      return { ok: true, task };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.delete("/api/tasks/:taskId", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    if (!state.deleteTask(params.taskId)) {
      reply.code(404);
      return { error: "task_not_found" };
    }
    publishTasks();
    return { ok: true, deleted: true };
  });

  app.post("/api/tasks/:taskId/run", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    try {
      return await runLocalTask(params.taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Task not found:") ? 404 : 409);
      return { error: message };
    }
  });

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
        const response = await threads.waitWorkerCommands(sessionId, sessionCursors.get(sessionId) ?? 0, 60_000);
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
        threads.disconnectWorker(sessionId, sessionTransportId(sessionId));
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
          machineId = result.machineId;
          commandCursor = machines.clampMachineCommandCursor(machineId, parsed.commandCursor ?? 0);
          send({ type: "registered", machineId, machine: result.machine });
          publishProjects();
          startCommandPump();
          return;
        }

        if (parsed.type === "unregister") {
          machines.unregisterMachine(machineId!, transportId);
          for (const sessionId of [...sessionIds]) {
            threads.unregisterWorker(sessionId, sessionTransportId(sessionId));
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
          const { currentThreadId: _legacyCurrentThreadId, ...registration } = parsed.registration;
          const result = threads.registerWorker({
            ...registration,
            workerId: parsed.sessionId,
            machineId: machineId!,
            transportId: sessionTransportId(parsed.sessionId)
          });
          sessionIds.add(result.workerId);
          sessionCursors.set(result.workerId, threads.clampWorkerCommandCursor(result.workerId, parsed.commandCursor ?? 0));
          send({ type: "session_registered", sessionId: result.workerId, session: runtimeSessionFromWorker(result.worker) });
          refreshRetainedThreadRecordObservations();
          publishProjects();
          startSessionCommandPump(result.workerId);
          return;
        }

        if (parsed.type === "session_unregister") {
          threads.unregisterWorker(parsed.sessionId, sessionTransportId(parsed.sessionId));
          sessionIds.delete(parsed.sessionId);
          sessionCursors.delete(parsed.sessionId);
          publishProjects();
          return;
        }

        if (parsed.type === "session_heartbeat") {
          const { currentThreadId: _legacyCurrentThreadId, ...registration } = parsed.registration ?? {};
          threads.heartbeatWorker(parsed.sessionId, registration);
          return;
        }

        if (parsed.type === "session_event") {
          threads.applyWorkerEvent(parsed.sessionId, parsed.event);
          return;
        }

        if (parsed.type === "session_records") {
          threads.applyWorkerRecords(parsed.sessionId, parsed.records);
          return;
        }

        if (parsed.type === "session_command_result") {
          threads.resolveWorkerCommand(parsed.sessionId, parsed.commandId, parsed.result);
          return;
        }

        if (parsed.type === "session_command_error") {
          threads.failWorkerCommand(parsed.sessionId, parsed.commandId, parsed.message);
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
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };

    socket.on("message", (data: unknown) => void handleMessage(data));
    socket.on("close", () => {
      closed = true;
      disconnectSessions();
      if (machineId) {
        machines.disconnectMachine(machineId, transportId);
        publishProjects();
      }
    });
    socket.on("error", () => {
      closed = true;
      disconnectSessions();
      if (machineId) {
        machines.disconnectMachine(machineId, transportId);
        publishProjects();
      }
    });
  });

  app.get("/api/threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const thread = threads.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { error: "thread_not_found" };
    }
    return thread;
  });

  app.delete("/api/threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      forceReleaseThreadRecordObservation(params.threadId);
      return await threads.deleteThread(params.threadId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/threads/:threadId/fork", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ messageId: z.string().min(1) }).parse(request.body);
    try {
      return await threads.forkThread(params.threadId, payload.messageId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/threads/:threadId/rollback", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({ messageId: z.string().min(1) }).parse(request.body);
    try {
      return await threads.rollbackThreadAfterRecord(params.threadId, payload.messageId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/threads/:threadId/turn", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const payload = z.object({
      input: inputSchema,
      source: z.enum(["web", "telegram", "task"]).optional(),
      options: threadRunOptionsSchema.optional()
    }).parse(request.body);

    try {
      const command = threads.runLocalCommand(params.threadId, payload.input, payload.source ?? "web");
      if (command.handled) return { ok: true, command: command.command };
      threads.runTurn(params.threadId, payload.input, payload.source ?? "web", payload.options).catch(() => undefined);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.startsWith("Thread not found:") ? 404 : 409);
      return { error: message };
    }
  });

  app.post("/api/threads/:threadId/stop", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    try {
      return threads.stopTurn(params.threadId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/threads/:threadId/events", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).parse(request.params);
    const query = z.object({ after: z.coerce.number().optional() }).parse(request.query);

    const stopSse = startSse(reply.raw);

    try {
      const unsubscribe = threads.subscribe(params.threadId, query.after ?? 0, (event) => {
        sendSse(reply.raw, event.kind, event);
      });
      reply.raw.on("close", () => {
        stopSse();
        unsubscribe();
      });
    } catch (error) {
      stopSse();
      sendSse(reply.raw, "error", { error: error instanceof Error ? error.message : String(error) });
      reply.raw.end();
    }
  });

  if (staticDirectory) registerStaticRoutes(app, staticDirectory);

  await app.listen({ host: config.host, port: config.port });

  if (features.ssh) await autoConnectSavedSshHosts("startup");

  if (features.localMachine) {
    localMachine = startCodexhubMachine({
      apiBase: localApiBaseUrl(config.host, config.port),
      machineId: process.env.CODEX_HUB_LOCAL_MACHINE_ID,
      type: "local",
      name: process.env.CODEX_HUB_LOCAL_MACHINE_NAME || "This Computer"
    });
  }

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
    stop: () => app.close()
  };
};

const resolveTargetMachine = (
  allMachines: Array<{ machineId: string; online: boolean }>,
  requestedMachineId: string | undefined
) => {
  const onlineMachines = allMachines.filter((machine) => machine.online);
  if (requestedMachineId) {
    const machine = onlineMachines.find((item) => item.machineId === requestedMachineId);
    if (!machine) throw new Error(`Machine is offline or not found: ${requestedMachineId}`);
    return machine;
  }
  if (onlineMachines.length === 1) return onlineMachines[0];
  if (onlineMachines.length === 0) throw new Error("No online codexhub machine.");
  throw new Error("Multiple online machines. Choose one before opening a project.");
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

const threadRecordObservationIdleMs = () => {
  const value = Number(process.env.CODEX_HUB_THREAD_RECORD_OBSERVATION_IDLE_MS);
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
