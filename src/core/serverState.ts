import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { createMachineId, normalizeMachineCapabilities, normalizeMachineType } from "./machineHub.js";
import type { MachineCapabilities, MachineSummary, MachineType } from "../shared/machineTypes.js";
import type {
  ProjectRelation,
  ProjectSource,
  ServerConfig,
  ProjectSummary,
  ServerStateData,
  ServerUiConfig,
  StoredMachine,
  StoredParentRegistration,
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
    const filePath = configFilePath(options);
    const result = await readConfigFileWithLegacyFallback(filePath, options);
    const state = new CodexhubServerState(filePath, result.data);
    const legacyStateFields = result.missingConfig
      || result.legacyThreads
      || result.legacyProjectNames
      || result.legacyProjectSessionIds
      || result.legacyRegisteredMachines;
    state.lastSavedText = result.path !== filePath ? "" : legacyStateFields ? result.rawText ?? "" : YAML.stringify(result.data);
    if (legacyStateFields || result.path !== filePath) await state.save();
    return state;
  }

  get path() {
    return this.filePath;
  }

  applyEnvToProcess(target: NodeJS.ProcessEnv = process.env) {
    for (const [key, value] of Object.entries(this.data.env)) {
      if (!(key in target)) target[key] = value;
    }
  }

  config() {
    return cloneServerConfig(this.data.config);
  }

  parentRegistration() {
    return this.data.parentRegistration ? { ...this.data.parentRegistration } : undefined;
  }

  setParentRegistration(input: Omit<StoredParentRegistration, "updatedAt"> & { updatedAt?: string }) {
    const registration: StoredParentRegistration = {
      ...input,
      updatedAt: input.updatedAt ?? new Date().toISOString()
    };
    this.data.parentRegistration = registration;
    this.touch();
    return { ...registration };
  }

  clearParentRegistration() {
    if (!this.data.parentRegistration) return false;
    delete this.data.parentRegistration;
    this.touch();
    return true;
  }

  updateUiConfig(input: Partial<ServerUiConfig>) {
    const nextUi = normalizeServerUiConfig({
      ...this.data.config.ui,
      ...input
    });
    if (this.data.config.ui.taskCompleteSystemNotifications !== nextUi.taskCompleteSystemNotifications) {
      this.data.config.ui = nextUi;
      this.touch();
    }
    return this.config();
  }

  listStoredMachines() {
    return [...this.data.machines].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  listStoredProjects() {
    return [...this.data.projects].sort(compareStoredProjects);
  }

  hasStoredProject(projectId: string) {
    return this.data.projects.some((project) => project.projectId === projectId);
  }

  deleteProject(projectId: string) {
    const index = this.data.projects.findIndex((project) => project.projectId === projectId);
    if (index === -1) return false;
    this.data.projects.splice(index, 1);
    this.touch();
    return true;
  }

  deleteTransientProject(projectId: string) {
    return this.transientProjects.delete(projectId);
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
    return this.transientProjects.has(projectId);
  }

  persistTransientProject(projectId: string, input: { pinned?: boolean | null } = {}) {
    const transient = this.transientProjects.get(projectId);
    if (!transient) return null;
    const project = this.upsertProject({
      machineId: transient.machineId,
      path: transient.path,
      relation: transient.relation,
      threadId: transient.lastThreadId,
      touchOpenedAt: false
    });
    if (!project) return null;
    if (input.pinned !== undefined && input.pinned !== null) {
      project.pinned = input.pinned;
      this.touch();
    }
    this.transientProjects.delete(projectId);
    return project;
  }

  projectTarget(projectId: string): Pick<StoredProject, "projectId" | "machineId" | "path"> | null {
    const project = this.data.projects.find((item) => item.projectId === projectId)
      ?? this.transientProjects.get(projectId);
    if (project) {
      return {
        projectId: project.projectId,
        machineId: project.machineId,
        path: project.path
      };
    }
    return null;
  }

  updateProject(projectId: string, input: { pinned?: boolean | null }) {
    const project = this.data.projects.find((item) => item.projectId === projectId);
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
    if (input.type === "registered") return;
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
    relation?: ProjectRelation;
    now?: string;
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
        lastOpenedAt: input.touchOpenedAt === false ? existing.lastOpenedAt : maxIso(existing.lastOpenedAt, now),
        lastThreadId: input.threadId ?? existing.lastThreadId,
        relation: input.relation ?? existing.relation
      };
      if (
        existing.lastOpenedAt === next.lastOpenedAt
        && existing.lastThreadId === next.lastThreadId
        && existing.relation === next.relation
      ) {
        return existing;
      }
      existing.lastOpenedAt = next.lastOpenedAt;
      existing.lastThreadId = next.lastThreadId;
      existing.relation = next.relation;
      this.touch();
      return existing;
    }
    const project: StoredProject = {
      projectId,
      machineId: input.machineId,
      path: normalizedPath,
      relation: input.relation,
      createdAt: now,
      lastOpenedAt: now,
      lastThreadId: input.threadId
    };
    this.data.projects.push(project);
    this.touch();
    return project;
  }

  upsertTransientProject(input: {
    machineId: string;
    path: string;
    relation?: ProjectRelation;
    now?: string;
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
      existing.lastThreadId = input.threadId ?? existing.lastThreadId;
      existing.relation = input.relation ?? existing.relation;
      existing.source = input.source ?? existing.source;
      return existing;
    }
    const project: RuntimeProject = {
      projectId,
      machineId: input.machineId,
      path: normalizedPath,
      relation: input.relation,
      createdAt: now,
      lastOpenedAt: now,
      lastThreadId: input.threadId,
      transient: true,
      source: input.source
    };
    this.transientProjects.set(projectId, project);
    return project;
  }

  captureSessions(snapshot: Pick<SessionSnapshot, "sessions" | "threads">, options: { persistMachines?: boolean } = {}) {
    if (options.persistMachines === false) return;
    for (const session of snapshot.sessions) {
      const machineId = machineIdForSession(session);
      // Machine registration is authoritative for durable machine metadata. In
      // particular, a dynamic registered machine must not be recreated here as
      // a default local machine after its registration was intentionally skipped.
      if (!this.data.machines.some((machine) => machine.machineId === machineId)) continue;
      this.upsertMachine({
        machineId,
        hostname: session.hostname ?? machineId,
        name: session.hostname,
        lastSeenAt: session.lastSeenAt,
        touchLastSeenAt: false,
        capabilities: session.machineId ? undefined : { projectLauncher: false }
      });
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
      const machine = machinesById.get(project.machineId);
      const machineOnline = Boolean(machine && "online" in machine && machine.online);
      return {
        ...project,
        name: projectName(project.path),
        machine,
        machineOnline,
        running: threads.some((thread) => thread.running || thread.status === "running")
      };
    });

    return {
      configPath: this.filePath,
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
        lastThreadId: overlay.lastThreadId ?? project.lastThreadId,
        relation: overlay.relation ?? project.relation,
        source: overlay.source
      };
    });
    const storedIds = new Set(stored.map((project) => project.projectId));
    const transient = [...this.transientProjects.values()].filter((project) => !storedIds.has(project.projectId));
    return [...stored, ...transient].sort(compareStoredProjects);
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
    await writeFile(tmpPath, text, { encoding: "utf8", mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, this.filePath);
    this.lastSavedText = text;
  }

  private async dataForSave(): Promise<ServerStateData> {
    const externalEnv = await readConfigEnv(this.filePath);
    if (externalEnv !== undefined) this.data.env = externalEnv;
    return this.data;
  }
}

