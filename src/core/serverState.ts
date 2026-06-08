import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { MachineCapabilities, MachineSummary, MachineType } from "./machineHub.js";
import { createMachineId, normalizeMachineCapabilities, normalizeMachineType } from "./machineHub.js";
import { runtimeSessionFromWorker, type RuntimeSessionSummary, type ThreadSummary, type WorkerSummary as InternalWorkerSummary } from "./threadHub.js";

export type StoredMachine = {
  machineId: string;
  type: MachineType;
  name?: string;
  hostname: string;
  lastSeenAt: string;
  capabilities: MachineCapabilities;
};

export type StoredProject = {
  projectId: string;
  machineId: string;
  path: string;
  name: string;
  pinned?: boolean;
  createdAt: string;
  lastOpenedAt: string;
  lastSessionId?: string;
  lastThreadId?: string;
};

export type StoredThreadSummary = {
  threadId: string;
  projectId: string;
  title: string;
  updatedAt: string;
  status: "running" | "idle";
  messageCount: number;
};

export type StoredTask = {
  taskId: string;
  name: string;
  enabled: boolean;
  schedule: string;
  machineId: string;
  projectPath: string;
  projectId?: string;
  threadId?: string;
  input: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: "queued" | "completed" | "failed" | "skipped";
  lastError?: string;
};

export type StoredSshHost = {
  alias: string;
  createdAt: string;
  updatedAt: string;
};

export type ServerStateData = {
  version: 1;
  updatedAt: string;
  machines: StoredMachine[];
  projects: StoredProject[];
  threads: StoredThreadSummary[];
  tasks: StoredTask[];
  sshHosts: StoredSshHost[];
};

export type ProjectSummary = StoredProject & {
  machine?: MachineSummary | StoredMachine;
  online: boolean;
  running: boolean;
  sessions: RuntimeSessionSummary[];
  threads: ThreadSummary[];
  storedThreads: StoredThreadSummary[];
};

type RuntimeSnapshot = {
  machines: MachineSummary[];
  runtimeSessions: InternalWorkerSummary[];
  threads: ThreadSummary[];
};

export class CodexhubServerState {
  private saveTimer: NodeJS.Timeout | null = null;
  private lastSavedText = "";

  private constructor(
    readonly filePath: string,
    private data: ServerStateData
  ) {}

  static async load(options: { dataDir?: string; filePath?: string } = {}) {
    const filePath = options.filePath
      ? path.resolve(options.filePath)
      : path.join(options.dataDir ? path.resolve(options.dataDir) : defaultDataDir(), "server-state.yaml");
    const data = await readStateFile(filePath);
    const state = new CodexhubServerState(filePath, data);
    state.lastSavedText = YAML.stringify(data);
    return state;
  }

  get path() {
    return this.filePath;
  }

