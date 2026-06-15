import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { createMachineId, normalizeMachineCapabilities, normalizeMachineType } from "./machineHub.js";
import type { MachineCapabilities, MachineSummary, MachineType } from "../shared/machineTypes.js";
import type {
  DeletedProject,
  ProjectSource,
  ProjectSummary,
  ServerStateData,
  StoredMachine,
  StoredProject,
  StoredSshHost,
  StoredTask,
  StoredTaskRun,
  TaskRunStatus
} from "../shared/projectTypes.js";
import type { SessionSummary, ThreadSummary } from "../shared/threadTypes.js";

type RuntimeProject = StoredProject & {
  transient?: boolean;
  source?: ProjectSource;
};

type SessionSnapshot = {
  machines: MachineSummary[];
  sessions: SessionSummary[];
  threads: ThreadSummary[];
};

export class CodexhubServerState {
  private saveTimer: NodeJS.Timeout | null = null;
  private lastSavedText = "";
  private readonly transientProjects = new Map<string, RuntimeProject>();

  private constructor(
    readonly filePath: string,
    private data: ServerStateData
  ) {}

  static async load(options: { dataDir?: string; filePath?: string } = {}) {
    const filePath = options.filePath
      ? path.resolve(options.filePath)
      : path.join(options.dataDir ? path.resolve(options.dataDir) : defaultDataDir(), "server-state.yaml");
    const result = await readStateFile(filePath);
    const state = new CodexhubServerState(filePath, result.data);
    const legacyStateFields = result.legacyThreads || result.legacyProjectNames;
    state.lastSavedText = legacyStateFields ? result.rawText ?? "" : YAML.stringify(result.data);
    if (legacyStateFields) await state.save();
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

  hasStoredProject(projectId: string) {
    const resolvedProjectId = this.resolveProjectId(projectId);
    return this.data.projects.some((project) => project.projectId === resolvedProjectId);
  }

  deleteProject(projectId: string) {
    const resolvedProjectId = this.resolveProjectId(projectId);
    const index = this.data.projects.findIndex((project) => project.projectId === resolvedProjectId);
    if (index === -1 && this.data.deletedProjects.some((project) => project.projectId === resolvedProjectId)) return true;
    if (index === -1) return false;
    const [project] = this.data.projects.splice(index, 1);
    this.addDeletedProject(project);
    this.touch();
    return true;
  }

  deleteTransientProject(projectId: string) {
    const resolvedProjectId = this.resolveProjectId(projectId);
    return this.transientProjects.delete(resolvedProjectId);
  }

  deleteTransientProjectsForMachine(machineId: string) {
    let deleted = false;
    for (const [projectId, project] of this.transientProjects) {
      if (project.machineId !== machineId) continue;
      this.transientProjects.delete(projectId);
      deleted = true;
    }
    return deleted;
  }

  isTransientProject(projectId: string) {
    return this.transientProjects.has(this.resolveProjectId(projectId));
  }

  persistTransientProject(projectId: string, input: { pinned?: boolean | null } = {}) {
    const resolvedProjectId = this.resolveProjectId(projectId);
    const transient = this.transientProjects.get(resolvedProjectId);
    if (!transient) return null;
    const project = this.upsertProject({
      machineId: transient.machineId,
      path: transient.path,
      sessionId: transient.lastSessionId,
      threadId: transient.lastThreadId,
      touchOpenedAt: false
    });
    if (!project) return null;
    if (input.pinned !== undefined && input.pinned !== null) {
      project.pinned = input.pinned;
      this.touch();
    }
    this.transientProjects.delete(resolvedProjectId);
    return project;
  }

  projectDeleteTarget(projectId: string): Pick<StoredProject, "projectId" | "machineId" | "path"> | null {
    return this.projectTarget(projectId, true);
  }

  projectTarget(projectId: string, includeDeleted = false): Pick<StoredProject, "projectId" | "machineId" | "path"> | null {
    const resolvedProjectId = this.resolveProjectId(projectId);
    const project = this.data.projects.find((item) => item.projectId === resolvedProjectId);
    if (project) {
      return {
        projectId: project.projectId,
        machineId: project.machineId,
        path: project.path
      };
    }
    const deletedProject = includeDeleted
      ? this.data.deletedProjects.find((item) => item.projectId === resolvedProjectId)
      : undefined;
    if (deletedProject) {
      return {
        projectId: deletedProject.projectId,
        machineId: deletedProject.machineId,
        path: deletedProject.path
      };
    }
    const legacyProject = this.parseLegacyProjectId(projectId);
    return legacyProject
      ? {
        projectId: projectIdFor(legacyProject.machineId, legacyProject.path),
        machineId: legacyProject.machineId,
        path: legacyProject.path
      }
      : null;
  }

  updateProject(projectId: string, input: { pinned?: boolean | null }) {
    const resolvedProjectId = this.resolveProjectId(projectId);
    const project = this.data.projects.find((item) => item.projectId === resolvedProjectId);
    if (!project) return null;
    let changed = false;
    if (input.pinned !== undefined && input.pinned !== null && project.pinned !== input.pinned) {
      project.pinned = input.pinned;
      changed = true;
    }
    if (changed) this.touch();
    return project;
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
    lastDurationMs?: number;
  }) {
    const task = this.data.tasks.find((item) => item.taskId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.lastStatus = input.lastStatus;
    task.lastRunAt = input.lastRunAt ?? new Date().toISOString();
    task.threadId = input.threadId ?? task.threadId;
    task.lastError = input.lastError;
    task.lastDurationMs = input.lastDurationMs;
    task.updatedAt = new Date().toISOString();
    this.touch();
    return task;
  }

  startTaskRun(taskId: string, input: { runId: string; sessionId?: string; threadId?: string; startedAt?: string }) {
    const task = this.data.tasks.find((item) => item.taskId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const startedAt = input.startedAt ?? new Date().toISOString();
    const run: StoredTaskRun = {
      runId: input.runId,
      status: "queued",
      startedAt,
      sessionId: input.sessionId,
      threadId: input.threadId
    };
    task.runs = [run, ...(task.runs ?? []).filter((item) => item.runId !== input.runId)].slice(0, 20);
    task.lastStatus = "queued";
    task.lastRunAt = startedAt;
    task.lastError = undefined;
    task.lastDurationMs = undefined;
    task.threadId = input.threadId ?? task.threadId;
    task.updatedAt = startedAt;
    this.touch();
    return task;
  }

  finishTaskRun(taskId: string, runId: string, input: {
    status: Exclude<TaskRunStatus, "queued">;
    sessionId?: string;
    threadId?: string;
    error?: string;
    finishedAt?: string;
  }) {
    const task = this.data.tasks.find((item) => item.taskId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const finishedAt = input.finishedAt ?? new Date().toISOString();
    const runs = task.runs ?? [];
    let run = runs.find((item) => item.runId === runId);
    if (!run) {
      run = {
        runId,
        status: input.status,
        startedAt: task.lastRunAt ?? finishedAt
      };
      runs.unshift(run);
    }
    run.status = input.status;
    run.sessionId = input.sessionId ?? run.sessionId;
    run.threadId = input.threadId ?? run.threadId;
    run.error = input.error;
    run.finishedAt = finishedAt;
    const started = Date.parse(run.startedAt);
    const finished = Date.parse(finishedAt);
    run.durationMs = Number.isFinite(started) && Number.isFinite(finished)
      ? Math.max(0, finished - started)
      : undefined;
    task.runs = runs.slice(0, 20);
    task.lastStatus = input.status;
    task.lastRunAt = finishedAt;
    task.lastError = input.error;
    task.lastDurationMs = run.durationMs;
    task.threadId = input.threadId ?? task.threadId;
    task.updatedAt = finishedAt;
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
    now?: string;
    sessionId?: string;
    threadId?: string;
    touchOpenedAt?: boolean;
    restoreDeleted?: boolean;
  }) {
    const now = input.now ?? new Date().toISOString();
    const normalizedPath = input.path.trim();
    if (!normalizedPath) throw new Error("Project path is required.");
    const projectId = projectIdFor(input.machineId, normalizedPath);
    const deletedProjectIndex = this.data.deletedProjects.findIndex((project) => project.projectId === projectId);
    if (deletedProjectIndex !== -1 && input.restoreDeleted === false) return null;
    const deletedProjectRestored = deletedProjectIndex !== -1;
    if (deletedProjectIndex !== -1) this.data.deletedProjects.splice(deletedProjectIndex, 1);
    const existing = this.data.projects.find((project) => project.projectId === projectId);
    if (existing) {
      const next = {
        lastOpenedAt: input.touchOpenedAt === false ? existing.lastOpenedAt : maxIso(existing.lastOpenedAt, now),
        lastSessionId: input.sessionId ?? existing.lastSessionId,
        lastThreadId: input.threadId ?? existing.lastThreadId
      };
      if (
        existing.lastOpenedAt === next.lastOpenedAt
        && existing.lastSessionId === next.lastSessionId
        && existing.lastThreadId === next.lastThreadId
      ) {
        if (deletedProjectRestored) this.touch();
        return existing;
      }
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
      createdAt: now,
      lastOpenedAt: now,
      lastSessionId: input.sessionId,
      lastThreadId: input.threadId
    };
    this.data.projects.push(project);
    this.touch();
    return project;
  }

  upsertTransientProject(input: {
    machineId: string;
    path: string;
    now?: string;
    sessionId?: string;
    threadId?: string;
    source?: ProjectSource;
  }) {
    const now = input.now ?? new Date().toISOString();
    const normalizedPath = input.path.trim();
    if (!normalizedPath) throw new Error("Project path is required.");
    const projectId = projectIdFor(input.machineId, normalizedPath);
    const existing = this.transientProjects.get(projectId);
    if (existing) {
      existing.lastOpenedAt = maxIso(existing.lastOpenedAt, now);
      existing.lastSessionId = input.sessionId ?? existing.lastSessionId;
      existing.lastThreadId = input.threadId ?? existing.lastThreadId;
      existing.source = input.source ?? existing.source;
      return existing;
    }
    const project: RuntimeProject = {
      projectId,
      machineId: input.machineId,
      path: normalizedPath,
      createdAt: now,
      lastOpenedAt: now,
      lastSessionId: input.sessionId,
      lastThreadId: input.threadId,
      transient: true,
      source: input.source
    };
    this.transientProjects.set(projectId, project);
    return project;
  }

  captureSessions(snapshot: Pick<SessionSnapshot, "sessions" | "threads">) {
    for (const session of snapshot.sessions) {
      const machineId = machineIdForSession(session);
      this.upsertMachine({
        machineId,
        hostname: session.hostname ?? machineId,
        name: session.hostname,
        lastSeenAt: session.lastSeenAt,
        touchLastSeenAt: false,
        capabilities: session.machineId ? undefined : { projectLauncher: false }
      });
      if (this.findProject(machineId, session.workingDirectory)) {
        this.upsertProject({
          machineId,
          path: session.workingDirectory,
          sessionId: session.sessionId,
          now: session.lastSeenAt,
          touchOpenedAt: false,
          restoreDeleted: false
        });
      }
    }
  }

  snapshot(snapshot: SessionSnapshot) {
    const machinesById = new Map<string, MachineSummary | StoredMachine>();
    for (const machine of this.data.machines) machinesById.set(machine.machineId, machine);
    for (const machine of snapshot.machines) machinesById.set(machine.machineId, machine);
    const sessionsById = new Map(snapshot.sessions.map((session) => [session.sessionId, session]));
    const threadsByProject = new Map<string, ThreadSummary[]>();
    for (const thread of snapshot.threads) {
      const session = thread.session.sessionId
        ? sessionsById.get(thread.session.sessionId)
        : undefined;
      const project = session
        ? this.findRuntimeProject(machineIdForSession(session), thread.workingDirectory)
        : this.uniqueProjectForPath(thread.workingDirectory);
      if (!project) continue;
      const threads = threadsByProject.get(project.projectId) ?? [];
      threads.push(thread);
      threadsByProject.set(project.projectId, threads);
    }
    const projects: ProjectSummary[] = this.listRuntimeProjects().map((project) => {
      const threads = (threadsByProject.get(project.projectId) ?? [])
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const sessionIds = new Set<string>();
      if (project.lastSessionId) sessionIds.add(project.lastSessionId);
      for (const thread of threads) {
        if (thread.session.sessionId) sessionIds.add(thread.session.sessionId);
      }
      for (const session of snapshot.sessions) {
        if (machineIdForSession(session) !== project.machineId) continue;
        if (session.workingDirectory === project.path) sessionIds.add(session.sessionId);
      }
      const sessions = [...sessionIds]
        .map((sessionId) => sessionsById.get(sessionId))
        .filter((session): session is SessionSummary => Boolean(session))
        .map((session) => projectSessionSummary(session, project.path, threads))
        .sort((left, right) => Number(right.online) - Number(left.online) || right.lastSeenAt.localeCompare(left.lastSeenAt));
      const session = sessions.find((session) => session.online) ?? null;
      const machine = machinesById.get(project.machineId);
      const machineOnline = Boolean(machine && "online" in machine && machine.online);
      return {
        ...project,
        name: projectName(project.path),
        machine,
        machineOnline,
        session,
        online: Boolean(session) || machineOnline,
        running: threads.some((thread) => thread.running || thread.status === "running"),
        sessions,
        threads
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

  private findRuntimeProject(machineId: string, projectPath: string) {
    const projectId = projectIdFor(machineId, projectPath);
    return this.findProject(machineId, projectPath) ?? this.transientProjects.get(projectId);
  }

  private uniqueProjectForPath(projectPath: string) {
    const projects = this.listRuntimeProjects().filter((project) => project.path === projectPath);
    return projects.length === 1 ? projects[0] : null;
  }

  private listRuntimeProjects() {
    const transientById = new Map(this.transientProjects);
    const stored = this.listStoredProjects().map((project): RuntimeProject => {
      const overlay = transientById.get(project.projectId);
      if (!overlay) return project;
      return {
        ...project,
        lastOpenedAt: maxIso(project.lastOpenedAt, overlay.lastOpenedAt),
        lastSessionId: overlay.lastSessionId ?? project.lastSessionId,
        lastThreadId: overlay.lastThreadId ?? project.lastThreadId,
        source: overlay.source
      };
    });
    const storedIds = new Set(stored.map((project) => project.projectId));
    const transient = [...this.transientProjects.values()].filter((project) => !storedIds.has(project.projectId));
    return [...stored, ...transient].sort(compareStoredProjects);
  }

  private addDeletedProject(project: Pick<StoredProject, "projectId" | "machineId" | "path">) {
    const deletedAt = new Date().toISOString();
    const existing = this.data.deletedProjects.find((item) => item.projectId === project.projectId);
    if (existing) {
      existing.deletedAt = deletedAt;
      return;
    }
    this.data.deletedProjects.push({
      projectId: project.projectId,
      machineId: project.machineId,
      path: project.path,
      deletedAt
    });
  }

  private resolveProjectId(projectId: string) {
    if (projectId.startsWith("project-")) return projectId;
    const legacyProject = this.parseLegacyProjectId(projectId);
    return legacyProject ? projectIdFor(legacyProject.machineId, legacyProject.path) : projectId;
  }

  private parseLegacyProjectId(projectId: string) {
    const [machineId, projectPath, extra] = projectId.split("\0");
    if (!machineId || !projectPath || extra !== undefined) return null;
    return { machineId, path: projectPath };
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
    const data = await this.dataForSave();
    const text = YAML.stringify(data);
    if (text === this.lastSavedText) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, text, "utf8");
    await rename(tmpPath, this.filePath);
    this.lastSavedText = text;
  }

  private async dataForSave(): Promise<ServerStateData> {
    return this.data;
  }
}

export const machineIdForSession = (session: Pick<SessionSummary, "machineId" | "hostname">) =>
  session.machineId ?? createMachineId(session.hostname ?? "local");

const defaultDataDir = () =>
  path.resolve(process.env.CODEX_HUB_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "codexhub"));

type StateFileReadResult = {
  data: ServerStateData;
  legacyThreads: boolean;
  legacyProjectNames: boolean;
  rawText?: string;
};

const readStateFile = async (filePath: string): Promise<StateFileReadResult> => {
  try {
    const rawText = await readFile(filePath, "utf8");
    const parsed = YAML.parse(rawText) as (Partial<ServerStateData> & { threads?: unknown }) | null;
    if (parsed?.version !== 1) return { data: emptyState(), legacyThreads: false, legacyProjectNames: false, rawText };
    return {
      data: {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        machines: Array.isArray(parsed.machines) ? parsed.machines.map(normalizeStoredMachine).filter(isStoredMachine) : [],
        projects: Array.isArray(parsed.projects) ? parsed.projects.map(normalizeStoredProject).filter(isStoredProject) : [],
        deletedProjects: Array.isArray(parsed.deletedProjects) ? parsed.deletedProjects.filter(isDeletedProject) : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeStoredTask).filter(isStoredTask) : [],
        sshHosts: Array.isArray(parsed.sshHosts) ? parsed.sshHosts.map(normalizeStoredSshHost).filter(isStoredSshHost) : []
      },
      legacyThreads: Array.isArray(parsed.threads),
      legacyProjectNames: Array.isArray(parsed.projects)
        && parsed.projects.some((project) => Boolean(project && typeof project === "object" && !Array.isArray(project) && "name" in project)),
      rawText
    };
  } catch {
    return { data: emptyState(), legacyThreads: false, legacyProjectNames: false };
  }
};

const emptyState = (): ServerStateData => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  machines: [],
  projects: [],
  deletedProjects: [],
  tasks: [],
  sshHosts: []
});

const projectIdFor = (machineId: string, projectPath: string) =>
  `project-${createHash("sha256").update(`${machineId}\0${projectPath}`).digest("hex").slice(0, 16)}`;

const projectName = (projectPath: string) => path.basename(projectPath) || projectPath;

const projectSessionSummary = (
  session: SessionSummary,
  projectPath: string,
  threads: ThreadSummary[]
): SessionSummary => ({
  ...session,
  workingDirectory: projectPath,
  threads: threads.filter((thread) => thread.session.sessionId === session.sessionId)
});

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
    projectLauncher: typeof item.projectLauncher === "boolean" ? item.projectLauncher : undefined,
    projectCatalog: item.projectCatalog === "fixed" || item.projectCatalog === "editable" ? item.projectCatalog : undefined
  };
};