export const machineIdForSession = (session: Pick<SessionSummary, "machineId" | "hostname">) =>
  session.machineId ?? createMachineId(session.hostname ?? "local");

const defaultDataDir = () =>
  path.resolve(process.env.CODEX_HUB_DATA_DIR ?? path.join(os.homedir(), ".config", "codexhub"));

const legacyDefaultDataDir = () =>
  path.resolve(path.join(os.homedir(), ".local", "share", "codexhub"));

const configFileName = "config.yaml";
const legacyStateFileName = "server-state.yaml";

const configFilePath = (options: { dataDir?: string; filePath?: string }) =>
  options.filePath
    ? path.resolve(options.filePath)
    : path.join(options.dataDir ? path.resolve(options.dataDir) : defaultDataDir(), configFileName);

const legacyConfigFilePaths = (options: { dataDir?: string; filePath?: string }, preferredPath: string) => {
  if (options.filePath) return [];
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : defaultDataDir();
  const paths = [path.join(dataDir, legacyStateFileName)];
  if (!options.dataDir && !process.env.CODEX_HUB_DATA_DIR) {
    paths.push(path.join(legacyDefaultDataDir(), legacyStateFileName));
  }
  return [...new Set(paths.map((item) => path.resolve(item)).filter((item) => item !== preferredPath))];
};