  listStoredMachines() {
    return [...this.data.machines].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  listStoredProjects() {
    return [...this.data.projects].sort(compareStoredProjects);
  }

  deleteProject(projectId: string) {
    const index = this.data.projects.findIndex((project) => project.projectId === projectId);
    if (index === -1) return false;
    this.data.projects.splice(index, 1);
    this.data.threads = this.data.threads.filter((thread) => thread.projectId !== projectId);
    this.touch();
    return true;
  }

  listTasks() {
    return [...this.data.tasks].sort(compareTasks);
  }

  listSshHosts() {
    return [...this.data.sshHosts].sort(compareStoredSshHosts);
  }

  upsertSshHost(input: { alias: string; createdAt?: string; updatedAt?: string }) {
    const alias = input.alias.trim();
    if (!alias) throw new Error("SSH host alias is required.");
    const existing = this.data.sshHosts.find((host) => host.alias === alias);
    if (existing) return existing;
    const now = input.updatedAt ?? new Date().toISOString();
    const host: StoredSshHost = {
      alias,
      createdAt: input.createdAt ?? now,
      updatedAt: now
    };
    this.data.sshHosts.push(host);
    this.touch();
    return host;
  }

  deleteSshHost(alias: string) {
    const index = this.data.sshHosts.findIndex((host) => host.alias === alias);
    if (index === -1) return false;
    this.data.sshHosts.splice(index, 1);
    this.touch();
    return true;
  }

  getTask(taskId: string) {
    return this.data.tasks.find((task) => task.taskId === taskId) ?? null;
  }

  upsertTask(input: Omit<StoredTask, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
    const now = input.updatedAt ?? new Date().toISOString();
    const projectId = input.projectId ?? projectIdFor(input.machineId, input.projectPath);
    const existing = this.data.tasks.find((task) => task.taskId === input.taskId);
    if (existing) {
      Object.assign(existing, {
        ...input,
        projectId,
        updatedAt: now
      });
      this.touch();
      return existing;
    }
    const task: StoredTask = {
      ...input,
      projectId,
      createdAt: input.createdAt ?? now,
      updatedAt: now
    };
    this.data.tasks.push(task);
    this.touch();
    return task;
  }

  updateTaskRun(taskId: string, input: Pick<StoredTask, "lastStatus"> & {
    lastRunAt?: string;
    threadId?: string;
    lastError?: string;
  }) {
    const task = this.data.tasks.find((item) => item.taskId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.lastStatus = input.lastStatus;
    task.lastRunAt = input.lastRunAt ?? new Date().toISOString();
    task.threadId = input.threadId ?? task.threadId;
    task.lastError = input.lastError;
    task.updatedAt = new Date().toISOString();
    this.touch();
    return task;
  }

  deleteTask(taskId: string) {
    const index = this.data.tasks.findIndex((task) => task.taskId === taskId);
    if (index === -1) return false;
    this.data.tasks.splice(index, 1);
    this.touch();
    return true;
  }

  upsertMachine(input: {
    machineId: string;
    hostname: string;
    type?: MachineType;
    name?: string;
    lastSeenAt?: string;
    capabilities?: Partial<MachineCapabilities>;
    touchLastSeenAt?: boolean;
  }) {
    const now = input.lastSeenAt ?? new Date().toISOString();
    const existing = this.data.machines.find((machine) => machine.machineId === input.machineId);
    if (existing) {
      const next = {
        type: normalizeMachineType(input.type, existing.type),
        hostname: input.hostname || existing.hostname,
        name: input.name ?? existing.name,
        lastSeenAt: input.touchLastSeenAt === false ? existing.lastSeenAt : maxIso(existing.lastSeenAt, now),
        capabilities: normalizeMachineCapabilities(input.capabilities, existing.capabilities)
      };
      if (
        existing.type === next.type
        && existing.hostname === next.hostname
        && existing.name === next.name
        && existing.lastSeenAt === next.lastSeenAt
        && machineCapabilitiesEqual(existing.capabilities, next.capabilities)
      ) {
        return;
      }
      existing.type = next.type;
      existing.hostname = next.hostname;
      existing.name = next.name;
      existing.lastSeenAt = next.lastSeenAt;
      existing.capabilities = next.capabilities;
    } else {
      this.data.machines.push({
        machineId: input.machineId,
        type: normalizeMachineType(input.type),
        name: input.name,
        hostname: input.hostname,
        lastSeenAt: now,
        capabilities: normalizeMachineCapabilities(input.capabilities)
      });
    }
    this.touch();
  }

  upsertProject(input: {
    machineId: string;
    path: string;
    name?: string;
    now?: string;
    sessionId?: string;
    threadId?: string;
    touchOpenedAt?: boolean;
  }) {
    const now = input.now ?? new Date().toISOString();
    const normalizedPath = input.path.trim();
    if (!normalizedPath) throw new Error("Project path is required.");
    const projectId = projectIdFor(input.machineId, normalizedPath);
    const existing = this.data.projects.find((project) => project.projectId === projectId);
    if (existing) {
      const next = {
        name: input.name ?? existing.name,
        lastOpenedAt: input.touchOpenedAt === false ? existing.lastOpenedAt : maxIso(existing.lastOpenedAt, now),
        lastSessionId: input.sessionId ?? existing.lastSessionId,
        lastThreadId: input.threadId ?? existing.lastThreadId
      };
      if (
        existing.name === next.name
        && existing.lastOpenedAt === next.lastOpenedAt
        && existing.lastSessionId === next.lastSessionId
        && existing.lastThreadId === next.lastThreadId
      ) {
        return existing;
      }
      existing.name = next.name;
      existing.lastOpenedAt = next.lastOpenedAt;
      existing.lastSessionId = next.lastSessionId;
      existing.lastThreadId = next.lastThreadId;
      this.touch();
      return existing;
    }
    const project: StoredProject = {
      projectId,
      machineId: input.machineId,
      path: normalizedPath,
      name: input.name ?? projectName(normalizedPath),
      createdAt: now,
      lastOpenedAt: now,
      lastSessionId: input.sessionId,
      lastThreadId: input.threadId
    };
    this.data.projects.push(project);
    this.touch();
    return project;
  }

  captureRuntime(snapshot: Pick<RuntimeSnapshot, "runtimeSessions" | "threads">) {
    const runtimeSessionsById = new Map(snapshot.runtimeSessions.map((session) => [session.workerId, session]));
    for (const session of snapshot.runtimeSessions) {
      const machineId = machineIdForRuntimeSession(session);
      this.upsertMachine({
        machineId,
        hostname: session.hostname ?? machineId,
        name: session.hostname,
        lastSeenAt: session.lastSeenAt,
        touchLastSeenAt: false,
        capabilities: session.machineId ? undefined : { projectLauncher: false }
      });
      this.upsertProject({
        machineId,
        path: session.workingDirectory,
        sessionId: session.workerId,
        now: session.lastSeenAt,
        touchOpenedAt: false
      });
    }

    for (const thread of snapshot.threads) {
      const session = thread.runtime.sessionId ? runtimeSessionsById.get(thread.runtime.sessionId) : undefined;
      const project = session
        ? this.upsertProject({
          machineId: machineIdForRuntimeSession(session),
          path: thread.workingDirectory,
          sessionId: session.workerId,
          threadId: thread.threadId,
          now: thread.updatedAt
        })
        : this.uniqueProjectForPath(thread.workingDirectory);
      if (!project) continue;
      this.upsertThread(project.projectId, thread);
    }
  }

  snapshot(runtime: RuntimeSnapshot) {
    const machinesById = new Map<string, MachineSummary | StoredMachine>();
    for (const machine of this.data.machines) machinesById.set(machine.machineId, machine);
    for (const machine of runtime.machines) machinesById.set(machine.machineId, machine);
    const sessionsByProject = new Map<string, InternalWorkerSummary[]>();
    for (const session of runtime.runtimeSessions) {
      const projectId = projectIdFor(machineIdForRuntimeSession(session), session.workingDirectory);
      const sessions = sessionsByProject.get(projectId) ?? [];
      sessions.push(session);
      sessionsByProject.set(projectId, sessions);
    }
    const threadsByProject = new Map<string, ThreadSummary[]>();
    for (const thread of runtime.threads) {
      const session = thread.runtime.sessionId
        ? runtime.runtimeSessions.find((item) => item.workerId === thread.runtime.sessionId)
        : undefined;
      const project = session
        ? this.findProject(machineIdForRuntimeSession(session), thread.workingDirectory)
        : this.uniqueProjectForPath(thread.workingDirectory);
      if (!project) continue;
      const threads = threadsByProject.get(project.projectId) ?? [];
      threads.push(thread);
      threadsByProject.set(project.projectId, threads);
    }
    const storedThreadsByProject = new Map<string, StoredThreadSummary[]>();
    for (const thread of this.data.threads) {
      const threads = storedThreadsByProject.get(thread.projectId) ?? [];
      threads.push(thread);
      storedThreadsByProject.set(thread.projectId, threads);
    }

    const projects: ProjectSummary[] = this.listStoredProjects().map((project) => {
      const sessions = (sessionsByProject.get(project.projectId) ?? [])
        .sort((left, right) => Number(right.online) - Number(left.online) || right.lastSeenAt.localeCompare(left.lastSeenAt));
      const threads = (threadsByProject.get(project.projectId) ?? [])
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const storedThreads = (storedThreadsByProject.get(project.projectId) ?? [])
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const machine = machinesById.get(project.machineId);
      return {
        ...project,
        machine,
        online: sessions.some((session) => session.online) || Boolean(machine && "online" in machine && machine.online),
        running: threads.some((thread) => thread.running || thread.status === "running"),
        sessions: sessions.map(runtimeSessionFromWorker),
        threads,
        storedThreads
      };
    });

    return {
      statePath: this.filePath,
      machines: [...machinesById.values()].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)),
      projects
    };
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }

  private findProject(machineId: string, projectPath: string) {
    const projectId = projectIdFor(machineId, projectPath);
    return this.data.projects.find((project) => project.projectId === projectId);
  }

  private uniqueProjectForPath(projectPath: string) {
    const projects = this.data.projects.filter((project) => project.path === projectPath);
    return projects.length === 1 ? projects[0] : null;
  }

  private upsertThread(projectId: string, thread: ThreadSummary) {
    const existing = this.data.threads.find((item) => item.threadId === thread.threadId);
    const summary: StoredThreadSummary = {
      threadId: thread.threadId,
      projectId,
      title: thread.title,
      updatedAt: thread.updatedAt,
      status: thread.status,
      messageCount: thread.messageCount
    };
    let changed = false;
    if (existing) {
      changed = !storedThreadEqual(existing, summary);
      if (changed) Object.assign(existing, summary);
    } else {
      this.data.threads.push(summary);
      changed = true;
    }
    const project = this.data.projects.find((item) => item.projectId === projectId);
    if (project) {
      const nextLastOpenedAt = maxIso(project.lastOpenedAt, thread.updatedAt);
      if (project.lastThreadId !== thread.threadId || project.lastOpenedAt !== nextLastOpenedAt) {
        project.lastThreadId = thread.threadId;
        project.lastOpenedAt = nextLastOpenedAt;
        changed = true;
      }
    }
    if (changed) this.touch();
  }