const machineCapabilitiesEqual = (left: MachineCapabilities, right: MachineCapabilities) =>
  left.projectLauncher === right.projectLauncher
  && left.projectCatalog === right.projectCatalog;

const normalizeStoredProject = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  return {
    projectId: item.projectId,
    machineId: item.machineId,
    path: item.path,
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
  const runs = Array.isArray(item.runs)
    ? item.runs.map(normalizeStoredTaskRun).filter(isStoredTaskRun).slice(0, 20)
    : [];
  return {
    ...item,
    projectPath,
    projectId: typeof item.projectId === "string" ? item.projectId : machineId && projectPath ? projectIdFor(machineId, projectPath) : undefined,
    runs
  };
};

const normalizeStoredTaskRun = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  return {
    runId: item.runId,
    status: item.status,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    durationMs: item.durationMs,
    sessionId: item.sessionId,
    threadId: item.threadId,
    error: item.error
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
  const nameCompare = projectName(left.path).localeCompare(projectName(right.path), undefined, { sensitivity: "base" });
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
    && typeof item.createdAt === "string"
    && typeof item.lastOpenedAt === "string";
};

const isDeletedProject = (value: unknown): value is DeletedProject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<DeletedProject>;
  return typeof item.projectId === "string"
    && typeof item.machineId === "string"
    && typeof item.path === "string"
    && typeof item.deletedAt === "string";
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
    && (item.lastError === undefined || typeof item.lastError === "string")
    && (item.lastDurationMs === undefined || typeof item.lastDurationMs === "number")
    && (item.runs === undefined || (Array.isArray(item.runs) && item.runs.every(isStoredTaskRun)));
};

const isStoredTaskRun = (value: unknown): value is StoredTaskRun => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredTaskRun>;
  return typeof item.runId === "string"
    && (item.status === "queued" || item.status === "completed" || item.status === "failed" || item.status === "skipped")
    && typeof item.startedAt === "string"
    && (item.finishedAt === undefined || typeof item.finishedAt === "string")
    && (item.durationMs === undefined || typeof item.durationMs === "number")
    && (item.sessionId === undefined || typeof item.sessionId === "string")
    && (item.threadId === undefined || typeof item.threadId === "string")
    && (item.error === undefined || typeof item.error === "string");
};

const isStoredSshHost = (value: unknown): value is StoredSshHost => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredSshHost>;
  return typeof item.alias === "string"
    && item.alias.trim().length > 0
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string";
};