type StateFileReadResult = {
  found: boolean;
  path: string;
  data: ServerStateData;
  legacyThreads: boolean;
  legacyProjectNames: boolean;
  legacyProjectSessionIds: boolean;
  legacyRegisteredMachines: boolean;
  missingConfig: boolean;
  rawText?: string;
};

const readConfigFileWithLegacyFallback = async (
  preferredPath: string,
  options: { dataDir?: string; filePath?: string }
): Promise<StateFileReadResult> => {
  const preferred = await readStateFile(preferredPath);
  if (preferred.found) return preferred;
  for (const legacyPath of legacyConfigFilePaths(options, preferredPath)) {
    const legacy = await readStateFile(legacyPath);
    if (legacy.found) return legacy;
  }
  return preferred;
};

const readStateFile = async (filePath: string): Promise<StateFileReadResult> => {
  let rawText: string;
  try {
    rawText = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { found: false, path: filePath, data: emptyState(), legacyThreads: false, legacyProjectNames: false, legacyProjectSessionIds: false, legacyRegisteredMachines: false, missingConfig: false };
    }
    return { found: false, path: filePath, data: emptyState(), legacyThreads: false, legacyProjectNames: false, legacyProjectSessionIds: false, legacyRegisteredMachines: false, missingConfig: false };
  }

  try {
    const parsed = YAML.parse(rawText) as (Partial<ServerStateData> & { threads?: unknown }) | null;
    if (parsed?.version !== 1) return { found: true, path: filePath, data: emptyState(), legacyThreads: false, legacyProjectNames: false, legacyProjectSessionIds: false, legacyRegisteredMachines: false, missingConfig: false, rawText };
    const parsedMachines = Array.isArray(parsed.machines) ? parsed.machines : [];
    const normalizedMachines = parsedMachines.map(normalizeStoredMachine).filter(isStoredMachine);
    return {
      found: true,
      path: filePath,
      data: {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        config: normalizeServerConfig(parsed.config),
        env: normalizeStateEnv(parsed.env),
        parentRegistration: normalizeStoredParentRegistration(parsed.parentRegistration),
        machines: normalizedMachines.filter((machine) => machine.type !== "registered"),
        projects: Array.isArray(parsed.projects) ? parsed.projects.map(normalizeStoredProject).filter(isStoredProject) : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeStoredTask).filter(isStoredTask) : [],
        sshHosts: Array.isArray(parsed.sshHosts) ? parsed.sshHosts.map(normalizeStoredSshHost).filter(isStoredSshHost) : []
      },
      legacyThreads: Array.isArray(parsed.threads),
      legacyProjectNames: Array.isArray(parsed.projects)
        && parsed.projects.some((project) => Boolean(project && typeof project === "object" && !Array.isArray(project) && "name" in project)),
      legacyProjectSessionIds: Array.isArray(parsed.projects)
        && parsed.projects.some((project) => Boolean(project && typeof project === "object" && !Array.isArray(project) && "lastSessionId" in project)),
      legacyRegisteredMachines: normalizedMachines.some((machine) => machine.type === "registered"),
      missingConfig: !isCompleteServerConfig(parsed.config),
      rawText
    };
  } catch {
    return { found: true, path: filePath, data: emptyState(), legacyThreads: false, legacyProjectNames: false, legacyProjectSessionIds: false, legacyRegisteredMachines: false, missingConfig: false, rawText };
  }
};

