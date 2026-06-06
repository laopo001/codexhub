import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { MachineSummary } from "./machineHub.js";
import { createMachineId } from "./machineHub.js";
import type { ThreadSummary, WorkerSummary } from "./threadHub.js";

export type StoredMachine = {
  machineId: string;
  name?: string;
  hostname: string;
  lastSeenAt: string;
};

export type StoredProject = {
  projectId: string;
  machineId: string;
  path: string;
  name: string;
  pinned?: boolean;
  createdAt: string;
  lastOpenedAt: string;
  lastWorkerId?: string;
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

export type ServerStateData = {
  version: 1;
  updatedAt: string;
  machines: StoredMachine[];
  projects: StoredProject[];
  threads: StoredThreadSummary[];
};

export type ProjectSummary = StoredProject & {
  machine?: MachineSummary | StoredMachine;
  online: boolean;
  running: boolean;
  workers: WorkerSummary[];
  threads: ThreadSummary[];
  storedThreads: StoredThreadSummary[];
};

type RuntimeSnapshot = {
  machines: MachineSummary[];
  workers: WorkerSummary[];
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

  upsertMachine(input: { machineId: string; hostname: string; name?: string; lastSeenAt?: string }) {
    const now = input.lastSeenAt ?? new Date().toISOString();
    const existing = this.data.machines.find((machine) => machine.machineId === input.machineId);
    if (existing) {
      existing.hostname = input.hostname || existing.hostname;
      existing.name = input.name ?? existing.name;
      existing.lastSeenAt = maxIso(existing.lastSeenAt, now);
    } else {
      this.data.machines.push({
        machineId: input.machineId,
        name: input.name,
        hostname: input.hostname,
        lastSeenAt: now
      });
    }
    this.touch();
  }

  upsertProject(input: {
    machineId: string;
    path: string;
    name?: string;
    now?: string;
    workerId?: string;
    threadId?: string;
  }) {
    const now = input.now ?? new Date().toISOString();
    const normalizedPath = input.path.trim();
    if (!normalizedPath) throw new Error("Project path is required.");
    const projectId = projectIdFor(input.machineId, normalizedPath);
    const existing = this.data.projects.find((project) => project.projectId === projectId);
    if (existing) {
      existing.name = input.name ?? existing.name;
      existing.lastOpenedAt = maxIso(existing.lastOpenedAt, now);
      existing.lastWorkerId = input.workerId ?? existing.lastWorkerId;
      existing.lastThreadId = input.threadId ?? existing.lastThreadId;
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
      lastWorkerId: input.workerId,
      lastThreadId: input.threadId
    };
    this.data.projects.push(project);
    this.touch();
    return project;
  }

  captureRuntime(snapshot: Pick<RuntimeSnapshot, "workers" | "threads">) {
    const workersById = new Map(snapshot.workers.map((worker) => [worker.workerId, worker]));
    for (const worker of snapshot.workers) {
      const machineId = machineIdForWorker(worker);
      this.upsertMachine({
        machineId,
        hostname: worker.hostname ?? machineId,
        name: worker.hostname,
        lastSeenAt: worker.lastSeenAt
      });
      this.upsertProject({
        machineId,
        path: worker.workingDirectory,
        workerId: worker.workerId,
        threadId: worker.currentThreadId,
        now: worker.lastSeenAt
      });
    }

    for (const thread of snapshot.threads) {
      const worker = thread.runtime.workerId ? workersById.get(thread.runtime.workerId) : undefined;
      const project = worker
        ? this.upsertProject({
          machineId: machineIdForWorker(worker),
          path: thread.workingDirectory,
          workerId: worker.workerId,
          threadId: thread.threadId,
          now: thread.updatedAt
        })
        : this.uniqueProjectForPath(thread.workingDirectory);
      if (!project) continue;
      this.upsertThread(project.projectId, thread);
    }
  }

  snapshot(runtime: RuntimeSnapshot) {
    for (const machine of runtime.machines) {
      this.upsertMachine({
        machineId: machine.machineId,
        hostname: machine.hostname,
        name: machine.name,
        lastSeenAt: machine.lastSeenAt
      });
    }
    this.captureRuntime({ workers: runtime.workers, threads: runtime.threads });

    const machinesById = new Map<string, MachineSummary | StoredMachine>();
    for (const machine of this.data.machines) machinesById.set(machine.machineId, machine);
    for (const machine of runtime.machines) machinesById.set(machine.machineId, machine);
    const workersByProject = new Map<string, WorkerSummary[]>();
    for (const worker of runtime.workers) {
      const projectId = projectIdFor(machineIdForWorker(worker), worker.workingDirectory);
      const workers = workersByProject.get(projectId) ?? [];
      workers.push(worker);
      workersByProject.set(projectId, workers);
    }
    const threadsByProject = new Map<string, ThreadSummary[]>();
    for (const thread of runtime.threads) {
      const worker = thread.runtime.workerId
        ? runtime.workers.find((item) => item.workerId === thread.runtime.workerId)
        : undefined;
      const project = worker
        ? this.findProject(machineIdForWorker(worker), thread.workingDirectory)
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
      const workers = (workersByProject.get(project.projectId) ?? [])
        .sort((left, right) => Number(right.online) - Number(left.online) || right.lastSeenAt.localeCompare(left.lastSeenAt));
      const threads = (threadsByProject.get(project.projectId) ?? [])
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const storedThreads = (storedThreadsByProject.get(project.projectId) ?? [])
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const machine = machinesById.get(project.machineId);
      return {
        ...project,
        machine,
        online: workers.some((worker) => worker.online) || Boolean(machine && "online" in machine && machine.online),
        running: workers.some((worker) => worker.currentThread?.running || worker.currentThread?.status === "running"),
        workers,
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
    if (existing) Object.assign(existing, summary);
    else this.data.threads.push(summary);
    const project = this.data.projects.find((item) => item.projectId === projectId);
    if (project) {
      project.lastThreadId = thread.threadId;
      project.lastOpenedAt = maxIso(project.lastOpenedAt, thread.updatedAt);
    }
    this.touch();
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

export const machineIdForWorker = (worker: Pick<WorkerSummary, "machineId" | "hostname">) =>
  worker.machineId ?? createMachineId(worker.hostname ?? "local");

const defaultDataDir = () =>
  path.resolve(process.env.CODEX_HUB_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "codexhub"));

const readStateFile = async (filePath: string): Promise<ServerStateData> => {
  try {
    const parsed = YAML.parse(await readFile(filePath, "utf8")) as (Partial<ServerStateData> & {
      agents?: unknown[];
    }) | null;
    if (parsed?.version !== 1) return emptyState();
    const legacyMachines = Array.isArray(parsed.agents)
      ? parsed.agents.map(legacyAgentToMachine).filter(isStoredMachine)
      : [];
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      machines: Array.isArray(parsed.machines) ? parsed.machines.filter(isStoredMachine) : legacyMachines,
      projects: Array.isArray(parsed.projects) ? parsed.projects.map(normalizeStoredProject).filter(isStoredProject) : [],
      threads: Array.isArray(parsed.threads) ? parsed.threads.filter(isStoredThread) : []
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
  threads: []
});

const projectIdFor = (machineId: string, projectPath: string) =>
  `project-${createHash("sha256").update(`${machineId}\0${projectPath}`).digest("hex").slice(0, 16)}`;

const projectName = (projectPath: string) => path.basename(projectPath) || projectPath;

const maxIso = (left: string, right: string) => left.localeCompare(right) >= 0 ? left : right;

const legacyAgentToMachine = (value: unknown): StoredMachine | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as { agentId?: unknown; name?: unknown; hostname?: unknown; lastSeenAt?: unknown };
  if (typeof item.agentId !== "string" || typeof item.hostname !== "string" || typeof item.lastSeenAt !== "string") return null;
  return {
    machineId: item.agentId,
    name: typeof item.name === "string" ? item.name : undefined,
    hostname: item.hostname,
    lastSeenAt: item.lastSeenAt
  };
};

const normalizeStoredProject = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (typeof item.machineId === "string") return item;
  if (typeof item.agentId !== "string") return item;
  return {
    ...item,
    machineId: item.agentId
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

const isStoredMachine = (value: unknown): value is StoredMachine => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredMachine>;
  return typeof item.machineId === "string"
    && typeof item.hostname === "string"
    && typeof item.lastSeenAt === "string";
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