  private touch() {
    this.data.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().catch((error: unknown) => {
        console.error(`codexhub state save failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 750);
    this.saveTimer.unref?.();
  }

  private async save() {
    const text = YAML.stringify(this.data);
    if (text === this.lastSavedText) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, text, "utf8");
    await rename(tmpPath, this.filePath);
    this.lastSavedText = text;
  }
}

export const machineIdForRuntimeSession = (session: Pick<InternalWorkerSummary, "machineId" | "hostname">) =>
  session.machineId ?? createMachineId(session.hostname ?? "local");

const defaultDataDir = () =>
  path.resolve(process.env.CODEX_HUB_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "codexhub"));

const readStateFile = async (filePath: string): Promise<ServerStateData> => {
  try {
    const parsed = YAML.parse(await readFile(filePath, "utf8")) as Partial<ServerStateData> | null;
    if (parsed?.version !== 1) return emptyState();
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      machines: Array.isArray(parsed.machines) ? parsed.machines.map(normalizeStoredMachine).filter(isStoredMachine) : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects.map(normalizeStoredProject).filter(isStoredProject) : [],
      threads: Array.isArray(parsed.threads) ? parsed.threads.filter(isStoredThread) : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeStoredTask).filter(isStoredTask) : [],
      sshHosts: Array.isArray(parsed.sshHosts) ? parsed.sshHosts.map(normalizeStoredSshHost).filter(isStoredSshHost) : []
    };
  } catch {
    return emptyState();
  }
};

const emptyState = (): ServerStateData => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  machines: [],
  projects: [],
  threads: [],
  tasks: [],
  sshHosts: []
});

const projectIdFor = (machineId: string, projectPath: string) =>
  `project-${createHash("sha256").update(`${machineId}\0${projectPath}`).digest("hex").slice(0, 16)}`;

const projectName = (projectPath: string) => path.basename(projectPath) || projectPath;

const maxIso = (left: string, right: string) => left.localeCompare(right) >= 0 ? left : right;

const normalizeStoredMachine = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  return {
    ...item,
    type: normalizeMachineType(item.type as MachineType | undefined),
    capabilities: normalizeMachineCapabilities(asMachineCapabilities(item.capabilities))
  };
};

const asMachineCapabilities = (value: unknown): Partial<MachineCapabilities> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<MachineCapabilities>;
  return {
    projectLauncher: typeof item.projectLauncher === "boolean" ? item.projectLauncher : undefined
  };
};

const machineCapabilitiesEqual = (left: MachineCapabilities, right: MachineCapabilities) =>
  left.projectLauncher === right.projectLauncher;

const storedThreadEqual = (left: StoredThreadSummary, right: StoredThreadSummary) =>
  left.threadId === right.threadId
  && left.projectId === right.projectId
  && left.title === right.title
  && left.updatedAt === right.updatedAt
  && left.status === right.status
  && left.messageCount === right.messageCount;

const normalizeStoredProject = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  return {
    projectId: item.projectId,
    machineId: item.machineId,
    path: item.path,
    name: item.name,
    pinned: item.pinned,
    createdAt: item.createdAt,
    lastOpenedAt: item.lastOpenedAt,
    lastSessionId: item.lastSessionId,
    lastThreadId: item.lastThreadId
  };
};

const normalizeStoredTask = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  const machineId = typeof item.machineId === "string" ? item.machineId : "";
  const projectPath = typeof item.projectPath === "string" ? item.projectPath : "";
  return {
    ...item,
    projectPath,
    projectId: typeof item.projectId === "string" ? item.projectId : machineId && projectPath ? projectIdFor(machineId, projectPath) : undefined
  };
};

const normalizeStoredSshHost = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  const now = new Date().toISOString();
  return {
    alias: typeof item.alias === "string" ? item.alias.trim() : "",
    createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now
  };
};

const compareStoredProjects = (left: StoredProject, right: StoredProject) => {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  const createdCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdCompare) return createdCompare;
  const nameCompare = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  if (nameCompare) return nameCompare;
  return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
};

const compareTasks = (left: StoredTask, right: StoredTask) => {
  if (Boolean(left.enabled) !== Boolean(right.enabled)) return left.enabled ? -1 : 1;
  const nameCompare = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  if (nameCompare) return nameCompare;
  return left.createdAt.localeCompare(right.createdAt);
};

const compareStoredSshHosts = (left: StoredSshHost, right: StoredSshHost) =>
  left.alias.localeCompare(right.alias, undefined, { sensitivity: "base" });

const isStoredMachine = (value: unknown): value is StoredMachine => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredMachine>;
  return typeof item.machineId === "string"
    && typeof item.hostname === "string"
    && typeof item.lastSeenAt === "string"
    && (item.type === "local" || item.type === "ssh" || item.type === "registered");
};

const isStoredProject = (value: unknown): value is StoredProject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredProject>;
  return typeof item.projectId === "string"
    && typeof item.machineId === "string"
    && typeof item.path === "string"
    && typeof item.name === "string"
    && typeof item.createdAt === "string"
    && typeof item.lastOpenedAt === "string";
};

const isStoredThread = (value: unknown): value is StoredThreadSummary => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredThreadSummary>;
  return typeof item.threadId === "string"
    && typeof item.projectId === "string"
    && typeof item.title === "string"
    && typeof item.updatedAt === "string"
    && (item.status === "running" || item.status === "idle")
    && typeof item.messageCount === "number";
};

const isStoredTask = (value: unknown): value is StoredTask => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredTask>;
  return typeof item.taskId === "string"
    && typeof item.name === "string"
    && typeof item.enabled === "boolean"
    && typeof item.schedule === "string"
    && typeof item.machineId === "string"
    && typeof item.projectPath === "string"
    && typeof item.input === "string"
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string"
    && (item.projectId === undefined || typeof item.projectId === "string")
    && (item.threadId === undefined || typeof item.threadId === "string")
    && (item.lastRunAt === undefined || typeof item.lastRunAt === "string")
    && (item.lastStatus === undefined || item.lastStatus === "queued" || item.lastStatus === "completed" || item.lastStatus === "failed" || item.lastStatus === "skipped")
    && (item.lastError === undefined || typeof item.lastError === "string");
};

const isStoredSshHost = (value: unknown): value is StoredSshHost => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredSshHost>;
  return typeof item.alias === "string"
    && item.alias.trim().length > 0
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string";
};