const readConfigEnv = async (filePath: string): Promise<Record<string, string> | undefined> => {
  let rawText: string;
  try {
    rawText = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
  try {
    const parsed = YAML.parse(rawText) as Partial<ServerStateData> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return normalizeStateEnv(parsed.env);
  } catch {
    return undefined;
  }
};

const emptyState = (): ServerStateData => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  config: defaultServerConfig(),
  env: {},
  parentRegistration: undefined,
  machines: [],
  projects: [],
  tasks: [],
  sshHosts: []
});

const projectIdFor = (machineId: string, projectPath: string) =>
  `project-${createHash("sha256").update(`${machineId}\0${projectPath}`).digest("hex").slice(0, 16)}`;

const projectName = (projectPath: string) => path.basename(projectPath) || projectPath;

const defaultServerUiConfig = (): ServerUiConfig => ({
  taskCompleteSystemNotifications: false
});

const defaultServerConfig = (): ServerConfig => ({
  ui: defaultServerUiConfig()
});

const cloneServerConfig = (config: ServerConfig): ServerConfig => ({
  ui: { ...config.ui }
});

const normalizeServerConfig = (value: unknown): ServerConfig => {
  const record = objectRecord(value);
  return {
    ui: normalizeServerUiConfig(record?.ui)
  };
};

const normalizeServerUiConfig = (value: unknown): ServerUiConfig => {
  const record = objectRecord(value);
  return {
    taskCompleteSystemNotifications: typeof record?.taskCompleteSystemNotifications === "boolean"
      ? record.taskCompleteSystemNotifications
      : defaultServerUiConfig().taskCompleteSystemNotifications
  };
};

const isCompleteServerConfig = (value: unknown) => {
  const config = objectRecord(value);
  const ui = objectRecord(config?.ui);
  return typeof ui?.taskCompleteSystemNotifications === "boolean";
};

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const maxIso = (left: string, right: string) => left.localeCompare(right) >= 0 ? left : right;

const stateEnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const normalizeStateEnv = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!stateEnvNamePattern.test(key)) continue;
    if (typeof rawValue === "string") {
      env[key] = rawValue;
    } else if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      env[key] = String(rawValue);
    }
  }
  return env;
};

const normalizeStoredMachine = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  return {
    ...item,
    type: normalizeMachineType(item.type as MachineType | undefined),
    capabilities: normalizeMachineCapabilities(asMachineCapabilities(item.capabilities))
  };
};

const normalizeStoredParentRegistration = (value: unknown): StoredParentRegistration | undefined => {
  const item = objectRecord(value);
  if (!item) return undefined;
  const url = normalizedStoredUrl(item.url);
  const machineId = typeof item.machineId === "string" ? item.machineId.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!url) return undefined;
  const authToken = typeof item.authToken === "string" ? item.authToken.trim() : "";
  return {
    url,
    ...(authToken ? { authToken } : {}),
    ...(machineId ? { machineId } : {}),
    ...(name ? { name } : {}),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
  };
};

const normalizedStoredUrl = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    url.username = "";
    url.password = "";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
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
    relation: normalizeProjectRelation(item.relation),
    pinned: item.pinned,
    createdAt: item.createdAt,
    lastOpenedAt: item.lastOpenedAt,
    lastThreadId: item.lastThreadId
  };
};

const normalizeProjectRelation = (value: unknown): ProjectRelation | undefined => {
  const item = objectRecord(value);
  if (!item || item.type !== "worktree") return undefined;
  if (
    typeof item.parentProjectId !== "string"
    || typeof item.parentPath !== "string"
    || typeof item.branch !== "string"
  ) {
    return undefined;
  }
  return {
    type: "worktree",
    parentProjectId: item.parentProjectId,
    parentPath: item.parentPath,
    branch: item.branch,
    ...(typeof item.baseRef === "string" && item.baseRef ? { baseRef: item.baseRef } : {})
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
